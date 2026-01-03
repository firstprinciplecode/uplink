#!/usr/bin/env node
/**
 * Improved tunnel relay with token validation, alias resolution, rate limiting, and better error handling.
 * Routes by Host header:
 *   - Token:  <token>.x.uplink.spot (TUNNEL_DOMAIN)
 *   - Alias:  <alias>.uplink.spot (ALIAS_DOMAIN) -> resolved via backend
 * Ingress HTTP: LISTEN_HTTP (default 7070)
 * Control channel: LISTEN_CTRL (default 7071)
 * Token validation via API: VALIDATE_TOKENS (default: false)
 * Rate limiting: RATE_LIMIT_REQUESTS per minute per token (default: 1000)
 */

const http = require("http");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const { randomUUID } = require("crypto");

const LISTEN_HTTP = Number(process.env.TUNNEL_RELAY_HTTP || 7070);
const LISTEN_HTTP_HOST = process.env.TUNNEL_RELAY_HTTP_HOST || "127.0.0.1";
const LISTEN_CTRL = Number(process.env.TUNNEL_RELAY_CTRL || 7071);
const TUNNEL_DOMAIN = (process.env.TUNNEL_DOMAIN || "t.uplink.spot").toLowerCase();
const ALIAS_DOMAIN = (process.env.ALIAS_DOMAIN || "uplink.spot").toLowerCase();
const VALIDATE_TOKENS = process.env.TUNNEL_VALIDATE_TOKENS === "true";
const API_BASE = process.env.AGENTCLOUD_API_BASE || process.env.API_BASE || "http://localhost:4000";
const RATE_LIMIT_REQUESTS = Number(process.env.TUNNEL_RATE_LIMIT_REQUESTS || 1000); // per minute
const RATE_LIMIT_WINDOW = 60000; // 1 minute in ms
const MAX_REQUEST_SIZE = Number(process.env.TUNNEL_MAX_REQUEST_SIZE || 10 * 1024 * 1024); // 10MB
const CTRL_TLS_ENABLED = process.env.TUNNEL_CTRL_TLS === "true";
const CTRL_TLS_INSECURE = process.env.TUNNEL_CTRL_TLS_INSECURE === "true";
const CTRL_TLS_CA = process.env.TUNNEL_CTRL_CA || "";
const CTRL_TLS_CERT = process.env.TUNNEL_CTRL_CERT || "";
const CTRL_TLS_KEY = process.env.TUNNEL_CTRL_KEY || "";
const INTERNAL_SECRET = process.env.RELAY_INTERNAL_SECRET || "";
const INTERNAL_SECRET_HEADER = "x-relay-internal-secret";

// Unique identifier for this relay process run (used to avoid double-counting in backend persistence)
const RELAY_RUN_ID = randomUUID();

// HTTP Agent with keep-alive for connection reuse (reduces TCP handshake overhead)
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,      // Keep idle connections for 30s
  maxSockets: 10,             // Max concurrent connections per host
  maxFreeSockets: 5,          // Max idle connections to keep
  timeout: 5000,              // Socket timeout
});

// token -> { socket, clientIp, targetPort, connectedAt }
const clients = new Map();
// requestId -> { res, token, alias, startedAt }
const pending = new Map();
// alias -> { token, timestamp }
const aliasCache = new Map();
const ALIAS_CACHE_TTL = 60000;
const RESERVED_ALIASES = new Set(["www", "api", "x", "t", "docs", "support", "status", "health", "mail"]);

// Traffic stats (in-memory)
// token -> { requests, responses, bytesIn, bytesOut, lastSeenAt, lastStatus }
const trafficByToken = new Map();
// alias -> { requests, responses, bytesIn, bytesOut, lastSeenAt, lastStatus }
const trafficByAlias = new Map();

