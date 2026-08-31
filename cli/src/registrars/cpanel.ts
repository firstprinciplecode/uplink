import type { InventoryDomain, RegistrarAdapter, RegistrarCredentials } from "./types";

/**
 * cPanel is not a registrar, but it is where many people's sites actually
 * live (Namecheap shared, Bluehost, HostGator, A2, GoDaddy shared, …).
 * Connecting a cPanel account pulls its hosted domains into the same
 * inventory as registrar-owned domains, so Uplink can act as the hub for
 * domains and hosting scattered across providers.
 *
 * Auth: a cPanel API token (Security → Manage API Tokens in the panel),
 * sent as `Authorization: cpanel user:token` to the UAPI on port 2083.
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

function baseUrl(creds: RegistrarCredentials): string {
  const host = normalizeCpanelHost(creds.host || "");
  return host.includes(":") ? `https://${host}` : `https://${host}:2083`;
}

async function uapi(creds: RegistrarCredentials, module: string, fn: string): Promise<unknown> {
  const user = creds.apiUser || "";
  const token = creds.token || "";
  if (!user || !token) throw new Error("cPanel needs a username and an API token");
  const url = `${baseUrl(creds)}/execute/${module}/${fn}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `cpanel ${user}:${token}`,
        Accept: "application/json",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach cPanel at ${baseUrl(creds)} (${detail})`);
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("cPanel rejected the credentials (check username and API token)");
  }
  const text = await res.text();
  let body: UapiResponse;
  try {
    body = text ? (JSON.parse(text) as UapiResponse) : {};
  } catch {
    throw new Error(`cPanel returned a non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok || body.status !== 1) {
    const detail = body.errors?.filter(Boolean).join("; ") || `HTTP ${res.status}`;
    throw new Error(`cPanel ${module}/${fn} failed: ${detail}`);
  }
  return body.data;
}

function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.includes("."));
}

async function listHostedDomains(creds: RegistrarCredentials): Promise<InventoryDomain[]> {
  const data = (await uapi(creds, "DomainInfo", "list_domains")) as Record<string, unknown> | null;
  const out: InventoryDomain[] = [];
  const seen = new Set<string>();
  const push = (domain: string) => {
    const normalized = domain.toLowerCase();
    if (seen.has(normalized)) return;
    seen.add(normalized);
    out.push({ domain: normalized, provider: "cpanel", status: "owned" });
  };
  const main = data?.main_domain;
  if (typeof main === "string" && main.includes(".")) push(main);
  for (const domain of stringsOf(data?.addon_domains)) push(domain);
  for (const domain of stringsOf(data?.parked_domains)) push(domain);
  return out;
}

export const cpanelAdapter: RegistrarAdapter = {
  id: "cpanel",
  label: "cPanel hosting",
  connectHelp:
    "Any cPanel host (Namecheap shared, Bluehost, HostGator, …). --host server.example.com --user-env CPANEL_USER --token-env CPANEL_API_TOKEN (token: cPanel → Security → Manage API Tokens)",
  async verify(creds) {
    if (!creds.host) throw new Error("cPanel needs --host (e.g. server341.web-hosting.com)");
    creds.host = normalizeCpanelHost(creds.host);
    await listHostedDomains(creds);
    return creds;
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
      return { domain, provider: "cpanel", status: "owned", buyable: false };
    }
    throw new Error("cPanel only knows domains hosted on the connected account");
  },
};
