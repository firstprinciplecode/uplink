import { promises as dns } from "dns";
import fetch from "node-fetch";

export type PublicAvailability = {
  domain: string;
  status: "available" | "taken" | "unknown";
  source: "dns" | "rdap";
  detail: string;
};

const RDAP_TIMEOUT_MS = 8000;

/**
 * Registrar-free availability check: DNS nameservers first (fast, definitive
 * for registered domains), then RDAP for the authoritative registration record.
 * Price and purchase still require a connected registrar.
 */
export async function checkDomainAvailability(domain: string): Promise<PublicAvailability> {
  try {
    const nameservers = await dns.resolveNs(domain);
    if (nameservers.length > 0) {
      return { domain, status: "taken", source: "dns", detail: "domain has nameservers" };
    }
  } catch {
    // NXDOMAIN or no NS records — RDAP decides.
  }

  let lastFailure = "RDAP unreachable";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetch(`https://rdap.org/domain/${encodeURIComponent(domain)}`, {
        headers: { accept: "application/rdap+json" },
        timeout: RDAP_TIMEOUT_MS,
      });
      if (response.status === 404) {
        return { domain, status: "available", source: "rdap", detail: "no registration record" };
      }
      if (response.ok) {
        return { domain, status: "taken", source: "rdap", detail: "registration record exists" };
      }
      lastFailure = `RDAP returned ${response.status}`;
    } catch (error) {
      lastFailure = error instanceof Error ? error.message : String(error);
    }
  }
  return { domain, status: "unknown", source: "rdap", detail: lastFailure };
}

export type RdapRegistration = {
  domain: string;
  /** null = RDAP unreachable / inconclusive. */
  registered: boolean | null;
  expiresAt?: string;
  detail?: string;
};

/**
 * IANA RDAP bootstrap: maps a TLD to its authoritative registry RDAP base.
 * Querying registries directly avoids the rdap.org aggregator's tight rate
 * limits when verifying many domains.
 */
let rdapBootstrap: Map<string, string> | null = null;

async function rdapBaseFor(domain: string): Promise<string> {
  const tld = domain.slice(domain.lastIndexOf(".") + 1).toLowerCase();
  if (!rdapBootstrap) {
    rdapBootstrap = new Map();
    try {
      const response = await fetch("https://data.iana.org/rdap/dns.json", {
        timeout: RDAP_TIMEOUT_MS,
      });
      if (response.ok) {
        const body = (await response.json()) as { services?: Array<[string[], string[]]> };
        for (const [tlds, urls] of body.services || []) {
          const url = urls.find((u) => u.startsWith("https://")) || urls[0];
          if (!url) continue;
          const base = url.endsWith("/") ? url : `${url}/`;
          for (const t of tlds) rdapBootstrap.set(t.toLowerCase(), base);
        }
      }
    } catch {
      // Bootstrap unavailable — fall back to the aggregator for everything.
    }
  }
  const base = rdapBootstrap.get(tld);
  return base ? `${base}domain/` : "https://rdap.org/domain/";
}

/**
 * Authoritative registration lookup via RDAP: is the domain registered at
 * all, and when does the registration expire? Used to audit inventory
 * entries whose source (DNS zones, cPanel) says nothing about ownership.
 */
export async function rdapRegistration(domain: string): Promise<RdapRegistration> {
  try {
    const response = await fetch(`${await rdapBaseFor(domain)}${encodeURIComponent(domain)}`, {
      headers: { accept: "application/rdap+json" },
      timeout: RDAP_TIMEOUT_MS,
    });
    if (response.status === 404) {
      // Some registries 404 on rdap.org for registered domains. A domain
      // that is delegated in public DNS is registered regardless.
      try {
        const nameservers = await dns.resolveNs(domain);
        if (nameservers.length > 0) {
          return { domain, registered: true, detail: "delegated in DNS (no RDAP record)" };
        }
      } catch {
        // NXDOMAIN — the 404 stands.
      }
      return { domain, registered: false, detail: "no registration record" };
    }
    if (!response.ok) {
      return { domain, registered: null, detail: `RDAP returned ${response.status}` };
    }
    const body = (await response.json()) as {
      events?: Array<{ eventAction?: string; eventDate?: string }>;
    };
    const expiration = body.events?.find((e) => e.eventAction === "expiration")?.eventDate;
    return { domain, registered: true, expiresAt: expiration };
  } catch (error) {
    return {
      domain,
      registered: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatPublicAvailability(result: PublicAvailability): string {
  const lines = [`${result.domain}  ${result.status}  (${result.detail})`];
  if (result.status === "available") {
    lines.push("  Availability is from public DNS/RDAP. For price and purchase, connect a registrar:");
    lines.push("  uplink domains providers connect godaddy --token-env GODADDY_PAT");
  }
  return lines.join("\n");
}