function getTraffic(map, key) {
  if (!key) return null;
  let t = map.get(key);
  if (!t) {
    t = {
      requests: 0,
      responses: 0,
      bytesIn: 0,
      bytesOut: 0,
      lastSeenAt: null,
      lastStatus: null,
    };
    map.set(key, t);
  }
  return t;
}

// Get real client IP (handle proxies)
function getClientIp(socket) {
  let ip = socket.remoteAddress || "unknown";
  // Strip IPv6 prefix for IPv4-mapped addresses
  if (ip.startsWith("::ffff:")) {
    ip = ip.slice(7);
  }
  return ip;
}
// token -> rate limit tracking
const rateLimits = new Map();
// token -> validation cache (to avoid repeated DB queries)
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 60000; // 1 minute
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 10000; // Maximum entries before forced cleanup

// Stats
const stats = {
  requests: 0,
  errors: 0,
  rateLimited: 0,
  invalidTokens: 0,
  startTime: Date.now(),
  cleanups: 0,
};

// Periodic cleanup to prevent memory leaks
function cleanupStaleCaches() {
  const now = Date.now();
  let cleaned = 0;
  
  // Cleanup dead socket connections first
  const deadTokens = [];
  for (const [token, data] of clients.entries()) {
    const socket = data.socket;
    // Check if socket is still alive and writable
    if (!socket || socket.destroyed || socket.closed || !socket.writable) {
      deadTokens.push(token);
    }
  }
  for (const token of deadTokens) {
    clients.delete(token);
    cleaned++;
  }
  if (deadTokens.length > 0) {
    log(`Cleaned up ${deadTokens.length} dead socket connection(s)`);
  }
  
  // Cleanup rate limits - remove entries with no recent requests
  for (const [token, limit] of rateLimits.entries()) {
    const validRequests = limit.requests.filter((time) => now - time < RATE_LIMIT_WINDOW);
    if (validRequests.length === 0) {
      rateLimits.delete(token);
      cleaned++;
    } else {
      limit.requests = validRequests;
    }
  }
  
  // Cleanup token cache - remove expired entries
  for (const [token, cached] of tokenCache.entries()) {
    if (now - cached.timestamp > TOKEN_CACHE_TTL * 5) { // 5x TTL for grace period
      tokenCache.delete(token);
      cleaned++;
    }
  }
  
  // Cleanup alias cache
  for (const [alias, cached] of aliasCache.entries()) {
    if (now - cached.timestamp > ALIAS_CACHE_TTL * 5) {
      aliasCache.delete(alias);
      cleaned++;
    }
  }
  
  // Force cleanup if caches are too large (LRU-like behavior)
  if (tokenCache.size > MAX_CACHE_SIZE) {
    const entries = Array.from(tokenCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = entries.slice(0, Math.floor(MAX_CACHE_SIZE / 2));
    for (const [key] of toRemove) {
      tokenCache.delete(key);
      cleaned++;
    }
  }
  
  if (cleaned > 0) {
    stats.cleanups++;
    log(`Cache cleanup: removed ${cleaned} stale entries (rate: ${rateLimits.size}, tokens: ${tokenCache.size}, aliases: ${aliasCache.size}, clients: ${clients.size})`);
  }
}

// Start cleanup interval
setInterval(cleanupStaleCaches, CLEANUP_INTERVAL);

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function logError(err, context) {
  const message = err.message || String(err);
  log("ERROR", context, message);
  stats.errors++;
}

// Rate limiting: sliding window per token
function checkRateLimit(token) {
  const now = Date.now();
  const limit = rateLimits.get(token) || { requests: [], windowStart: now };
  
  // Remove requests outside the window
  limit.requests = limit.requests.filter((time) => now - time < RATE_LIMIT_WINDOW);
  
  // Check if limit exceeded
  if (limit.requests.length >= RATE_LIMIT_REQUESTS) {
    stats.rateLimited++;
    return false;
  }
  
  // Add current request
  limit.requests.push(now);
  rateLimits.set(token, limit);
  
  return true;
}

// Validate token via API (fail-closed for security)
async function validateToken(token) {
  // Check cache first
  const cached = tokenCache.get(token);
  if (cached && Date.now() - cached.timestamp < TOKEN_CACHE_TTL) {
    return cached.valid;
  }
  
  if (!VALIDATE_TOKENS) {
    // If validation disabled, allow all tokens
    tokenCache.set(token, { valid: true, timestamp: Date.now() });
    return true;
  }
  
  try {
    const url = `${API_BASE}/internal/allow-tls?domain=${token}.${TUNNEL_DOMAIN}`;
    const response = await new Promise((resolve, reject) => {
      const headers = INTERNAL_SECRET ? { [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET } : undefined;
      const req = http.get(url, { timeout: 2000, agent: httpAgent, headers }, (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(json.allow === true);
          } catch {
            resolve(false);
          }
        });
      });
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Timeout"));
      });
    });
    
    tokenCache.set(token, { valid: response, timestamp: Date.now() });
    return response;
  } catch (err) {
    logError(err, "Token validation error");
    // SECURITY: Fail closed - deny token on validation error
    // Only allow if previously validated and still in cache with extended grace period
    const staleCache = tokenCache.get(token);
    if (staleCache && staleCache.valid && Date.now() - staleCache.timestamp < TOKEN_CACHE_TTL * 5) {
      log("Token validation failed, using stale cache for", token.slice(0, 8));
      return true; // Allow previously validated tokens during API outage (5x TTL grace)
    }
    stats.invalidTokens++;
    return false; // Deny unknown tokens on error
  }
}

