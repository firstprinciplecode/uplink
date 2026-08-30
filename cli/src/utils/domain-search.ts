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

const SEARCH_CONCURRENCY = 5;

export function normalizeDomainQuery(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "");
}

/** Bare label fans out across default TLDs. A dotted query is one exact name. */
export function expandDomainQuery(raw: string): string[] {
  const query = normalizeDomainQuery(raw);
  if (!query) return [];
  if (query.includes(".")) {
    const [label, ...rest] = query.split(".");
    const tld = rest.join(".");
    return label && tld ? [`${label}.${tld}`] : [];
  }
  return DEFAULT_TLDS.map((tld) => `${query}.${tld}`);
}

export async function searchDomains(raw: string): Promise<PublicAvailability[]> {
  const domains = expandDomainQuery(raw);
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
