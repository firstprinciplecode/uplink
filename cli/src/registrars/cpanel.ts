import type {
  CpanelAccount,
  InventoryDomain,
  RegistrarAdapter,
  RegistrarCredentials,
} from "./types";

/**
 * cPanel is not a registrar, but it is where many people's sites actually
 * live (Namecheap shared, Bluehost, HostGator, A2, GoDaddy shared, …).
 * Connecting a cPanel account pulls its hosted domains into the same
 * inventory as registrar-owned domains, so Uplink can act as the hub for
 * domains and hosting scattered across providers.
 *
 * Auth: a cPanel API token (Security → Manage API Tokens in the panel),
 * sent as `Authorization: cpanel user:token` to the UAPI on port 2083.
 *
 * A user can connect several cPanel accounts (different hosts); each
 * `providers connect cpanel --host …` appends to `creds.accounts`.
 */

type UapiResponse = {
  status?: number;
  data?: unknown;
  errors?: string[] | null;
};

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+(:\d{2,5})?$/i;

export function normalizeCpanelHost(raw: string): string {
  const host = raw
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
  if (!HOST_RE.test(host)) {
    throw new Error(`Invalid cPanel host: ${raw}. Pass a hostname like server341.web-hosting.com`);
  }
  return host;
}

/** All connected cPanel accounts, including the legacy single-account shape. */
export function cpanelAccountsOf(creds: RegistrarCredentials): CpanelAccount[] {
  const accounts: CpanelAccount[] = [];
  const push = (account: { host?: string; apiUser?: string; token?: string }) => {
    if (!account.host || !account.apiUser || !account.token) return;
    const host = normalizeCpanelHost(account.host);
    if (accounts.some((a) => a.host === host && a.apiUser === account.apiUser)) return;
    accounts.push({ host, apiUser: account.apiUser, token: account.token });
  };
  for (const account of creds.accounts || []) push(account);
  push(creds);
  return accounts;
}

/** Merge a newly verified account into stored creds (replace same host+user). */
export function mergeCpanelCredentials(
  existing: RegistrarCredentials | undefined,
  incoming: RegistrarCredentials
): RegistrarCredentials {
  const merged: CpanelAccount[] = existing ? cpanelAccountsOf(existing) : [];
  for (const account of cpanelAccountsOf(incoming)) {
    const at = merged.findIndex((a) => a.host === account.host && a.apiUser === account.apiUser);
    if (at >= 0) merged[at] = account;
    else merged.push(account);
  }
  return { accounts: merged };
}

function baseUrl(host: string): string {
  return host.includes(":") ? `https://${host}` : `https://${host}:2083`;
}

async function uapi(account: CpanelAccount, module: string, fn: string): Promise<unknown> {
  const url = `${baseUrl(account.host)}/execute/${module}/${fn}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `cpanel ${account.apiUser}:${account.token}`,
        Accept: "application/json",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach cPanel at ${baseUrl(account.host)} (${detail})`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error(`cPanel at ${account.host} rejected the credentials (check username and API token)`);
  }
  const text = await res.text();
  let body: UapiResponse;
  try {
    body = text ? (JSON.parse(text) as UapiResponse) : {};
  } catch {
    throw new Error(`cPanel at ${account.host} returned a non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok || body.status !== 1) {
    const detail = body.errors?.filter(Boolean).join("; ") || `HTTP ${res.status}`;
    throw new Error(`cPanel ${module}/${fn} failed on ${account.host}: ${detail}`);
  }
  return body.data;
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.includes("."));
}

async function listAccountDomains(account: CpanelAccount): Promise<string[]> {
  const data = (await uapi(account, "DomainInfo", "list_domains")) as Record<string, unknown> | null;
  const out: string[] = [];
  const main = data?.main_domain;
  if (typeof main === "string" && main.includes(".")) out.push(main);
  out.push(...stringsOf(data?.addon_domains));
  out.push(...stringsOf(data?.parked_domains));
  return out;
}

async function listHostedDomains(creds: RegistrarCredentials): Promise<InventoryDomain[]> {
  const accounts = cpanelAccountsOf(creds);
  if (accounts.length === 0) throw new Error("cPanel needs a host, username, and API token");
  const out: InventoryDomain[] = [];
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const account of accounts) {
    try {
      for (const domain of await listAccountDomains(account)) {
        const normalized = domain.toLowerCase();
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        // "hosted": the panel serves this domain; it says nothing about
        // whether the registration is still owned.
        out.push({ domain: normalized, provider: "cpanel", status: "hosted" });
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (out.length === 0 && errors.length > 0) throw new Error(errors.join("; "));
  return out;
}

export const cpanelAdapter: RegistrarAdapter = {
  id: "cpanel",
  label: "cPanel hosting",
  connectHelp:
    "Any cPanel host (Namecheap shared, Bluehost, HostGator, …). --host server.example.com --user-env CPANEL_USER --token-env CPANEL_API_TOKEN (token: cPanel → Security → Manage API Tokens). Repeat with another --host to add more accounts.",
  async verify(creds) {
    // Verify only the incoming account(s); the connect flow merges them
    // into any previously stored accounts afterwards.
    const accounts = cpanelAccountsOf(creds);
    if (accounts.length === 0) {
      throw new Error("cPanel needs --host (e.g. server341.web-hosting.com), a username, and an API token");
    }
    for (const account of accounts) {
      await listAccountDomains(account);
    }
    return { accounts };
  },
  async listDomains(creds) {
    const domains = await listHostedDomains(creds);
    return domains.sort((a, b) => a.domain.localeCompare(b.domain));
  },
  async check(creds, domain) {
    // cPanel hosts sites; it has no availability API. Confirm hosted
    // domains, otherwise let the chain fall through to a registrar.
    const hosted = await listHostedDomains(creds);
    if (hosted.some((item) => item.domain === domain.toLowerCase())) {
      return { domain, provider: "cpanel", status: "taken", buyable: false };
    }
    throw new Error("cPanel only knows domains hosted on the connected accounts");
  },
};
