import { checkDomainAvailability, type PublicAvailability } from "./domain-availability";
import { fetchRelatedWords } from "./related-words";

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
  "inc",
  "me",
  "gg",
  "tech",
  "cloud",
  "studio",
  "tools",
  "fyi",
  "world",
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
const RELATED_CLI_WORD_CAP = 12;

export type DomainFindQuery =
  | { mode: "empty" }
  | { mode: "related"; word: string; tld?: string }
  | { mode: "browse"; tld: string }
  | { mode: "exact"; domain: string }
  | { mode: "label"; label: string };

export function normalizeDomainQuery(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]/g, "");
}

/**
 * Query modes (same as DomainKing):
 * - `~space` / `~space.inc` — related words (Datamuse), then scan
 * - `.inc` — browse a TLD (dictionary scan; interactive)
 * - `creatures.inc` — one exact domain
 * - `acme` — fan out across default TLDs
 */
export function parseDomainFindQuery(raw: string): DomainFindQuery {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return { mode: "empty" };

  const related = /^~([a-z]{3,})(?:\.([a-z0-9]{2,}))?$/.exec(trimmed);
  if (related) {
    return related[2]
      ? { mode: "related", word: related[1], tld: related[2] }
      : { mode: "related", word: related[1] };
  }

  const normalized = normalizeDomainQuery(raw);
  if (!normalized) return { mode: "empty" };

  const browse = /^\.([a-z0-9]{2,})$/.exec(normalized);
  if (browse) return { mode: "browse", tld: browse[1] };

  if (normalized.includes(".")) {
    const [label, ...rest] = normalized.split(".");
    const tld = rest.join(".");
    if (label && tld) return { mode: "exact", domain: `${label}.${tld}` };
    return { mode: "empty" };
  }

  return { mode: "label", label: normalized };
}

/** Bare label fans out across TLDs. Dotted query is one exact name. `~` / `.tld` do not expand here. */
export function expandDomainQuery(raw: string, set: SearchTldSet = "default"): string[] {
  const parsed = parseDomainFindQuery(raw);
  if (parsed.mode === "exact") return [parsed.domain];
  if (parsed.mode === "label") return tldsForSet(set).map((tld) => `${parsed.label}.${tld}`);
  return [];
}

async function checkMany(domains: string[]): Promise<PublicAvailability[]> {
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

export async function searchDomains(
  raw: string,
  set: SearchTldSet = "default"
): Promise<PublicAvailability[]> {
  const parsed = parseDomainFindQuery(raw);
  if (parsed.mode === "browse") {
    throw new Error(
      `TLD browse (.${parsed.tld}) is interactive. Run \`uplink domains search\` in a terminal, then type .${parsed.tld}`
    );
  }
  if (parsed.mode === "related") {
    const words = (await fetchRelatedWords(parsed.word)).slice(0, RELATED_CLI_WORD_CAP);
    const tlds = parsed.tld ? [parsed.tld] : tldsForSet(set);
    const domains = words.flatMap((word) => tlds.map((tld) => `${word}.${tld}`));
    return checkMany(domains);
  }
  const domains = expandDomainQuery(raw, set);
  return checkMany(domains);
}
