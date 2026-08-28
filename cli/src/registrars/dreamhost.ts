import type { InventoryDomain, RegistrarAdapter, RegistrarCredentials } from "./types";

const BASE = "https://api.dreamhost.com/";
const NO_ACCESS = "this_key_cannot_access_this_cmd";

type DreamhostEnvelope = {
  result?: string;
  data?: unknown;
  reason?: string;
};

function keysOf(creds: RegistrarCredentials): string[] {
  const keys = [creds.apiKey || creds.token, ...(creds.extraTokens || [])];
  return [...new Set(keys.filter((key): key is string => Boolean(key)))];
}

async function dreamhostCmd(key: string, cmd: string): Promise<unknown> {
  const url = `${BASE}?key=${encodeURIComponent(key)}&cmd=${encodeURIComponent(cmd)}&format=json`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  const text = await res.text();
  let body: DreamhostEnvelope;
  try {
    body = text ? (JSON.parse(text) as DreamhostEnvelope) : {};
  } catch {
    throw new Error(`DreamHost returned a non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok || body.result !== "success") {
    const detail = body.reason || (typeof body.data === "string" ? body.data : "") || `HTTP ${res.status}`;
    throw new Error(`DreamHost ${cmd} failed: ${detail}`);
  }
  return body.data;
}

function rowsOf(data: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(data)) return [];
  return data.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object");
}

function domainOf(row: Record<string, unknown>): string | undefined {
  const value = row.domain ?? row.name ?? row.domain_name;
  return typeof value === "string" && value.includes(".") ? value.toLowerCase() : undefined;
}

function expiryOf(row: Record<string, unknown>): string | undefined {
  const value = row.expires ?? row.expiry ?? row.expiration_date;
  return typeof value === "string" && value ? value : undefined;
}

/**
 * DreamHost API keys are scoped per command. Panel keys with domain access can
 * list registrations; DNS-only keys can still reveal the account's domains via
 * dns-list_records zones, so each lookup falls through that chain.
 */
async function listForKey(key: string): Promise<InventoryDomain[]> {
  const out: InventoryDomain[] = [];
  const seen = new Set<string>();
  const push = (domain: string | undefined, expiresAt?: string) => {
    if (!domain || seen.has(domain)) return;
    seen.add(domain);
    out.push({ domain, provider: "dreamhost", status: "owned", expiresAt });
  };

  let lastError: Error | null = null;
  for (const cmd of ["domain-list_registrations", "domain-list_domains"]) {
    try {
      for (const row of rowsOf(await dreamhostCmd(key, cmd))) {
        push(domainOf(row), expiryOf(row));
      }
      if (out.length > 0) return out;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (!lastError.message.includes(NO_ACCESS)) throw lastError;
    }
  }

  try {
    for (const row of rowsOf(await dreamhostCmd(key, "dns-list_records"))) {
      const zone = row.zone;
      if (typeof zone === "string" && zone.includes(".")) push(zone.toLowerCase());
    }
    return out;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    throw lastError && err.message.includes(NO_ACCESS) ? lastError : err;
  }
}

export const dreamhostAdapter: RegistrarAdapter = {
  id: "dreamhost",
  label: "DreamHost",
  connectHelp:
    "Panel API key(s); DNS-scoped keys work too. --token-env DREAMHOST_API_KEY (comma-separate env names for multiple accounts)",
  async verify(creds) {
    const keys = keysOf(creds);
    if (keys.length === 0) throw new Error("DreamHost API key is missing");
    for (const key of keys) {
      await listForKey(key);
    }
    return creds;
  },
  async listDomains(creds) {
    const out: InventoryDomain[] = [];
    const seen = new Set<string>();
    const errors: string[] = [];
    for (const key of keysOf(creds)) {
      try {
        for (const item of await listForKey(key)) {
          if (seen.has(item.domain)) continue;
          seen.add(item.domain);
          out.push(item);
        }
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (out.length === 0 && errors.length > 0) throw new Error(errors.join("; "));
    return out.sort((a, b) => a.domain.localeCompare(b.domain));
  },
  async check(creds, domain) {
    // DreamHost has no availability API; it can only confirm ownership.
    // Throw for unowned domains so `domains check` falls through to a
    // provider that can quote (or the public DNS/RDAP fallback).
    const owned = await this.listDomains(creds);
    if (owned.some((item) => item.domain === domain.toLowerCase())) {
      return { domain, provider: "dreamhost", status: "owned", buyable: false };
    }
    throw new Error("DreamHost cannot check availability for domains outside the account");
  },
};
