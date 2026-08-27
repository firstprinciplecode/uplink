import { httpError } from "./http";
import type { DomainQuote, InventoryDomain, RegistrarAdapter, RegistrarCredentials } from "./types";

const BASE = "https://api.cloudflare.com/client/v4";

type CfEnvelope<T> = {
  success?: boolean;
  errors?: Array<{ message?: string }>;
  result?: T;
  result_info?: { cursor?: string };
};

async function cfFetch(
  creds: RegistrarCredentials,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  if (!creds.token) throw new Error("Cloudflare token is missing");
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

async function cfJson<T>(res: Response): Promise<CfEnvelope<T>> {
  const text = await res.text();
  let body: CfEnvelope<T>;
  try {
    body = text ? (JSON.parse(text) as CfEnvelope<T>) : {};
  } catch {
    throw httpError(res, text);
  }
  if (!res.ok || body.success === false) {
    const message = body.errors?.map((e) => e.message).filter(Boolean).join("; ") || text;
    throw httpError(res, message);
  }
  return body;
}

function pickUsd(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (value && typeof value === "object") {
    const obj = value as { amount?: unknown; value?: unknown; usd?: unknown };
    return pickUsd(obj.amount ?? obj.value ?? obj.usd);
  }
  return undefined;
}

export const cloudflareAdapter: RegistrarAdapter = {
  id: "cloudflare",
  label: "Cloudflare",
  connectHelp: "API token with account read. --token-env CF_API_TOKEN (optional --account-env CF_ACCOUNT_ID)",
  async verify(creds) {
    const res = await cfFetch(creds, "/accounts?per_page=1");
    const body = await cfJson<Array<{ id?: string }>>(res);
    const accountId = creds.accountId || body.result?.[0]?.id;
    if (!accountId) throw new Error("Cloudflare token has no accounts");
    return { ...creds, accountId };
  },
  async listDomains(creds) {
    const accountId = creds.accountId;
    if (!accountId) throw new Error("Cloudflare account id is missing");
    const out: InventoryDomain[] = [];

    const registrations = await cfFetch(creds, `/accounts/${accountId}/registrar/registrations`);
    if (registrations.ok) {
      const body = await cfJson<Array<{ domain_name?: string; expires_at?: string }>>(registrations);
      for (const item of body.result || []) {
        if (!item.domain_name) continue;
        out.push({
          domain: item.domain_name.toLowerCase(),
          provider: "cloudflare",
          status: "owned",
          expiresAt: item.expires_at,
        });
      }
    }

    if (out.length > 0) return out;

    const zones = await cfFetch(creds, "/zones?per_page=50");
    if (!zones.ok) {
      if (!registrations.ok) throw httpError(registrations, await registrations.text());
      return out;
    }
    const body = await cfJson<Array<{ name?: string }>>(zones);
    for (const zone of body.result || []) {
      if (!zone.name) continue;
      out.push({ domain: zone.name.toLowerCase(), provider: "cloudflare", status: "owned" });
    }
    return out;
  },
  async check(creds, domain) {
    const accountId = creds.accountId;
    if (!accountId) throw new Error("Cloudflare account id is missing");
    let res = await cfFetch(creds, `/accounts/${accountId}/registrar/domain-check`, {
      method: "POST",
      body: JSON.stringify({ domains: [domain] }),
    });
    if (res.status === 400) {
      res = await cfFetch(creds, `/accounts/${accountId}/registrar/domain-check`, {
        method: "POST",
        body: JSON.stringify({ domain_names: [domain] }),
      });
    }
    if (!res.ok) throw httpError(res, await res.text());
    const body = await cfJson<unknown>(res);
    const rows = Array.isArray(body.result) ? body.result : body.result ? [body.result] : [];
    const row = (rows[0] || {}) as {
      domain_name?: string;
      registrable?: boolean;
      available?: boolean;
      tier?: string;
      reason?: string;
      fees?: { registration?: unknown };
      prices?: { registration?: unknown };
      price?: unknown;
    };
    const available = row.registrable === true || row.available === true;
    const priceUsd = pickUsd(row.fees?.registration ?? row.prices?.registration ?? row.price);
    if (available) {
      return {
        domain,
        provider: "cloudflare",
        status: "available",
        buyable: row.tier !== "premium",
        premium: row.tier === "premium",
        priceUsd,
      };
    }
    return {
      domain,
      provider: "cloudflare",
      status: row.reason ? "not_for_sale" : "taken",
      buyable: false,
      error: row.reason,
    };
  },
};