async function resolveAliasToToken(alias) {
  const cached = aliasCache.get(alias);
  if (cached && Date.now() - cached.timestamp < ALIAS_CACHE_TTL) {
    return cached.token;
  }

  const url = `${API_BASE}/internal/resolve-alias?alias=${alias}`;

  try {
    const token = await new Promise((resolve, reject) => {
      const req = http.get(
        url,
        {
          timeout: 2000,
          agent: httpAgent,
          headers: INTERNAL_SECRET
            ? { [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET }
            : undefined,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk.toString();
          });
          res.on("end", () => {
            if (res.statusCode !== 200) {
              return resolve(null);
            }
            try {
              const json = JSON.parse(data);
              resolve(json.token || null);
            } catch {
              resolve(null);
            }
          });
        }
      );
      req.on("error", reject);
      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Timeout"));
      });
    });

    if (token) {
      aliasCache.set(alias, { token, timestamp: Date.now() });
    }
    return token;
  } catch (err) {
    logError(err, "Alias resolution error");
    return null;
  }
}

// Extract token from Host header: abc123.t.uplink.spot -> abc123
function extractTokenFromHost(host) {
  if (!host) return null;
  const lower = host.toLowerCase();
  const parts = lower.split(".");
  if (parts.length < 3) return null;
  const token = parts[0];
  const domain = parts.slice(1).join(".");
  if (domain === TUNNEL_DOMAIN || domain.endsWith(`.${TUNNEL_DOMAIN}`)) {
    return token;
  }
  return null;
}

function extractAliasFromHost(host) {
  if (!host) return null;
  const lower = host.toLowerCase();
  const parts = lower.split(".");
  if (parts.length < 3) return null;
  const alias = parts[0];
  const domain = parts.slice(1).join(".");
  if (domain === ALIAS_DOMAIN || domain.endsWith(`.${ALIAS_DOMAIN}`)) {
    if (RESERVED_ALIASES.has(alias)) return null;
    return alias;
  }
  return null;
}

// Control server: clients connect and register their token/port
function optionalRead(path) {
  if (!path) return undefined;
  try {
    return fs.readFileSync(path);
  } catch {
    log("warn", `Could not read TLS file: ${path}`);
    return undefined;
  }
}

