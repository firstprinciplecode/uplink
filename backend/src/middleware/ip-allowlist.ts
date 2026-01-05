import { Request, Response, NextFunction } from "express";
import { makeError } from "../schemas/error";
import { logger } from "../utils/logger";

function normalizeIp(ipRaw: string): string {
  const ip = (ipRaw || "").trim();
  if (!ip) return "";

  // Express / Node often represent IPv4 addresses as IPv6-mapped addresses.
  // Example: ::ffff:127.0.0.1
  const v4MappedPrefix = "::ffff:";
  if (ip.toLowerCase().startsWith(v4MappedPrefix)) {
    return ip.slice(v4MappedPrefix.length);
  }

  // Treat IPv6 loopback as IPv4 loopback for allowlist comparisons.
  if (ip === "::1") return "127.0.0.1";

  return ip;
}

/**
 * IP allowlist middleware for internal endpoints.
 * Only allows requests from configured IP addresses or CIDR ranges.
 * 
 * Usage:
 *   app.use("/internal", ipAllowlist(["127.0.0.1", "10.0.0.0/8"]));
 * 
 * If INTERNAL_IP_ALLOWLIST env var is set, it overrides the provided list.
 * Format: comma-separated IPs or CIDR ranges (e.g., "127.0.0.1,10.0.0.0/8")
 * 
 * If no allowlist is configured, this middleware allows all IPs (fail-open for compatibility).
 */
function ipToNumber(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    throw new Error(`Invalid IP: ${ip}`);
  }
  return (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
}

function parseCIDR(cidr: string): { network: number; mask: number } | null {
  const [ip, maskStr] = cidr.split("/");
  if (!ip || !maskStr) return null;
  const maskBits = Number(maskStr);
  if (isNaN(maskBits) || maskBits < 0 || maskBits > 32) return null;
  try {
    const network = ipToNumber(ip);
    const mask = ~((1 << (32 - maskBits)) - 1);
    return { network: network & mask, mask };
  } catch {
    return null;
  }
}

function matchesCIDR(ip: string, cidr: string): boolean {
  const parsed = parseCIDR(cidr);
  if (!parsed) return false;
  try {
    const ipNum = ipToNumber(ip);
    return (ipNum & parsed.mask) === parsed.network;
  } catch {
    return false;
  }
}

export function ipAllowlist(allowedIPs: string[] = []) {
  // Read from env var if set (comma-separated)
  const envAllowlist = process.env.INTERNAL_IP_ALLOWLIST;
  const finalAllowlistRaw = envAllowlist
    ? envAllowlist.split(",").map((s) => s.trim()).filter(Boolean)
    : allowedIPs;
  const finalAllowlist = finalAllowlistRaw.map(normalizeIp).filter(Boolean);

  // If no allowlist configured, allow all (fail-open for compatibility)
  if (finalAllowlist.length === 0) {
    return (req: Request, res: Response, next: NextFunction) => {
      next();
    };
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const clientIpRaw = (req.ip || req.socket.remoteAddress || "") as string;
    const clientIp = normalizeIp(clientIpRaw);
    
    // Check if IP matches any allowed IP or CIDR
    const isAllowed = finalAllowlist.some((allowed) => {
      if (allowed === clientIp) return true;
      if (allowed.includes("/")) return matchesCIDR(clientIp, allowed);
      return false;
    });

    if (!isAllowed) {
      logger.warn({
        event: "ip_allowlist.blocked",
        ip: clientIp,
        ipRaw: clientIpRaw,
        path: req.path,
        allowedIPs: finalAllowlist,
      });
      return res.status(403).json(
        makeError("FORBIDDEN", "Access denied from this IP address")
      );
    }

    next();
  };
}
