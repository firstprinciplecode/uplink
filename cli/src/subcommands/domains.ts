import { Command } from "commander";
import { handleError, printJson } from "../utils/machine";
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
import {
  checkDomainAvailability,
  formatPublicAvailability,
} from "../utils/domain-availability";
import { searchDomains } from "../utils/domain-search";
import { runDomainSearch } from "../tui/DomainSearch";

// DreamHost last: it can only confirm ownership, not quote availability.
const CHECK_ORDER: ProviderId[] = ["godaddy", "cloudflare", "hostinger", "namecheap", "dreamhost"];

function parseProvider(raw?: string): ProviderId | undefined {
  if (!raw) return undefined;
  const id = raw.toLowerCase();
  if (!isProviderId(id)) throw new Error(`Unknown provider: ${raw}`);
  return id;
}

async function credentialsFromFlags(
  provider: ProviderId,
  opts: { tokenEnv?: string; userEnv?: string; accountEnv?: string; json?: boolean }
): Promise<RegistrarCredentials> {
  const interactive = canPrompt() && !opts.json;

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

domainsCommand.action(async () => {
  const message = await runDomainSearch();
  if (message) console.log(message);
});

domainsCommand
  .command("list")
  .description("List domains owned at connected registrars")
  .option("--provider <id>", "Only this provider (godaddy|cloudflare|hostinger|namecheap|dreamhost)")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const provider = parseProvider(opts.provider);
      const domains = await listInventory(provider);
      if (opts.json) {
        printJson({ domains, count: domains.length });
        return;
      }
      if (domains.length === 0) {
        console.log("No domains. Connect a registrar: uplink domains providers connect godaddy");
        return;
      }
      for (const item of domains) {
        const expiry = item.expiresAt ? `  expires ${item.expiresAt}` : "";
        console.log(`- ${item.domain} (${item.provider}${expiry})`);
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
        const message = await runDomainSearch();
        if (message) console.log(message);
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

const providers = domainsCommand.command("providers").description("Connect registrar accounts");

providers
  .command("list")
  .description("Show which registrars are connected (never prints secrets)")
  .option("--json", "Output JSON", false)
  .action((opts) => {
    try {
      const store = readRegistrarStore();
      const items = adapters.map((adapter) => ({
        id: adapter.id,
        label: adapter.label,
        connected: Boolean(store[adapter.id]),
        help: adapter.connectHelp,
      }));
      if (opts.json) {
        printJson({ providers: items });
        return;
      }
      for (const item of items) {
        console.log(`- ${item.id}  ${item.connected ? "connected" : "not connected"}`);
        if (!item.connected) console.log(`    ${item.help}`);
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

providers
  .command("connect")
  .description("Save a registrar credential after a live check")
  .argument("<provider>", "godaddy | cloudflare | hostinger | namecheap | dreamhost")
  .option("--token-env <name>", "Env var holding the API token (comma-separate names for multiple keys)")
  .option("--user-env <name>", "Env var holding the Namecheap API user")
  .option("--account-env <name>", "Env var holding a Cloudflare account id (optional)")
  .option("--json", "Output JSON", false)
  .action(async (providerArg: string, opts) => {
    try {
      const provider = String(providerArg).toLowerCase();
      if (!isProviderId(provider)) {
        throw new Error(`Unknown provider: ${providerArg}. Use godaddy, cloudflare, hostinger, namecheap, or dreamhost`);
      }
      const adapter = getAdapter(provider);
      const creds = await credentialsFromFlags(provider, opts);
      const verified = await adapter.verify(creds);
      saveProvider(provider, verified);
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
  .description("Remove a saved registrar credential")
  .argument("<provider>", "godaddy | cloudflare | hostinger | namecheap | dreamhost")
  .option("--json", "Output JSON", false)
  .action((providerArg: string, opts) => {
    try {
      const provider = String(providerArg).toLowerCase();
      if (!isProviderId(provider)) throw new Error(`Unknown provider: ${providerArg}`);
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