const tlsOptions = CTRL_TLS_ENABLED
  ? {
      key: optionalRead(CTRL_TLS_KEY),
      cert: optionalRead(CTRL_TLS_CERT),
      ca: CTRL_TLS_CA ? [optionalRead(CTRL_TLS_CA)].filter(Boolean) : undefined,
      requestCert: false,
      rejectUnauthorized: !CTRL_TLS_INSECURE,
    }
  : undefined;

const ctrlServer = (CTRL_TLS_ENABLED ? tls.createServer(tlsOptions) : net.createServer)((socket) => {
  let buf = "";
  let registeredToken = null;
  const clientIp = getClientIp(socket);

  socket.on("data", async (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      
      // Check message size
      if (line.length > MAX_REQUEST_SIZE) {
        logError(new Error(`Message too large: ${line.length} bytes`), "Control");
        socket.write(JSON.stringify({ type: "error", message: "Message too large" }) + "\n");
        continue;
      }
      
      try {
        const msg = JSON.parse(line);
        
        if (msg.type === "register" && msg.token) {
          // Validate token
          const isValid = await validateToken(msg.token);
          if (!isValid) {
            stats.invalidTokens++;
            socket.write(JSON.stringify({ type: "error", message: "Invalid token" }) + "\n");
            socket.end();
            return;
          }
          
          // Register client with metadata
          registeredToken = msg.token;
          clients.set(msg.token, {
            socket,
            clientIp,
            targetPort: msg.targetPort || 0,
            connectedAt: new Date().toISOString(),
          });
          socket.token = msg.token;
          log("registered client", msg.token.substring(0, 8) + "...", "port", msg.targetPort, "ip", clientIp);
          socket.write(JSON.stringify({ type: "registered" }) + "\n");
          
        } else if (msg.type === "response" && msg.id) {
          const entry = pending.get(msg.id);
          if (!entry) {
            log("warn", "Response for unknown request:", msg.id);
            return;
          }
          pending.delete(msg.id);
          
          const res = entry.res;
          const token = entry.token;
          const alias = entry.alias;
          
          const body = msg.body ? Buffer.from(msg.body, "base64") : Buffer.alloc(0);
          
          // Update traffic stats (response side)
          const nowMs = Date.now();
          const tTok = getTraffic(trafficByToken, token);
          if (tTok) {
            tTok.responses += 1;
            tTok.bytesOut += body.length;
            tTok.lastSeenAt = nowMs;
            tTok.lastStatus = msg.status || 502;
          }
          const tAli = getTraffic(trafficByAlias, alias);
          if (tAli) {
            tAli.responses += 1;
            tAli.bytesOut += body.length;
            tAli.lastSeenAt = nowMs;
            tAli.lastStatus = msg.status || 502;
          }
          
          // Set headers (sanitize)
          Object.entries(msg.headers || {}).forEach(([k, v]) => {
            try {
              // Remove hop-by-hop headers
              if (["connection", "keep-alive", "transfer-encoding", "upgrade"].includes(k.toLowerCase())) {
                return;
              }
              res.setHeader(k, v);
            } catch {
              /* ignore bad headers */
            }
          });
          
          res.statusCode = msg.status || 502;
          res.end(body);
        }
      } catch (err) {
        logError(err, "Control parse error");
      }
    }
  });

  socket.on("close", () => {
    if (registeredToken) {
      const clientData = clients.get(registeredToken);
      clients.delete(registeredToken);
      log("client disconnected", registeredToken.substring(0, 8) + "...", "ip", clientData?.clientIp || "unknown");
    }
  });

  socket.on("error", (err) => {
    logError(err, "Control socket error");
  });
});

ctrlServer.listen(LISTEN_CTRL, "0.0.0.0", () => {
  log(`Tunnel control listening on ${LISTEN_CTRL}`);
  log(`Control TLS: ${CTRL_TLS_ENABLED ? "enabled" : "disabled"}`);
  log(`Token validation: ${VALIDATE_TOKENS ? "enabled" : "disabled"}`);
  log(`Rate limit: ${RATE_LIMIT_REQUESTS} requests/minute per token`);
});

