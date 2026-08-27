import { httpError, parseJson } from "./http";
import type { DomainQuote, InventoryDomain, RegistrarAdapter, RegistrarCredentials } from "./types";

const BASE = "https://api.godaddy.com";

async function godaddyFetch(
  creds: RegistrarCredentials,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!creds.token) throw new Error("GoDaddy token is missing");
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

function centsToUsd(value: number): number {
  return value / 100;
}

function microToUsd(value: number): number {
  return value / 1_000_000;
}

export const godaddyAdapter: RegistrarAdapter = {
  id: "godaddy",
  label: "GoDaddy",
  connectHelp: "Personal Access Token with domains.domain:read. --token-env GODADDY_PAT",
  async verify(creds) {
    const res = await godaddyFetch(creds, "/v1/domains?limit=1");
    if (!res.ok) throw httpError(res, await res.text());
    return creds;
  },
  async listDomains(creds) {
    const out: InventoryDomain[] = [];
    let marker: string | undefined;
    for (;;) {
      const params = new URLSearchParams({ limit: "100" });
      if (marker) params.set("marker", marker);
      const res = await godaddyFetch(creds, `/v1/domains?${params}`);
      if (!res.ok) throw httpError(res, await res.text());
      const batch = await parseJson<Array<{ domain?: string; expires?: string }>>(res);
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const item of batch) {
        if (!item.domain) continue;
        out.push({
          domain: item.domain.toLowerCase(),
          provider: "godaddy",
          status: "owned",
          expiresAt: item.expires,
        });
      }
      if (batch.length < 100) break;
      marker = batch[batch.length - 1]?.domain;
      if (!marker) break;
    }
    return out;
  },
  async check(creds, domain) {
    const v3 = await godaddyFetch(
      creds,
      `/v3/domains/check-availability?domain=${encodeURIComponent(domain)}`
    );
    if (v3.ok) {
      const data = await parseJson<{
        available?: boolean;
        prices?: Array<{ period?: number; price?: { value?: number } }>;
      }>(v3);
      const year1 = data.prices?.find((p) => p.period === 1) ?? data.prices?.[0];
      const priceUsd = year1?.price?.value != null ? centsToUsd(year1.price.value) : undefined;
      if (data.available) {
        return { domain, provider: "godaddy", status: "available", buyable: true, priceUsd };
      }
      return { domain, provider: "godaddy", status: "taken", buyable: false };
    }

    const v1 = await godaddyFetch(
      creds,
      `/v1/domains/available?domain=${encodeURIComponent(domain)}`
    );
    if (!v1.ok) throw httpError(v1, await v1.text());
    const data = await parseJson<{
      available?: boolean;
      price?: number;
      currency?: string;
    }>(v1);
    const priceUsd = data.price != null ? microToUsd(data.price) : undefined;
    if (data.available) {
      return { domain, provider: "godaddy", status: "available", buyable: true, priceUsd };
    }
    return { domain, provider: "godaddy", status: "taken", buyable: false };
  },
};
