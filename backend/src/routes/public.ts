import { Router, Request, Response } from "express";
import { logger } from "../utils/logger";

export const publicRouter = Router();

const RELAY_STATS_URL = process.env.RELAY_STATS_URL || "http://127.0.0.1:7071";
const RELAY_INTERNAL_SECRET = process.env.RELAY_INTERNAL_SECRET || "";
const GEOIP_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const ACTIVITY_CACHE_TTL = 10 * 1000; // 10 seconds

// In-memory caches
const geoipCache = new Map<string, { lat: number; lng: number; city: string; country: string; timestamp: number }>();
const activityCache: { data: TunnelActivity | null; timestamp: number } = { data: null, timestamp: 0 };

interface TunnelActivity {
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

/**
 * Fetch geolocation for an IP address using ip-api.com (free tier)
 * Caches results for 24 hours to reduce API calls
 */
async function geolocateIp(ip: string): Promise<{ lat: number; lng: number; city: string; country: string } | null> {
  // Check cache first
  const cached = geoipCache.get(ip);
  if (cached && Date.now() - cached.timestamp < GEOIP_CACHE_TTL) {
    return { lat: cached.lat, lng: cached.lng, city: cached.city, country: cached.country };
  }

  // Skip private/local IPs
  if (ip === "127.0.0.1" || ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172.")) {
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);

    const response = await fetch(`http://ip-api.com/json/${ip}?fields=status,lat,lon,city,country,countryCode`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const data = await response.json();
    if (data.status !== "success") {
      return null;
    }

    const result = {
      lat: data.lat,
      lng: data.lon,
      city: data.city || "Unknown",
      country: data.countryCode || data.country || "Unknown",
      timestamp: Date.now(),
    };

    // Cache the result
    geoipCache.set(ip, result);

    return { lat: result.lat, lng: result.lng, city: result.city, country: result.country };
  } catch (error) {
    logger.warn({ event: "geoip.error", ip, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/**
 * Fetch connected clients from the relay's internal stats endpoint
 */
async function fetchRelayClients(): Promise<RelayClient[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (RELAY_INTERNAL_SECRET) {
      headers["x-relay-internal-secret"] = RELAY_INTERNAL_SECRET;
    }

    const response = await fetch(`${RELAY_STATS_URL}/internal/connected-tokens`, {
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      logger.warn({ event: "relay.clients.error", status: response.status });
      return [];
    }

    const data = await response.json();
    return data.tunnels || [];
  } catch (error) {
    logger.warn({ event: "relay.clients.fetch_error", error: error instanceof Error ? error.message : String(error) });
    return [];
  }
}

/**
 * GET /public/tunnel-activity
 * Returns geolocated active tunnel data for the globe visualization
 * No authentication required - this is public data
 */
publicRouter.get("/tunnel-activity", async (_req: Request, res: Response) => {
  try {
    // Check activity cache first
    if (activityCache.data && Date.now() - activityCache.timestamp < ACTIVITY_CACHE_TTL) {
      return res.json(activityCache.data);
    }

    // Fetch connected clients from relay
    const clients = await fetchRelayClients();

    // Geolocate unique IPs (limit concurrent requests to avoid rate limiting)
    const uniqueIps = [...new Set(clients.map((c) => c.clientIp))];
    const geoPromises = uniqueIps.slice(0, 45).map((ip) => geolocateIp(ip)); // ip-api.com limit is 45/min
    const geoResults = await Promise.all(geoPromises);

    // Build IP to geo mapping
    const ipToGeo = new Map<string, { lat: number; lng: number; city: string; country: string }>();
    uniqueIps.slice(0, 45).forEach((ip, i) => {
      const geo = geoResults[i];
      if (geo) {
        ipToGeo.set(ip, geo);
      }
    });

    // Build tunnel locations (deduplicated by city to reduce visual clutter)
    const seenCities = new Set<string>();
    const tunnels: Array<{ lat: number; lng: number; city: string; country: string }> = [];

    for (const client of clients) {
      const geo = ipToGeo.get(client.clientIp);
      if (geo) {
        const cityKey = `${geo.city}-${geo.country}`;
        if (!seenCities.has(cityKey)) {
          seenCities.add(cityKey);
          tunnels.push(geo);
        }
      }
    }

    const activity: TunnelActivity = {
      tunnels,
      count: clients.length,
      timestamp: new Date().toISOString(),
    };

    // Cache the result
    activityCache.data = activity;
    activityCache.timestamp = Date.now();

    // Set CORS headers for public access
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Cache-Control", "public, max-age=10");

    return res.json(activity);
  } catch (error) {
    logger.error({ event: "tunnel_activity.error", error: error instanceof Error ? error.message : String(error) });
    
    // Return empty data on error (fail gracefully)
    return res.json({
      tunnels: [],
      count: 0,
      timestamp: new Date().toISOString(),
    });
  }
});

// Handle CORS preflight
publicRouter.options("/tunnel-activity", (_req: Request, res: Response) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.sendStatus(204);
});
