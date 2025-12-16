#!/usr/bin/env node
/**
 * Improved tunnel relay with token validation, rate limiting, and better error handling.
 * Routes by Host header: <token>.t.uplink.spot -> token
 * - Ingress HTTP: LISTEN_HTTP (default 7070)
 * - Control channel: LISTEN_CTRL (default 7071)
 * - Token validation via API: VALIDATE_TOKENS (default: false)
 * - Rate limiting: RATE_LIMIT_REQUESTS per minute per token (default: 1000)
 */

const http = require("http");
const net = require("net");
const tls = require("tls");
const fs = require("fs");
const { randomUUID } = require("crypto");

const LISTEN_HTTP = Number(process.env.TUNNEL_RELAY_HTTP || 7070);
const LISTEN_CTRL = Number(process.env.TUNNEL_RELAY_CTRL || 7071);
const TUNNEL_DOMAIN = process.env.TUNNEL_DOMAIN || "t.uplink.spot";
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

// token -> client socket
const clients = new Map();
// requestId -> http response
const pending = new Map();
// token -> rate limit tracking
const rateLimits = new Map();
// token -> validation cache (to avoid repeated DB queries)
const tokenCache = new Map();
const TOKEN_CACHE_TTL = 60000; // 1 minute

// Stats
const stats = {
  requests: 0,
  errors: 0,
  rateLimited: 0,
  invalidTokens: 0,
  startTime: Date.now(),
};

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

// Validate token via API
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
      const req = http.get(url, { timeout: 2000 }, (res) => {
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
    // On error, allow token (fail open for availability)
    tokenCache.set(token, { valid: true, timestamp: Date.now() });
    return true;
  }
}

// Extract token from Host header: abc123.t.uplink.spot -> abc123
function extractTokenFromHost(host) {
  if (!host) return null;
  const parts = host.split(".");
  if (parts.length < 3) return null;
  const token = parts[0];
  const domain = parts.slice(1).join(".");
  if (domain === TUNNEL_DOMAIN || domain.endsWith(`.${TUNNEL_DOMAIN}`)) {
    return token;
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
          
          // Register client
          registeredToken = msg.token;
          clients.set(msg.token, socket);
          socket.token = msg.token;
          log("registered client", msg.token.substring(0, 8) + "...", "port", msg.targetPort);
          socket.write(JSON.stringify({ type: "registered" }) + "\n");
          
        } else if (msg.type === "response" && msg.id) {
          const res = pending.get(msg.id);
          if (!res) {
            log("warn", "Response for unknown request:", msg.id);
            return;
          }
          pending.delete(msg.id);
          
          const body = msg.body ? Buffer.from(msg.body, "base64") : Buffer.alloc(0);
          
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
      clients.delete(registeredToken);
      log("client disconnected", registeredToken.substring(0, 8) + "...");
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

  const host = req.headers.host;
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

  // Internal endpoint: list connected tokens (for API to query)
  if (url.pathname === "/internal/connected-tokens" && (!host || !host.includes(TUNNEL_DOMAIN))) {
    const connectedTokens = Array.from(clients.keys());
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ tokens: connectedTokens }));
  }

  const token = extractTokenFromHost(host);
  if (!token) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    return res.end(`Invalid host. Expected format: <token>.${TUNNEL_DOMAIN}`);
  }

  // Rate limiting
  if (!checkRateLimit(token)) {
    res.statusCode = 429;
    res.setHeader("Content-Type", "text/plain");
    res.setHeader("Retry-After", "60");
    return res.end("Rate limit exceeded");
  }

  // Check if client is connected
  const client = clients.get(token);
  if (!client) {
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
  pending.set(id, res);

  const msg = {
    type: "request",
    id,
    method: req.method,
    path,
    headers: req.headers,
    body: body.length ? body.toString("base64") : "",
  };
  
  try {
    client.write(JSON.stringify(msg) + "\n");
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

httpServer.listen(LISTEN_HTTP, "0.0.0.0", () => {
  log(`Tunnel ingress listening on ${LISTEN_HTTP}`);
  log(`Domain: ${TUNNEL_DOMAIN}`);
  log(`Expected format: <token>.${TUNNEL_DOMAIN}`);
  log(`Max request size: ${MAX_REQUEST_SIZE / 1024 / 1024}MB`);
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

