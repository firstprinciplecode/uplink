import { Router, Request, Response } from "express";
import { logger } from "../utils/logger";

export const publicRouter = Router();

// Default to the relay HTTP port used by the production relay (`relay-improved.js`).
// For local dev relay (`scripts/tunnel/relay.js`), override to: http://127.0.0.1:7072
const RELAY_STATS_URL = process.env.RELAY_STATS_URL || "http://127.0.0.1:7070";
const RELAY_INTERNAL_SECRET = process.env.RELAY_INTERNAL_SECRET || "";
const ACTIVITY_CACHE_TTL = 10 * 1000; // 10 seconds

// SECURITY:
// - Default is OFF in production.
// - "count" exposes only aggregate counts (no IP-derived geolocation).
const PUBLIC_TUNNEL_ACTIVITY_MODE = (process.env.PUBLIC_TUNNEL_ACTIVITY_MODE || "off").toLowerCase(); // off | count
const PUBLIC_TUNNEL_ACTIVITY_ORIGIN = process.env.PUBLIC_TUNNEL_ACTIVITY_ORIGIN || "https://uplink.spot";

const activityCache: { data: TunnelActivity | null; timestamp: number } = { data: null, timestamp: 0 };

interface TunnelActivity {
  // Kept for backward compatibility with the website payload shape.
  tunnels: Array<{ lat: number; lng: number; city: string; country: string }>;
  count: number;
  timestamp: string;
}

interface RelayClient {
  token: string;
  clientIp: string;
  targetPort: number;
  connectedAt: string;
}

function makeMinimalActivity(count: number): TunnelActivity {
  return {
    tunnels: [],
    count,
    timestamp: new Date().toISOString(),
  };
}

function applyWebsiteCors(req: Request, res: Response) {
  const origin = String(req.headers.origin || "");
  if (origin && origin === PUBLIC_TUNNEL_ACTIVITY_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Cache-Control", "public, max-age=10");
}

/**
 * Fetch connected clients from the relay.
 * - Production relay (`relay-improved.js`) serves `/internal/connected-tokens` on 7070 (secret-protected).
 * - Local dev relay (`relay.js`) serves `/status` on 7072 (no secret).
 * NOTE: Responses may contain client IPs; we never expose them publicly.
 */
async function fetchRelayClients(): Promise<RelayClient[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (RELAY_INTERNAL_SECRET) headers["x-relay-internal-secret"] = RELAY_INTERNAL_SECRET;

    // Try production relay endpoint first
    const primaryUrl = `${RELAY_STATS_URL}/internal/connected-tokens`;
    const primary = await fetch(primaryUrl, { headers, signal: controller.signal });

    if (primary.ok) {
      try {
        const data = await primary.json();
        const tunnels = (data.tunnels || []) as RelayClient[];
        return Array.isArray(tunnels) ? tunnels : [];
      } catch (e) {
        logger.warn({ event: "relay.clients.parse_error", error: e instanceof Error ? e.message : String(e) });
      }
    } else {
      logger.warn({ event: "relay.clients.error", status: primary.status });
    }

    // Fallback to local dev relay status endpoint (do NOT send internal secret)
    const fallbackUrl = `${RELAY_STATS_URL}/status`;
    const fallback = await fetch(fallbackUrl, { method: "GET", signal: controller.signal });
    if (fallback.ok) {
      try {
        const json = await fallback.json();
        const tunnels = (json.tunnels || []) as RelayClient[];
        return Array.isArray(tunnels) ? tunnels : [];
      } catch {
        return [];
      }
    }

    return [];
  } catch (error) {
    logger.warn({ event: "relay.clients.fetch_error", error: error instanceof Error ? error.message : String(error) });
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * GET /public/tunnel-activity
 * SECURITY: If enabled, returns ONLY aggregate counts (no geolocation).
 */
publicRouter.get("/tunnel-activity", async (req: Request, res: Response) => {
  try {

    if (PUBLIC_TUNNEL_ACTIVITY_MODE !== "count") {
      applyWebsiteCors(req, res);
      return res.status(404).json(makeMinimalActivity(0));
    }

    if (activityCache.data && Date.now() - activityCache.timestamp < ACTIVITY_CACHE_TTL) {
      applyWebsiteCors(req, res);
      return res.json(activityCache.data);
    }

    const clients = await fetchRelayClients();
    const activity = makeMinimalActivity(clients.length);

    activityCache.data = activity;
    activityCache.timestamp = Date.now();

    applyWebsiteCors(req, res);

    return res.json(activity);
  } catch (error) {
    logger.error({ event: "tunnel_activity.error", error: error instanceof Error ? error.message : String(error) });
    applyWebsiteCors(req, res);
    return res.json(makeMinimalActivity(0));
  }
});

publicRouter.options("/tunnel-activity", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", PUBLIC_TUNNEL_ACTIVITY_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.sendStatus(204);
});
