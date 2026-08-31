import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { RdapRegistration } from "./domain-availability";

/**
 * Registration status changes rarely, and registry RDAP lookups are slow in
 * bulk. Cache results for a day so `domains list --verify` (and the menu's
 * My domains view) is instant after the first check.
 */

const TTL_MS = 24 * 60 * 60 * 1000;

type CacheEntry = {
  registered: boolean | null;
  expiresAt?: string;
  detail?: string;
  checkedAt: number;
};

type CacheFile = Record<string, CacheEntry>;

function cachePath(): string {
  return join(homedir(), ".uplink", "rdap-cache.json");
}

function loadCache(): CacheFile {
  const path = cachePath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as CacheFile;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function cachedRegistrations(domains: string[]): Map<string, RdapRegistration> {
  const cache = loadCache();
  const now = Date.now();
  const out = new Map<string, RdapRegistration>();
  for (const domain of domains) {
    const entry = cache[domain];
    // Inconclusive results (registered === null) are never served from cache.
    if (!entry || entry.registered === null || now - entry.checkedAt > TTL_MS) continue;
    out.set(domain, {
      domain,
      registered: entry.registered,
      ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    });
  }
  return out;
}

export function storeRegistrations(results: Iterable<RdapRegistration>): void {
  const cache = loadCache();
  const now = Date.now();
  for (const result of results) {
    if (result.registered === null) continue;
    cache[result.domain] = {
      registered: result.registered,
      ...(result.expiresAt ? { expiresAt: result.expiresAt } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
      checkedAt: now,
    };
  }
  mkdirSync(join(homedir(), ".uplink"), { recursive: true });
  writeFileSync(cachePath(), JSON.stringify(cache, null, 2), { encoding: "utf8", mode: 0o600 });
  try {
    chmodSync(cachePath(), 0o600);
  } catch {
    /* ignore */
  }
}
