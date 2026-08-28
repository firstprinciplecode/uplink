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

export function formatPublicAvailability(result: PublicAvailability): string {
  const lines = [`${result.domain}  ${result.status}  (${result.detail})`];
  if (result.status === "available") {
    lines.push("  Availability is from public DNS/RDAP. For price and purchase, connect a registrar:");
    lines.push("  uplink domains providers connect godaddy --token-env GODADDY_PAT");
  }
  return lines.join("\n");
}
