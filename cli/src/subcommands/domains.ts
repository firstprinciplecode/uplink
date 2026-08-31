import { Command } from "commander";
import { join } from "path";
import { handleError, printJson } from "../utils/machine";
import { runEsmEntry } from "../utils/run-esm";
import {
  adapters,
  getAdapter,
  isProviderId,
  readRegistrarStore,
  removeProvider,
  saveProvider,
  type DomainQuote,
  type InventoryDomain,
  type ProviderId,
  type RegistrarCredentials,
} from "../registrars";
import { canPrompt, promptSecret, readEnvValue } from "../registrars/secret";
import { cpanelAccountsOf, mergeCpanelCredentials, normalizeCpanelHost } from "../registrars/cpanel";
import {
  checkDomainAvailability,
  formatPublicAvailability,
  rdapRegistration,
  type RdapRegistration,
} from "../utils/domain-availability";
import { searchDomains } from "../utils/domain-search";
import {
  createNamecheapAddFundsRequest,
  fetchNamecheapDomainContact,
  getNamecheapBalance,
  namecheapCartUrl,
  registerNamecheapDomain,
} from "../registrars/namecheap-purchase";
import {
  contactMissingFields,
  readRegistrantContact,
  writeRegistrantContact,
  type RegistrantContact,
} from "../utils/registrant-contact";
import { openInBrowser } from "../utils/open-browser";
import { promptLine } from "./menu/io";

function runDomainSearchTui(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("Domain search needs a terminal. Agents: uplink domains search myapp --json");
    return;
  }
  runEsmEntry(join(__dirname, "../tui/domain-search.mts"));
}

// DreamHost and cPanel last: they can only confirm ownership, not quote availability.
const CHECK_ORDER: ProviderId[] = ["godaddy", "cloudflare", "hostinger", "namecheap", "dreamhost", "cpanel"];

function parseProvider(raw?: string): ProviderId | undefined {
  if (!raw) return undefined;
  const id = raw.toLowerCase();
  if (!isProviderId(id)) throw new Error(`Unknown provider: ${raw}`);
  return id;
}

