import { httpError, parseJson } from "./http";
import type { DomainQuote, InventoryDomain, RegistrarAdapter, RegistrarCredentials } from "./types";

const BASE = "https://developers.hostinger.com";

async function hostingerFetch(
  creds: RegistrarCredentials,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!creds.token) throw new Error("Hostinger token is missing");
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${creds.token}`,
      Accept: "application/json",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

function asList(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const obj = data as { data?: unknown; items?: unknown; domains?: unknown };
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.items)) return obj.items;
    if (Array.isArray(obj.domains)) return obj.domains;
  }
  return [];
}

function domainField(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const obj = item as { domain?: string; name?: string; domain_name?: string };
  return obj.domain || obj.name || obj.domain_name;
}

function splitDomain(fqdn: string): { label: string; tld: string } {
  const i = fqdn.indexOf(".");
  if (i <= 0) return { label: fqdn, tld: "com" };
  return { label: fqdn.slice(0, i), tld: fqdn.slice(i + 1) };
}

export const hostingerAdapter: RegistrarAdapter = {
  id: "hostinger",
  label: "Hostinger",
  connectHelp: "hPanel API token. --token-env HOSTINGER_API_TOKEN",
  async verify(creds) {
    const res = await hostingerFetch(creds, "/api/domains/v1/portfolio");
    if (!res.ok) throw httpError(res, await res.text());
    return creds;
  },
  async listDomains(creds) {
    const res = await hostingerFetch(creds, "/api/domains/v1/portfolio");
    if (!res.ok) throw httpError(res, await res.text());
    const data = await parseJson<unknown>(res);
    const out: InventoryDomain[] = [];
    for (const item of asList(data)) {
      const domain = domainField(item);
      if (!domain) continue;
      const expires =
        item && typeof item === "object"
          ? (item as { expires_at?: string; expiry_date?: string }).expires_at ||
            (item as { expiry_date?: string }).expiry_date
          : undefined;
      out.push({
        domain: domain.toLowerCase(),
        provider: "hostinger",
        status: "owned",
        expiresAt: expires,
      });
    }
    return out;
  },
  async check(creds, domain) {
    const { label, tld } = splitDomain(domain);
    const res = await hostingerFetch(creds, "/api/domains/v1/availability", {
      method: "POST",
      body: JSON.stringify({ domain: label, tlds: [tld], with_alternatives: false }),
    });
    if (!res.ok) throw httpError(res, await res.text());
    const data = await parseJson<unknown>(res);
    const rows = asList(data);
    const match =
      rows.find((row) => domainField(row)?.toLowerCase() === domain.toLowerCase()) || rows[0];
    const available =
      match && typeof match === "object"
        ? Boolean((match as { is_available?: boolean; available?: boolean }).is_available ??
            (match as { available?: boolean }).available)
        : false;
    if (available) {
      return { domain, provider: "hostinger", status: "available", buyable: true };
    }
    const restriction =
      match && typeof match === "object" ? (match as { restriction?: string }).restriction : undefined;
    return {
      domain,
      provider: "hostinger",
      status: restriction ? "not_for_sale" : "taken",
      buyable: false,
      error: restriction,
    };
  },
};
