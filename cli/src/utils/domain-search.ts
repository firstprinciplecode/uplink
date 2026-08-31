import { checkDomainAvailability, type PublicAvailability } from "./domain-availability";

export const DEFAULT_TLDS = [
  "com",
  "net",
  "org",
  "io",
  "co",
  "ai",
  "dev",
  "app",
  "sh",
  "xyz",
  "me",
  "gg",
  "tech",
  "cloud",
];

/** Extra TLDs behind Find a domain `m` / `domains search --more`. */
export const MORE_TLDS = [
  "info",
  "biz",
  "online",
  "site",
  "store",
  "shop",
  "pro",
  "tv",
  "cc",
  "us",
  "uk",
  "de",
  "nl",
  "eu",
  "in",
  "ca",
  "au",
  "studio",
  "digital",
  "agency",
  "design",
  "space",
  "live",
  "club",
  "email",
  "page",
  "company",
  "blog",
  "fyi",
  "fm",
  "id",
  "to",
  "vc",
];

export type SearchTldSet = "default" | "more";

export function tldsForSet(set: SearchTldSet): string[] {
  if (set === "more") return [...DEFAULT_TLDS, ...MORE_TLDS];
  return [...DEFAULT_TLDS];
}

const SEARCH_CONCURRENCY = 5;

export function normalizeDomainQuery(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "");
}

/** Bare label fans out across default (or default+more) TLDs. A dotted query is one exact name. */
export function expandDomainQuery(raw: string, set: SearchTldSet = "default"): string[] {
  const query = normalizeDomainQuery(raw);
  if (!query) return [];
  if (query.includes(".")) {
    const [label, ...rest] = query.split(".");
    const tld = rest.join(".");
    return label && tld ? [`${label}.${tld}`] : [];
  }
  return tldsForSet(set).map((tld) => `${query}.${tld}`);
}

export async function searchDomains(
  raw: string,
  set: SearchTldSet = "default"
): Promise<PublicAvailability[]> {
  const domains = expandDomainQuery(raw, set);
  const results = new Map<string, PublicAvailability>();
  let index = 0;

  async function worker() {
    while (index < domains.length) {
      const domain = domains[index++];
      results.set(domain, await checkDomainAvailability(domain));
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(SEARCH_CONCURRENCY, domains.length) }, () => worker())
  );
  return domains.map((domain) => results.get(domain)!);
}