// HTTP ingress -> forward to client (host-based routing)
const httpServer = http.createServer(async (req, res) => {
  stats.requests++;

  const host = req.headers.host || "";
  const pathname = req.url.split("?")[0]; // Extract pathname before URL parsing

  // Internal endpoints (protected by optional shared secret)
  if (pathname === "/internal/connected-tokens" || pathname === "/internal/traffic-stats" || pathname === "/health") {
    if (INTERNAL_SECRET && req.headers[INTERNAL_SECRET_HEADER] !== INTERNAL_SECRET) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "forbidden" }));
    }
  }

  // Internal endpoint: list connected tokens with IPs (for API to query) - check first, before token extraction
  if (pathname === "/internal/connected-tokens") {
    const tunnels = [];
    const deadTokens = [];
    
    // Check socket health and filter out dead connections
    for (const [token, data] of clients.entries()) {
      const socket = data.socket;
      // Check if socket is still alive and writable
      if (!socket || socket.destroyed || socket.closed || !socket.writable) {
        deadTokens.push(token);
        continue;
      }
      
      tunnels.push({
        token,
        clientIp: data.clientIp,
        targetPort: data.targetPort,
        connectedAt: data.connectedAt,
      });
    }
    
    // Clean up dead connections
    for (const token of deadTokens) {
      clients.delete(token);
      log("cleaned up dead connection", token.substring(0, 8) + "...");
    }
    
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ tokens: tunnels.map(t => t.token), tunnels }));
  }

  // Internal endpoint: traffic stats (no IPs, secret protected)
  if (pathname === "/internal/traffic-stats") {
    const byToken = [];
    for (const [token, t] of trafficByToken.entries()) {
      byToken.push({
        token,
        connected: clients.has(token),
        requests: t.requests,
        responses: t.responses,
        bytesIn: t.bytesIn,
        bytesOut: t.bytesOut,
        lastSeenAt: t.lastSeenAt,
        lastStatus: t.lastStatus,
      });
    }

    const byAlias = [];
    for (const [alias, t] of trafficByAlias.entries()) {
      byAlias.push({
        alias,
        requests: t.requests,
        responses: t.responses,
        bytesIn: t.bytesIn,
        bytesOut: t.bytesOut,
        lastSeenAt: t.lastSeenAt,
        lastStatus: t.lastStatus,
      });
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        relayRunId: RELAY_RUN_ID,
        since: new Date(stats.startTime).toISOString(),
        timestamp: new Date().toISOString(),
        totals: {
          tokensTracked: trafficByToken.size,
          aliasesTracked: trafficByAlias.size,
          connected: clients.size,
          pending: pending.size,
        },
        byToken,
        byAlias,
      })
    );
  }

  const url = new URL(req.url, `http://${host || "localhost"}`);

  // Friendly health endpoint when no Host token is provided
  if (url.pathname === "/health" && (!host || !host.includes(TUNNEL_DOMAIN))) {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        status: "ok",
        uptime,
        stats: {
          requests: stats.requests,
          errors: stats.errors,
          rateLimited: stats.rateLimited,
          invalidTokens: stats.invalidTokens,
          activeConnections: clients.size,
          pendingRequests: pending.size,
        },
      })
    );
  }

  let token = extractTokenFromHost(host);
  let aliasKey = null;
  if (!token) {
    const alias = extractAliasFromHost(host);
    if (alias) {
      aliasKey = alias;
      token = await resolveAliasToToken(alias);
      if (!token) {
        res.statusCode = 404;
        res.setHeader("Content-Type", "text/plain");
        return res.end("Alias not found or inactive");
      }
    } else {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain");
      return res.end(
        `Invalid host. Expected <token>.${TUNNEL_DOMAIN} or <alias>.${ALIAS_DOMAIN}`
      );
    }
  }

  // Rate limiting
  if (!checkRateLimit(token)) {
    res.statusCode = 429;
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Retry-After", "60");
    return res.end("Rate limit exceeded");
  }

  // Check if client is connected
  const clientData = clients.get(token);
  if (!clientData) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/plain");
    return res.end("Tunnel not connected");
  }

  const path = url.pathname + (url.search || "");

  // Read request body with size limit
  const chunks = [];
  let totalSize = 0;
  
  try {
    for await (const chunk of req) {
      totalSize += chunk.length;
      if (totalSize > MAX_REQUEST_SIZE) {
        res.statusCode = 413;
        res.setHeader("Content-Type", "text/plain");
        return res.end("Request entity too large");
      }
      chunks.push(chunk);
    }
  } catch (err) {
    logError(err, "Request body read error");
    res.statusCode = 400;
    return res.end("Bad request");
  }
  
  const body = Buffer.concat(chunks);

  const id = randomUUID();
  pending.set(id, { res, token, alias: aliasKey, startedAt: Date.now() });

  // Update traffic stats (request side)
  const nowMs = Date.now();
  const tTok = getTraffic(trafficByToken, token);
  if (tTok) {
    tTok.requests += 1;
    tTok.bytesIn += body.length;
    tTok.lastSeenAt = nowMs;
  }
  const tAli = getTraffic(trafficByAlias, aliasKey);
  if (tAli) {
    tAli.requests += 1;
    tAli.bytesIn += body.length;
    tAli.lastSeenAt = nowMs;
  }

  const msg = {
    type: "request",
    id,
    method: req.method,
    path,
    headers: req.headers,
    body: body.length ? body.toString("base64") : "",
  };
  
  try {
    clientData.socket.write(JSON.stringify(msg) + "\n");
  } catch (err) {
    logError(err, "Failed to send request to client");
    pending.delete(id);
    res.statusCode = 502;
    return res.end("Failed to forward request");
  }

  // Timeout
  const timer = setTimeout(() => {
    if (pending.has(id)) {
      pending.delete(id);
      res.statusCode = 504;
      res.end("Gateway timeout");
    }
  }, 30000);

  res.on("close", () => {
    clearTimeout(timer);
    pending.delete(id);
  });
});