async function credentialsFromFlags(
  provider: ProviderId,
  opts: { tokenEnv?: string; userEnv?: string; accountEnv?: string; host?: string; json?: boolean }
): Promise<RegistrarCredentials> {
  const interactive = canPrompt() && !opts.json;

  if (provider === "cpanel") {
    const host = opts.host
      ? String(opts.host)
      : interactive
        ? (await promptLine("cPanel host (e.g. server341.web-hosting.com): ")).trim()
        : "";
    const apiUser = opts.userEnv
      ? readEnvValue(opts.userEnv)
      : interactive
        ? await promptSecret("cPanel username: ")
        : "";
    const token = opts.tokenEnv
      ? readEnvValue(opts.tokenEnv)
      : interactive
        ? await promptSecret("cPanel API token: ")
        : "";
    if (!host || !apiUser || !token) {
      throw new Error(
        "cPanel needs --host server.example.com --user-env CPANEL_USER --token-env CPANEL_API_TOKEN"
      );
    }
    return { host, apiUser, token };
  }

  if (provider === "namecheap") {
    const apiKey = opts.tokenEnv
      ? readEnvValue(opts.tokenEnv)
      : interactive
        ? await promptSecret("Namecheap API key: ")
        : "";
    const apiUser = opts.userEnv
      ? readEnvValue(opts.userEnv)
      : interactive
        ? await promptSecret("Namecheap API user: ")
        : "";
    if (!apiKey || !apiUser) {
      throw new Error(
        "Namecheap needs --token-env NAMECHEAP_API_KEY and --user-env NAMECHEAP_API_USER"
      );
    }
    return { apiKey, apiUser };
  }

  // --token-env accepts a comma-separated list of env names for providers
  // with multiple accounts (e.g. dreamhost).
  const envNames = (opts.tokenEnv || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  const tokens = envNames.length
    ? envNames.map((name) => readEnvValue(name))
    : interactive
      ? [await promptSecret(`${provider} API token: `)].filter(Boolean)
      : [];
  if (tokens.length === 0 || !tokens[0]) {
    throw new Error(`${provider} needs --token-env <VAR> (do not pass the secret on the command line)`);
  }
  const creds: RegistrarCredentials = { token: tokens[0] };
  if (tokens.length > 1) creds.extraTokens = tokens.slice(1);
  if (opts.accountEnv) creds.accountId = readEnvValue(opts.accountEnv);
  return creds;
}

/** Registrars report expiry in mixed formats (GoDaddy ISO, Namecheap MM/DD/YYYY). */
function parseExpiry(value?: string): Date | undefined {
  if (!value) return undefined;
  const mdy = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  const date = mdy ? new Date(`${mdy[3]}-${mdy[1]}-${mdy[2]}T00:00:00Z`) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** RDAP-check registration for domains whose source can't attest ownership. */
async function verifyRegistrations(domains: string[]): Promise<Map<string, RdapRegistration>> {
  const out = new Map<string, RdapRegistration>();
  const run = async (targets: string[], batchSize: number, pauseMs: number) => {
    for (let i = 0; i < targets.length; i += batchSize) {
      if (i > 0) await sleep(pauseMs);
      const results = await Promise.all(targets.slice(i, i + batchSize).map(rdapRegistration));
      for (const result of results) out.set(result.domain, result);
    }
  };
  await run([...new Set(domains)], 4, 400);
  // rdap.org rate-limits bursts; give inconclusive lookups one slower retry.
  const inconclusive = [...out.values()].filter((r) => r.registered === null).map((r) => r.domain);
  if (inconclusive.length > 0) {
    await sleep(2000);
    await run(inconclusive, 2, 1000);
  }
  return out;
}

function inventoryMarker(item: InventoryDomain, verified?: RdapRegistration): string {
  const now = new Date();
  if (verified) {
    if (verified.registered === false) return "NOT REGISTERED — lapsed";
    if (verified.registered === null) return `rdap inconclusive (${verified.detail})`;
    const expiry = parseExpiry(verified.expiresAt);
    if (expiry) {
      return expiry < now
        ? `registered · EXPIRED ${formatDay(expiry)} (rdap)`
        : `registered · expires ${formatDay(expiry)} (rdap)`;
    }
    return verified.detail ? `registered · ${verified.detail}` : "registered (rdap)";
  }
  const expiry = parseExpiry(item.expiresAt);
  if (expiry) {
    return expiry < now ? `EXPIRED ${formatDay(expiry)}` : `expires ${formatDay(expiry)}`;
  }
  return item.status === "hosted" ? "hosted (ownership unknown)" : "no expiry data";
}

async function listInventory(providerFilter?: ProviderId): Promise<InventoryDomain[]> {
  const store = readRegistrarStore();
  const ids = providerFilter ? [providerFilter] : CHECK_ORDER.filter((id) => store[id]);
  const domains: InventoryDomain[] = [];
  const errors: string[] = [];
  for (const id of ids) {
    const creds = store[id];
    if (!creds) {
      if (providerFilter) throw new Error(`${id} is not connected`);
      continue;
    }
    try {
      const listed = await getAdapter(id).listDomains(creds);
      domains.push(...listed);
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (domains.length === 0 && errors.length > 0) {
    throw new Error(errors.join("; "));
  }
  return domains.sort((a, b) => a.domain.localeCompare(b.domain));
}

async function quoteDomain(domain: string, providerFilter?: ProviderId): Promise<DomainQuote> {
  const store = readRegistrarStore();
  const ids = providerFilter
    ? [providerFilter]
    : CHECK_ORDER.filter((id) => store[id]);
  if (ids.length === 0) {
    throw new Error(
      "No registrar connected. Run: uplink domains providers connect godaddy --token-env GODADDY_PAT --json"
    );
  }

  let lastError: string | undefined;
  for (const id of ids) {
    const creds = store[id];
    if (!creds) throw new Error(`${id} is not connected`);
    try {
      return await getAdapter(id).check(creds, domain);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    domain,
    provider: ids[0],
    status: "unknown",
    error: lastError || "check failed",
  };
}

export const domainsCommand = new Command("domains").description(
  "Registrar inventory, availability, and search. Attach with `uplink host domains`."
);

domainsCommand.addHelpText(
  "after",
  "\nWith no subcommand, opens Find a domain (type a name; common TLDs are checked via DNS/RDAP).\n"
);

domainsCommand.action(() => {
  runDomainSearchTui();
});

domainsCommand
  .command("list")
  .description("Inventory across connected registrars and cPanel hosts, grouped by provider")
  .option("--provider <id>", "Only this provider (godaddy|cloudflare|hostinger|namecheap|dreamhost|cpanel)")
  .option("--verify", "RDAP-check registration for entries without expiry data (zones/hosted sites)", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const provider = parseProvider(opts.provider);
      const domains = await listInventory(provider);

      // Zones (DreamHost) and hosted sites (cPanel) carry no registration
      // data — a lapsed domain can linger there forever. --verify asks RDAP.
      let verified: Map<string, RdapRegistration> | undefined;
      if (opts.verify) {
        const unverifiable = domains.filter((item) => !parseExpiry(item.expiresAt));
        verified = await verifyRegistrations(unverifiable.map((item) => item.domain));
      }

      if (opts.json) {
        const enriched = domains.map((item) => {
          const check = verified?.get(item.domain);
          return check
            ? {
                ...item,
                registration: {
                  registered: check.registered,
                  ...(check.expiresAt ? { expiresAt: check.expiresAt } : {}),
                  ...(check.detail ? { detail: check.detail } : {}),
                },
              }
            : item;
        });
        printJson({ domains: enriched, count: enriched.length });
        return;
      }

      if (domains.length === 0) {
        console.log("No domains. Connect a registrar: uplink domains providers connect godaddy");
        return;
      }

      const byProvider = new Map<ProviderId, InventoryDomain[]>();
      for (const item of domains) {
        const group = byProvider.get(item.provider) || [];
        group.push(item);
        byProvider.set(item.provider, group);
      }
      for (const [id, items] of byProvider) {
        console.log(`${id} (${items.length})`);
        for (const item of items) {
          console.log(`  ${item.domain.padEnd(30)} ${inventoryMarker(item, verified?.get(item.domain))}`);
        }
        console.log("");
      }
      if (!opts.verify && domains.some((item) => !parseExpiry(item.expiresAt))) {
        console.log("Entries without expiry come from DNS zones / hosted sites, which don't include");
        console.log("registration data. Confirm each one: uplink domains list --verify");
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

domainsCommand
  .command("check")
  .description("Check domain availability (public DNS/RDAP; connected registrars add price)")
  .argument("<domain>", "Domain name (e.g. example.com)")
  .option("--provider <id>", "Which registrar to ask")
  .option("--json", "Output JSON", false)
  .action(async (domainArg: string, opts) => {
    try {
      const domain = String(domainArg).trim().toLowerCase();
      if (!domain.includes(".")) throw new Error("Pass a full domain like example.com");
      const provider = parseProvider(opts.provider);

      // No registrar connected: fall back to public DNS/RDAP availability.
      const store = readRegistrarStore();
      const hasRegistrar = provider ? Boolean(store[provider]) : CHECK_ORDER.some((id) => store[id]);
      if (!hasRegistrar) {
        const result = await checkDomainAvailability(domain);
        if (opts.json) {
          printJson({
            domain: result.domain,
            provider: "public",
            status: result.status,
            buyable: null,
            detail: result.detail,
            note: "Connect a registrar for price and purchase info.",
          });
          return;
        }
        console.log(formatPublicAvailability(result));
        return;
      }

      const quote = await quoteDomain(domain, provider);
      if (opts.json) {
        printJson(quote);
        return;
      }
      const price = quote.priceUsd != null ? `  $${quote.priceUsd.toFixed(2)}/yr` : "";
      const premium = quote.premium ? " premium" : "";
      console.log(`${quote.domain}  ${quote.status}${price}${premium}  [${quote.provider}]`);
      if (quote.error) console.log(`  ${quote.error}`);
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

domainsCommand
  .command("search")
  .description("Search a label across common TLDs, or check one exact domain")
  .argument("[name]", "Bare label (acme) or full domain (acme.io)")
  .option("--json", "Output JSON", false)
  .action(async (name: string | undefined, opts: { json?: boolean }) => {
    try {
      if (!name) {
        if (opts.json) throw new Error("Pass a name: uplink domains search acme --json");
        runDomainSearchTui();
        return;
      }
      const results = await searchDomains(name);
      if (opts.json) {
        printJson({
          query: name,
          results: results.map((item) => ({
            domain: item.domain,
            provider: "public",
            status: item.status,
            buyable: null,
            detail: item.detail,
          })),
        });
        return;
      }
      for (const item of results) {
        console.log(`${item.domain.padEnd(28)} ${item.status}`);
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

domainsCommand
  .command("buy")
  .description("Register a domain via Namecheap (charges account balance)")
  .argument("<domain>", "Domain to register (e.g. alchemy.photos)")
  .option("--years <n>", "Registration years", "1")
  .option("--yes", "Skip confirmation (required for non-interactive)", false)
  .option("--open-cart", "Open Namecheap browser cart instead of API purchase", false)
  .option("--json", "Output JSON", false)
  .action(async (domainArg: string, opts) => {
    try {
      const domain = String(domainArg).trim().toLowerCase();
      if (!domain.includes(".")) throw new Error("Pass a full domain like alchemy.photos");
      const years = Math.max(1, Number(opts.years) || 1);

      if (opts.openCart) {
        const url = namecheapCartUrl(domain, years);
        if (opts.json) {
          printJson({ domain, url, mode: "cart" });
          return;
        }
        console.log(url);
        openInBrowser(url);
        return;
      }

      const store = readRegistrarStore();
      const creds = store.namecheap;
      if (!creds) throw new Error("Connect Namecheap first: uplink domains providers connect namecheap");

      const quote = await getAdapter("namecheap").check(creds, domain);
      if (!quote.buyable || quote.status !== "available") {
        throw new Error(`${domain} is not available on Namecheap (${quote.status})`);
      }

      let contact = readRegistrantContact();
      if (!contact || contactMissingFields(contact).length) {
        const owned = await getAdapter("namecheap").listDomains(creds);
        for (const item of owned.slice(0, 5)) {
          const seeded = await fetchNamecheapDomainContact(creds, item.domain);
          if (seeded && contactMissingFields(seeded).length === 0) {
            writeRegistrantContact(seeded);
            contact = seeded;
            break;
          }
        }
      }
      if (!contact || contactMissingFields(contact).length) {
        throw new Error(
          "Registrant contact missing. Run: uplink domains contact set  (or buy once you own another Namecheap domain so we can copy WHOIS)"
        );
      }

      const balance = await getNamecheapBalance(creds);
      const price = quote.priceUsd ?? 0;
      if (balance.available + 0.001 < price) {
        const need = Math.max(10, Math.ceil(price - balance.available + 1));
        const funds = await createNamecheapAddFundsRequest(creds, need);
        if (opts.json) {
          printJson({
            domain,
            error: "INSUFFICIENT_BALANCE",
            priceUsd: price,
            balanceUsd: balance.available,
            addFundsUrl: funds.redirectUrl,
            amount: funds.amount,
            cartUrl: namecheapCartUrl(domain, years),
          });
          return;
        }
        console.log(
          `Insufficient Namecheap balance (need ~$${price.toFixed(2)}, have $${balance.available.toFixed(2)}).`
        );
        console.log(`Add funds: ${funds.redirectUrl}`);
        console.log(`Or browser cart: ${namecheapCartUrl(domain, years)}`);
        openInBrowser(funds.redirectUrl);
        process.exitCode = 30;
        return;
      }

      if (!opts.yes) {
        if (!canPrompt()) throw new Error("Pass --yes to buy non-interactively");
        const answer = (await promptLine(`Buy ${domain} for ~$${price.toFixed(2)}/${years}yr? [y/N] `))
          .trim()
          .toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          if (opts.json) printJson({ domain, cancelled: true });
          else console.log("Cancelled");
          return;
        }
      }

      const result = await registerNamecheapDomain(creds, {
        domain,
        years,
        contact,
        premium: quote.premium,
        premiumPrice: quote.premium ? quote.priceUsd : undefined,
      });
      if (opts.json) {
        printJson({ ...result, priceUsd: price, provider: "namecheap" });
        return;
      }
      console.log(
        result.registered
          ? `Registered ${result.domain}${result.chargedAmount != null ? ` · charged $${result.chargedAmount.toFixed(2)}` : ""}`
          : `Namecheap returned registered=false for ${result.domain}`
      );
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

domainsCommand
  .command("fund")
  .description("Open a Namecheap add-funds payment page (account balance for API purchases)")
  .option("--amount <usd>", "Amount to add (min $5)", "20")
  .option("--json", "Output JSON (does not open a browser)", false)
  .action(async (opts) => {
    try {
      const store = readRegistrarStore();
      const creds = store.namecheap;
      if (!creds) throw new Error("Connect Namecheap first: uplink domains providers connect namecheap");
      const amount = Number(opts.amount);
      const funds = await createNamecheapAddFundsRequest(creds, amount);
      const balance = await getNamecheapBalance(creds).catch(() => null);
      if (opts.json) {
        printJson({
          amount: funds.amount,
          redirectUrl: funds.redirectUrl,
          tokenId: funds.tokenId,
          balanceUsd: balance?.available,
        });
        return;
      }
      console.log(`Namecheap payment page (add $${funds.amount.toFixed(2)}):`);
      console.log(funds.redirectUrl);
      if (balance) console.log(`Current balance: $${balance.available.toFixed(2)} ${balance.currency}`);
      openInBrowser(funds.redirectUrl);
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

const contactCmd = domainsCommand.command("contact").description("Registrant WHOIS profile for Namecheap purchases");

contactCmd
  .command("show")
  .description("Show saved registrant contact (no secrets beyond WHOIS fields)")
  .option("--json", "Output JSON", false)
  .action((opts) => {
    try {
      const contact = readRegistrantContact();
      if (opts.json) {
        printJson({ contact, missing: contactMissingFields(contact) });
        return;
      }
      if (!contact) {
        console.log("No registrant profile. Run: uplink domains contact set");
        return;
      }
      console.log(`${contact.firstName} ${contact.lastName}  <${contact.email}>`);
      console.log(`${contact.address1}`);
      console.log(`${contact.city}, ${contact.stateProvince} ${contact.postalCode}  ${contact.country}`);
      console.log(contact.phone);
      const missing = contactMissingFields(contact);
      if (missing.length) console.log(`Missing: ${missing.join(", ")}`);
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

contactCmd
  .command("set")
  .description("Save registrant contact used for Namecheap domains.create")
  .option("--first-name <v>", "First name")
  .option("--last-name <v>", "Last name")
  .option("--address1 <v>", "Street address")
  .option("--city <v>", "City")
  .option("--state <v>", "State / province")
  .option("--postal <v>", "Postal code")
  .option("--country <v>", "Country code (e.g. US)")
  .option("--phone <v>", "Phone in +1.5555555555 form")
  .option("--email <v>", "Email")
  .option("--org <v>", "Organization (optional)")
  .option("--from-domain <domain>", "Copy WHOIS from an owned Namecheap domain")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      let contact: RegistrantContact | null = readRegistrantContact();

      if (opts.fromDomain) {
        const store = readRegistrarStore();
        const creds = store.namecheap;
        if (!creds) throw new Error("Connect Namecheap first");
        contact = await fetchNamecheapDomainContact(creds, String(opts.fromDomain).toLowerCase());
        if (!contact) throw new Error(`No contacts returned for ${opts.fromDomain}`);
      }

      const ask = async (label: string, current?: string, flag?: string) => {
        if (flag) return flag;
        if (!canPrompt() || opts.json) return current || "";
        const answer = (await promptLine(`${label}${current ? ` [${current}]` : ""}: `)).trim();
        return answer || current || "";
      };

      contact = {
        firstName: await ask("First name", contact?.firstName, opts.firstName),
        lastName: await ask("Last name", contact?.lastName, opts.lastName),
        address1: await ask("Address", contact?.address1, opts.address1),
        city: await ask("City", contact?.city, opts.city),
        stateProvince: await ask("State/province", contact?.stateProvince, opts.state),
        postalCode: await ask("Postal code", contact?.postalCode, opts.postal),
        country: await ask("Country (US)", contact?.country || "US", opts.country),
        phone: await ask("Phone (+1.5555555555)", contact?.phone, opts.phone),
        email: await ask("Email", contact?.email, opts.email),
        organizationName: (await ask("Organization (optional)", contact?.organizationName, opts.org)) || undefined,
      };

      const missing = contactMissingFields(contact);
      if (missing.length) throw new Error(`Missing required fields: ${missing.join(", ")}`);
      writeRegistrantContact(contact);
      if (opts.json) {
        printJson({ saved: true, contact });
        return;
      }
      console.log("Saved registrant profile to ~/.uplink/registrant.json");
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

contactCmd
  .command("seed")
  .description("Copy registrant contact from the first owned Namecheap domain")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const store = readRegistrarStore();
      const creds = store.namecheap;
      if (!creds) throw new Error("Connect Namecheap first");
      const owned = await getAdapter("namecheap").listDomains(creds);
      if (owned.length === 0) throw new Error("No owned Namecheap domains to copy from");
      let contact: RegistrantContact | null = null;
      let source = "";
      for (const item of owned) {
        contact = await fetchNamecheapDomainContact(creds, item.domain);
        if (contact && contactMissingFields(contact).length === 0) {
          source = item.domain;
          break;
        }
      }
      if (!contact || contactMissingFields(contact).length) {
        throw new Error("Could not read a complete contact from owned domains");
      }
      writeRegistrantContact(contact);
      if (opts.json) {
        printJson({ saved: true, source, contact });
        return;
      }
      console.log(`Saved registrant profile from ${source}`);
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

const providers = domainsCommand.command("providers").description("Connect registrar accounts");

providers
  .command("list")
  .description("Show which registrars are connected (never prints secrets)")
  .option("--json", "Output JSON", false)
  .action((opts) => {
    try {
      const store = readRegistrarStore();
      const items = adapters.map((adapter) => {
        const creds = store[adapter.id];
        const cpanelHosts =
          adapter.id === "cpanel" && creds ? cpanelAccountsOf(creds).map((a) => a.host) : undefined;
        return {
          id: adapter.id,
          label: adapter.label,
          connected: Boolean(creds),
          ...(cpanelHosts ? { hosts: cpanelHosts } : {}),
          help: adapter.connectHelp,
        };
      });
      if (opts.json) {
        printJson({ providers: items });
        return;
      }
      for (const item of items) {
        const hosts = item.hosts?.length ? ` (${item.hosts.join(", ")})` : "";
        console.log(`- ${item.id}  ${item.connected ? `connected${hosts}` : "not connected"}`);
        if (!item.connected) console.log(`    ${item.help}`);
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

providers
  .command("connect")
  .description("Save a registrar or cPanel credential after a live check")
  .argument("<provider>", "godaddy | cloudflare | hostinger | namecheap | dreamhost | cpanel")
  .option("--token-env <name>", "Env var holding the API token (comma-separate names for multiple keys)")
  .option("--user-env <name>", "Env var holding the Namecheap API user or cPanel username")
  .option("--account-env <name>", "Env var holding a Cloudflare account id (optional)")
  .option("--host <hostname>", "cPanel server hostname (e.g. server341.web-hosting.com)")
  .option("--json", "Output JSON", false)
  .action(async (providerArg: string, opts) => {
    try {
      const provider = String(providerArg).toLowerCase();
      if (!isProviderId(provider)) {
        throw new Error(`Unknown provider: ${providerArg}. Use godaddy, cloudflare, hostinger, namecheap, dreamhost, or cpanel`);
      }
      const adapter = getAdapter(provider);
      const creds = await credentialsFromFlags(provider, opts);
      const verified = await adapter.verify(creds);
      // cPanel accumulates accounts (people have sites on several hosts);
      // other providers replace the stored credential.
      const toSave =
        provider === "cpanel"
          ? mergeCpanelCredentials(readRegistrarStore().cpanel, verified)
          : verified;
      saveProvider(provider, toSave);
      const listed = await adapter.listDomains(verified).catch(() => [] as InventoryDomain[]);
      if (opts.json) {
        printJson({
          provider,
          connected: true,
          domains: listed.length,
        });
        return;
      }
      console.log(`Connected ${adapter.label} (${listed.length} domain${listed.length === 1 ? "" : "s"})`);
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

providers
  .command("disconnect")
  .description("Remove a saved registrar or cPanel credential")
  .argument("<provider>", "godaddy | cloudflare | hostinger | namecheap | dreamhost | cpanel")
  .option("--host <hostname>", "cPanel only: remove just this host's account")
  .option("--json", "Output JSON", false)
  .action((providerArg: string, opts) => {
    try {
      const provider = String(providerArg).toLowerCase();
      if (!isProviderId(provider)) throw new Error(`Unknown provider: ${providerArg}`);

      if (provider === "cpanel" && opts.host) {
        const host = normalizeCpanelHost(String(opts.host));
        const existing = readRegistrarStore().cpanel;
        const accounts = existing ? cpanelAccountsOf(existing).filter((a) => a.host !== host) : [];
        const removed = existing ? cpanelAccountsOf(existing).length !== accounts.length : false;
        if (accounts.length === 0) removeProvider(provider);
        else saveProvider(provider, { accounts });
        if (opts.json) {
          printJson({ provider, host, removed, remainingAccounts: accounts.length });
          return;
        }
        console.log(removed ? `Removed cPanel account on ${host}` : `No cPanel account on ${host}`);
        return;
      }

      const removed = removeProvider(provider);
      if (opts.json) {
        printJson({ provider, connected: false, removed });
        return;
      }
      console.log(removed ? `Disconnected ${provider}` : `${provider} was not connected`);
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });
