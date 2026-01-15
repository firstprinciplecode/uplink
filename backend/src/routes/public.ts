import { Router } from "express";
import http from "http";
import { logger } from "../utils/logger";

export const publicRouter = Router();

const RELAY_HTTP_PORT = Number(process.env.TUNNEL_RELAY_HTTP || 7070);
const RELAY_HOST = process.env.TUNNEL_RELAY_HOST || "127.0.0.1";
const RELAY_INTERNAL_SECRET = process.env.RELAY_INTERNAL_SECRET || "";

async function fetchRelayJson(path: string, timeoutMs: number): Promise<any | null> {
  const headers: Record<string, string> = {};
  if (RELAY_INTERNAL_SECRET) headers["x-relay-internal-secret"] = RELAY_INTERNAL_SECRET;

  return new Promise((resolve) => {
    const req = http.get(
      {
        host: RELAY_HOST,
        port: RELAY_HTTP_PORT,
        path,
        timeout: timeoutMs,
        headers: Object.keys(headers).length ? headers : undefined,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk.toString()));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

/**
 * Public tunnel activity endpoint (privacy-preserving)
 * Returns only a count; never returns user IPs or geo data.
 */
publicRouter.get("/tunnel-activity", async (_req, res) => {
  try {
    // Safe to allow CORS broadly since we return only an aggregate count.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    const json = await fetchRelayJson("/internal/connected-tokens", 2000);
    const tokens = Array.isArray(json?.tokens) ? json.tokens : [];
    return res.json({ count: tokens.length });
  } catch (error) {
    logger.warn({ event: "public.tunnel_activity.failed", error });
    return res.json({ count: 0 });
  }
});

publicRouter.options("/tunnel-activity", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res.sendStatus(204);
});