// Tune keep-alive for better throughput
httpServer.keepAliveTimeout = 60000; // 60s
httpServer.headersTimeout = 65000;   // must be greater than keepAliveTimeout

httpServer.listen(LISTEN_HTTP, LISTEN_HTTP_HOST, () => {
  log(`Tunnel ingress listening on ${LISTEN_HTTP_HOST}:${LISTEN_HTTP}`);
  log(`Domain (tokens): ${TUNNEL_DOMAIN}`);
  log(`Domain (aliases): ${ALIAS_DOMAIN}`);
  log(`Expected token format: <token>.${TUNNEL_DOMAIN}`);
  log(`Expected alias format: <alias>.${ALIAS_DOMAIN}`);
  log(`Max request size: ${MAX_REQUEST_SIZE / 1024 / 1024}MB`);
  log(`Relay run id: ${RELAY_RUN_ID}`);
});

httpServer.on("error", (err) => {
  logError(err, "HTTP server error");
});

// Health endpoint (if accessed directly)
httpServer.on("request", (req, res) => {
  if (req.url === "/health" && req.headers.host && !req.headers.host.includes(TUNNEL_DOMAIN)) {
    const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime,
      stats: {
        requests: stats.requests,
        errors: stats.errors,
        rateLimited: stats.rateLimited,
        invalidTokens: stats.invalidTokens,
        activeConnections: clients.size,
        pendingRequests: pending.size,
      },
    }));
    return;
  }
});

// Graceful shutdown
function shutdown() {
  log("Shutting down...");
  
  // Print stats
  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  log(`Stats: ${stats.requests} requests, ${stats.errors} errors, ${stats.rateLimited} rate limited, ${uptime}s uptime`);
  
  ctrlServer.close();
  httpServer.close();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

