import "dotenv/config";
import express from "express";
import bodyParser from "body-parser";
import compression from "compression";
import helmet from "helmet";
import { dbRouter } from "./routes/dbs";
import { tunnelRouter, tunnelTokenExists, resolveAliasHandler } from "./routes/tunnels";
import { adminRouter } from "./routes/admin";
import { meRouter } from "./routes/me";
import { signupRouter } from "./routes/signup";
import { publicRouter } from "./routes/public";
import { authMiddleware } from "./middleware/auth";
import { apiRateLimiter, internalAllowTlsRateLimiter } from "./middleware/rate-limit";
import { logger } from "./utils/logger";
import { config } from "./utils/config";
import { makeError } from "./schemas/error";

const app = express();

// Security headers
app.use(helmet());

// Response compression (gzip/deflate) - reduces response size by 70-90%
app.use(compression({
  level: 6, // Balanced compression (1-9, higher = smaller but slower)
  threshold: 1024, // Only compress responses > 1KB
  filter: (req, res) => {
    // Don't compress if client doesn't accept it
    if (req.headers["x-no-compression"]) return false;
    return compression.filter(req, res);
  },
}));

// Body parsing
app.use(bodyParser.json({ limit: "10mb" }));

// Request logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    logger.info({
      method: req.method,
      path: req.path,
      status: res.statusCode,
      duration,
      ip: req.ip,
    });
  });
  next();
});

// Health check (no auth, no rate limit)
app.get("/health", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Health check endpoints for Kubernetes/Docker
app.get("/health/live", (req, res) => {
  res.json({ status: "alive" });
});

// Cache for ready check (avoid DB query on every health check)
let readyCache: { ready: boolean; checkedAt: number } | null = null;
const READY_CACHE_TTL = 5000; // 5 seconds

app.get("/health/ready", async (req, res) => {
  const now = Date.now();
  
  // Return cached result if fresh
  if (readyCache && (now - readyCache.checkedAt) < READY_CACHE_TTL) {
    if (readyCache.ready) {
      return res.json({ status: "ready", cached: true });
    }
    return res.status(503).json({ status: "not ready", cached: true });
  }
  
  try {
    // Check database connection
    const { pool } = await import("./db/pool");
    await pool.query("SELECT 1");
    readyCache = { ready: true, checkedAt: now };
    res.json({ status: "ready" });
  } catch (error) {
    logger.error({ event: "health_check.failed", error });
    readyCache = { ready: false, checkedAt: now };
    res.status(503).json({ status: "not ready" });
  }
});

// Allow on-demand TLS (Caddy ask endpoint)
// SECURITY: protected by RELAY_INTERNAL_SECRET header + rate-limited.
app.get("/internal/allow-tls", internalAllowTlsRateLimiter, async (req, res) => {
  try {
    const secret = process.env.RELAY_INTERNAL_SECRET || "";
    if (!secret) {
      // In production we fail at startup if missing; this is a safe fallback.
      return res.status(503).json({ allow: false });
    }
    const provided = req.headers["x-relay-internal-secret"];
    if (provided !== secret) {
      return res.status(403).json({ allow: false });
    }

    const domain = (req.query.domain as string) || (req.query.host as string) || "";
    const host = domain.split(":")[0].trim().toLowerCase();

    // Expect <token>.<TUNNEL_DOMAIN>
    if (!host.endsWith(`.${config.tunnelDomain}`)) {
      return res.status(403).json({ allow: false });
    }

    const token = host.slice(0, -(config.tunnelDomain.length + 1));
    if (!/^[a-zA-Z0-9]{3,64}$/.test(token)) {
      return res.status(403).json({ allow: false });
    }

    const exists = await tunnelTokenExists(token);
    if (exists) {
      return res.json({ allow: true });
    }
    return res.status(403).json({ allow: false });
  } catch (error) {
    logger.error({ event: "allow_tls.error", error });
    return res.status(500).json({ allow: false });
  }
});

// Internal alias resolution for relay - no auth, uses relay secret
app.get("/internal/resolve-alias", resolveAliasHandler);

// Public endpoints (no auth required) - for website globe visualization
app.use("/public", publicRouter);

// Global rate limiting for all /v1 routes
app.use("/v1", apiRateLimiter);

// Public signup endpoint (no auth required)
app.use("/v1/signup", signupRouter);

// Auth middleware for all other /v1 routes
app.use("/v1", authMiddleware);
app.use("/v1/dbs", dbRouter);
app.use("/v1/tunnels", tunnelRouter);
app.use("/v1/admin", adminRouter);
app.use("/v1/me", meRouter);

// Error handling middleware
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  logger.error({
    event: "error.unhandled",
    error: err.message,
    stack: err.stack,
    path: req.path,
  });
  res.status(500).json(makeError("INTERNAL_ERROR", "An unexpected error occurred"));
});

// 404 handler
app.use((req, res) => {
  res.status(404).json(makeError("NOT_FOUND", "Route not found"));
});

// Graceful shutdown
const server = app.listen(config.port, () => {
  logger.info({
    event: "server.started",
    port: config.port,
    env: process.env.NODE_ENV || "development",
  });
});

process.on("SIGTERM", () => {
  logger.info({ event: "server.shutdown", signal: "SIGTERM" });
  server.close(() => {
    logger.info({ event: "server.closed" });
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.info({ event: "server.shutdown", signal: "SIGINT" });
  server.close(() => {
    logger.info({ event: "server.closed" });
    process.exit(0);
  });
});

