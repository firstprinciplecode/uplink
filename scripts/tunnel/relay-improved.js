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
const { randomUUID, timingSafeEqual } = require("crypto");

const LISTEN_HTTP = Number(process.env.TUNNEL_RELAY_HTTP || 7070);
const LISTEN_HTTP_HOST = process.env.TUNNEL_RELAY_HTTP_HOST || "127.0.0.1";
const LISTEN_CTRL = Number(process.env.TUNNEL_RELAY_CTRL || 7071);
const TUNNEL_DOMAIN = (process.env.TUNNEL_DOMAIN || "x.uplink.spot").toLowerCase();
const ALIAS_DOMAIN = (process.env.ALIAS_DOMAIN || "uplink.spot").toLowerCase();
const VALIDATE_TOKENS = process.env.TUNNEL_VALIDATE_TOKENS === "true";
const API_BASE = process.env.AGENTCLOUD_API_BASE || process.env.API_BASE || "http://localhost:4000";
const RATE_LIMIT_REQUESTS = Number(process.env.TUNNEL_RATE_LIMIT_REQUESTS || 1000); // per minute
const RATE_LIMIT_WINDOW = 60000; // 1 minute in ms
const MAX_REQUEST_SIZE = Number(process.env.TUNNEL_MAX_REQUEST_SIZE || 10 * 1024 * 1024); // 10MB
// TLS control listener (runs alongside the legacy plaintext listener so
// already-installed clients keep working). Enabled when a port + cert/key are set.
const LISTEN_CTRL_TLS = Number(process.env.TUNNEL_RELAY_CTRL_TLS || 0);
const CTRL_TLS_CA = process.env.TUNNEL_CTRL_CA || "";
const CTRL_TLS_CERT = process.env.TUNNEL_CTRL_CERT || "";
const CTRL_TLS_KEY = process.env.TUNNEL_CTRL_KEY || "";
const INTERNAL_SECRET = process.env.RELAY_INTERNAL_SECRET || "";
const INTERNAL_SECRET_HEADER = "x-relay-internal-secret";
const { sendOffline } = require("./offline-page");

// A subdomain label must be a valid DNS label. Anything else is rejected before
// it is used as a routing key or interpolated into an internal API query.
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

// Hop-by-hop headers must not be forwarded end-to-end (RFC 7230 §6.1). Stripping
// them on the request path prevents request-smuggling/desync against the local app.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function stripHopByHop(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

// Constant-time comparison of the internal secret to avoid leaking it via timing.
function internalSecretMatches(req) {
  const provided = req.headers[INTERNAL_SECRET_HEADER];
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(INTERNAL_SECRET);
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

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
// wsId -> { socket, token } — active WebSocket (upgrade) passthrough sessions
const wsSessions = new Map();
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
    const url = `${API_BASE}/internal/allow-tls?domain=${encodeURIComponent(`${token}.${TUNNEL_DOMAIN}`)}`;
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

  const url = `${API_BASE}/internal/resolve-alias?alias=${encodeURIComponent(alias)}`;

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

// Extract token from Host header: abc123.x.uplink.spot -> abc123
function extractTokenFromHost(host) {
  if (!host) return null;
  const lower = host.toLowerCase().replace(/:\d+$/, "");
  const parts = lower.split(".");
  if (parts.length < 3) return null;
  const token = parts[0];
  if (!LABEL_RE.test(token)) return null;
  const domain = parts.slice(1).join(".");
  if (domain === TUNNEL_DOMAIN || domain.endsWith(`.${TUNNEL_DOMAIN}`)) {
    return token;
  }
  return null;
}

function extractAliasFromHost(host) {
  if (!host) return null;
  const lower = host.toLowerCase().replace(/:\d+$/, "");
  const parts = lower.split(".");
  if (parts.length < 3) return null;
  const alias = parts[0];
  if (!LABEL_RE.test(alias)) return null;
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

// Re-read the certificate when Caddy/Let's Encrypt rotates it (mtime check per
// handshake) so renewals do not require a relay restart.
function makeSecureContextProvider(certPath, keyPath, caPath) {
  let cached = null;
  let certMtime = 0;
  let keyMtime = 0;
  return () => {
    const certStat = fs.statSync(certPath).mtimeMs;
    const keyStat = fs.statSync(keyPath).mtimeMs;
    if (!cached || certStat !== certMtime || keyStat !== keyMtime) {
      cached = tls.createSecureContext({
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
        ca: caPath ? fs.readFileSync(caPath) : undefined,
      });
      certMtime = certStat;
      keyMtime = keyStat;
      log(`Control TLS certificate (re)loaded from ${certPath}`);
    }
    return cached;
  };
}

const handleControlConnection = (socket) => {
  let buf = "";
  let registeredToken = null;
  const clientIp = getClientIp(socket);

  socket.on("data", async (chunk) => {
    buf += chunk.toString("utf8");
    // Bound the buffer BEFORE searching for a newline, otherwise a client can
    // stream unbounded bytes with no newline and OOM the relay (the per-line
    // size check below would never run). The control port is internet-facing.
    if (buf.length > MAX_REQUEST_SIZE) {
      logError(new Error(`Control buffer overflow: ${buf.length} bytes`), "Control");
      try {
        socket.write(JSON.stringify({ type: "error", message: "Message too large" }) + "\n");
      } catch {
        /* ignore */
      }
      buf = "";
      socket.destroy();
      return;
    }
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
          // Reject tokens that aren't well-formed DNS labels; they can never be
          // routed to (extractTokenFromHost applies the same rule) and must not
          // become map keys.
          if (typeof msg.token !== "string" || !LABEL_RE.test(msg.token)) {
            stats.invalidTokens++;
            socket.write(JSON.stringify({ type: "error", message: "Invalid token" }) + "\n");
            socket.end();
            return;
          }

          // Validate token
          const isValid = await validateToken(msg.token);
          if (!isValid) {
            stats.invalidTokens++;
            socket.write(JSON.stringify({ type: "error", message: "Invalid token" }) + "\n");
            socket.end();
            return;
          }

          // SECURITY: reject takeover of a token that already has a live client.
          // Without this, anyone who knows a token can re-register and overwrite
          // the victim's entry, hijacking all traffic to their subdomain. A dead
          // socket (client reconnecting after a drop) is allowed to replace itself.
          const existing = clients.get(msg.token);
          if (
            existing &&
            existing.socket &&
            existing.socket !== socket &&
            !existing.socket.destroyed &&
            existing.socket.writable
          ) {
            log("rejected duplicate registration", msg.token.substring(0, 8) + "...", "ip", clientIp);
            socket.write(
              JSON.stringify({ type: "error", message: "Tunnel already connected" }) + "\n"
            );
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
          
        } else if (msg.type === "response-head" && msg.id) {
          // Streaming response: headers first, then response-chunk messages,
          // then response-end. Entry stays in `pending` until the stream ends.
          const entry = pending.get(msg.id);
          if (!entry) {
            log("warn", "Response head for unknown request:", msg.id);
            return;
          }
          // SECURITY: only the client that owns this request's token may answer
          // it. Prevents a malicious client from injecting responses into another
          // tenant's in-flight request.
          if (entry.token !== socket.token) {
            log("warn", "Cross-tenant response-head rejected for", msg.id);
            return;
          }
          entry.started = true;

          const res = entry.res;
          Object.entries(msg.headers || {}).forEach(([k, v]) => {
            try {
              if (["connection", "keep-alive", "transfer-encoding", "upgrade"].includes(k.toLowerCase())) {
                return;
              }
              res.setHeader(k, v);
            } catch {
              /* ignore bad headers */
            }
          });
          res.statusCode = msg.status || 502;

          const nowMs = Date.now();
          const tTok = getTraffic(trafficByToken, entry.token);
          if (tTok) {
            tTok.responses += 1;
            tTok.lastSeenAt = nowMs;
            tTok.lastStatus = msg.status || 502;
          }
          const tAli = getTraffic(trafficByAlias, entry.alias);
          if (tAli) {
            tAli.responses += 1;
            tAli.lastSeenAt = nowMs;
            tAli.lastStatus = msg.status || 502;
          }

        } else if (msg.type === "response-chunk" && msg.id) {
          const entry = pending.get(msg.id);
          if (!entry) return;
          if (entry.token !== socket.token) return;
          const data = Buffer.from(msg.data || "", "base64");
          entry.res.write(data);
          const tTok = getTraffic(trafficByToken, entry.token);
          if (tTok) {
            tTok.bytesOut += data.length;
            tTok.lastSeenAt = Date.now();
          }
          const tAli = getTraffic(trafficByAlias, entry.alias);
          if (tAli) {
            tAli.bytesOut += data.length;
            tAli.lastSeenAt = Date.now();
          }

        } else if (msg.type === "response-end" && msg.id) {
          const entry = pending.get(msg.id);
          if (!entry) return;
          if (entry.token !== socket.token) return;
          pending.delete(msg.id);
          entry.res.end();

        } else if (msg.type === "response" && msg.id) {
          // Legacy single-message response (kept for older tunnel clients)
          const entry = pending.get(msg.id);
          if (!entry) {
            log("warn", "Response for unknown request:", msg.id);
            return;
          }
          if (entry.token !== socket.token) {
            log("warn", "Cross-tenant response rejected for", msg.id);
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

        } else if (msg.type === "ws-data" && msg.id) {
          const session = wsSessions.get(msg.id);
          if (session && session.token !== socket.token) return;
          if (session && !session.socket.destroyed) {
            const data = Buffer.from(msg.data || "", "base64");
            session.socket.write(data);
            const tTok = getTraffic(trafficByToken, session.token);
            if (tTok) {
              tTok.bytesOut += data.length;
              tTok.lastSeenAt = Date.now();
            }
          }

        } else if (msg.type === "ws-close" && msg.id) {
          const session = wsSessions.get(msg.id);
          if (session && session.token !== socket.token) return;
          wsSessions.delete(msg.id);
          if (session && !session.socket.destroyed) {
            session.socket.end();
          }
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
      // Tear down any WebSocket sessions owned by this client
      for (const [wsId, session] of wsSessions.entries()) {
        if (session.token === registeredToken) {
          wsSessions.delete(wsId);
          if (!session.socket.destroyed) session.socket.destroy();
        }
      }
      log("client disconnected", registeredToken.substring(0, 8) + "...", "ip", clientData?.clientIp || "unknown");
    }
  });

  socket.on("error", (err) => {
    logError(err, "Control socket error");
  });
};

// Legacy plaintext listener — kept so clients installed before the TLS rollout
// keep working. New clients default to the TLS port.
const ctrlServer = net.createServer(handleControlConnection);

ctrlServer.listen(LISTEN_CTRL, "0.0.0.0", () => {
  log(`Tunnel control listening on ${LISTEN_CTRL} (plaintext, legacy)`);
  log(`Token validation: ${VALIDATE_TOKENS ? "enabled" : "disabled"}`);
  log(`Rate limit: ${RATE_LIMIT_REQUESTS} requests/minute per token`);

  // The control port is internet-facing. Without token validation, only the
  // duplicate-registration guard stops a caller from claiming an unconnected
  // token, so validation should be enabled in production.
  if (process.env.NODE_ENV === "production") {
    if (!VALIDATE_TOKENS) {
      log(
        "SECURITY WARNING: TUNNEL_VALIDATE_TOKENS is not enabled in production. " +
          "Any client can register a token that isn't already connected. " +
          "Set TUNNEL_VALIDATE_TOKENS=true and RELAY_INTERNAL_SECRET."
      );
    }
    if (!INTERNAL_SECRET) {
      log(
        "SECURITY WARNING: RELAY_INTERNAL_SECRET is unset. Internal endpoints are " +
          "only protected by the public-host gate. Set a secret in the runtime .env."
      );
    }
    if (!LISTEN_CTRL_TLS || !CTRL_TLS_CERT || !CTRL_TLS_KEY) {
      log(
        "SECURITY WARNING: no TLS control listener configured. Registration tokens " +
          "cross the control channel in cleartext. Set TUNNEL_RELAY_CTRL_TLS, " +
          "TUNNEL_CTRL_CERT, and TUNNEL_CTRL_KEY."
      );
    }
  }
});

// TLS control listener (preferred). Serves the same protocol as the plaintext
// port; certificate rotation is picked up per-handshake via SNICallback.
let ctrlTlsServer = null;
if (LISTEN_CTRL_TLS && CTRL_TLS_CERT && CTRL_TLS_KEY) {
  const getSecureContext = makeSecureContextProvider(CTRL_TLS_CERT, CTRL_TLS_KEY, CTRL_TLS_CA);
  ctrlTlsServer = tls.createServer(
    {
      cert: optionalRead(CTRL_TLS_CERT),
      key: optionalRead(CTRL_TLS_KEY),
      ca: CTRL_TLS_CA ? [optionalRead(CTRL_TLS_CA)].filter(Boolean) : undefined,
      SNICallback: (_servername, cb) => {
        try {
          cb(null, getSecureContext());
        } catch (err) {
          logError(err, "TLS context reload");
          cb(err);
        }
      },
    },
    handleControlConnection
  );
  ctrlTlsServer.on("tlsClientError", (err) => {
    // Bots probing the port with bad handshakes are routine; log quietly.
    logError(err, "Control TLS handshake");
  });
  ctrlTlsServer.listen(LISTEN_CTRL_TLS, "0.0.0.0", () => {
    log(`Tunnel control (TLS) listening on ${LISTEN_CTRL_TLS}`);
  });
}

// HTTP ingress -> forward to client (host-based routing)
const httpServer = http.createServer(async (req, res) => {
  stats.requests++;

  const host = req.headers.host || "";
  const pathname = req.url.split("?")[0]; // Extract pathname before URL parsing

  // Requests arriving via the public ingress carry a tunnel/alias Host (Caddy
  // proxies *.x.uplink.spot and *.uplink.spot here preserving Host). Legitimate
  // internal callers reach the loopback listener with a bare host (127.0.0.1).
  const isPublicHost = Boolean(extractTokenFromHost(host) || extractAliasFromHost(host));

  // Internal endpoints expose full tunnel tokens + client IPs, so they must be
  // unreachable from the public internet. Two independent gates:
  //   1. Never serve them to a request that came in on a public tunnel host.
  //   2. When a shared secret is configured, require a timing-safe match.
  // Both must pass; the host gate alone closes the remote token-dump even if the
  // secret is unset, without breaking on-box internal callers.
  if (pathname.startsWith("/internal/")) {
    // 1. Never serve internal endpoints to a request that arrived on a public
    //    tunnel/alias host. This closes the remote token-dump even when the
    //    shared secret is unset, without breaking on-box loopback callers.
    if (isPublicHost) {
      res.writeHead(403, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "forbidden" }));
    }
    // 2. Endpoints that expose live tokens + client IPs fail CLOSED: with no
    //    secret configured they are disabled entirely, never open to loopback.
    if (pathname === "/internal/connected-tokens" || pathname === "/internal/traffic-stats") {
      if (!INTERNAL_SECRET) {
        res.writeHead(503, { "Content-Type": "application/json" });
        return res.end(
          JSON.stringify({ error: "internal endpoints disabled: RELAY_INTERNAL_SECRET not set" })
        );
      }
      if (!internalSecretMatches(req)) {
        res.writeHead(403, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "forbidden" }));
      }
    } else if (INTERNAL_SECRET && !internalSecretMatches(req)) {
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
          wsSessions: wsSessions.size,
        },
        byToken,
        byAlias,
      })
    );
  }

  const url = new URL(req.url, `http://${host || "localhost"}`);

  // Friendly health endpoint — only for non-public hosts, so operational stats
  // aren't exposed through the public token/alias ingress.
  if (url.pathname === "/health" && !isPublicHost) {
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
        sendOffline(req, res, 404, "Alias not found or inactive", {
          mark: "missing",
          title: "Nothing here",
          detail: "This name is not attached to a live share.",
          hint: "Share localhost from the CLI, or check the alias under Sharing.",
        });
        return;
      }
    } else {
      sendOffline(
        req,
        res,
        404,
        `Invalid host. Expected <token>.${TUNNEL_DOMAIN} or <alias>.${ALIAS_DOMAIN}`,
        {
          mark: "missing",
          title: "Nothing here",
          detail: "This hostname is not a valid Uplink share.",
          hint: `Use a link like token.${TUNNEL_DOMAIN} or alias.${ALIAS_DOMAIN}.`,
        }
      );
      return;
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
    sendOffline(req, res, 502, "Tunnel not connected", {
      mark: "tunnel",
      title: "Tunnel not connected",
      detail: "This share is live, but nothing is attached on the other side yet.",
      hint: "From the CLI: Sharing → Share localhost",
    });
    return;
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
    headers: stripHopByHop(req.headers),
    body: body.length ? body.toString("base64") : "",
  };
  
  try {
    clientData.socket.write(JSON.stringify(msg) + "\n");
  } catch (err) {
    logError(err, "Failed to send request to client");
    pending.delete(id);
    sendOffline(req, res, 502, "Failed to forward request", {
      mark: "tunnel",
      title: "Tunnel not connected",
      detail: "The relay could not reach the local client for this share.",
      hint: "Re-run Sharing → Share localhost, then refresh.",
    });
    return;
  }

  // Timeout applies only until the response starts streaming
  const timer = setTimeout(() => {
    const entry = pending.get(id);
    if (entry && !entry.started) {
      pending.delete(id);
      sendOffline(req, res, 504, "Gateway timeout", {
        mark: "tunnel",
        title: "Share timed out",
        detail: "The local process did not answer in time. It may not be listening, or the tunnel client stalled.",
        hint: "Confirm the port is serving, then share again.",
      });
    }
  }, 30000);

  res.on("close", () => {
    clearTimeout(timer);
    pending.delete(id);
  });
});

// WebSocket / HTTP Upgrade passthrough.
// The relay reconstructs the raw upgrade request and streams bytes in both
// directions over the control channel (ws-open / ws-data / ws-close), making
// the session a transparent TCP passthrough after the handshake. This is what
// allows things like Next.js HMR websockets to work through the tunnel.
httpServer.on("upgrade", async (req, socket, head) => {
  stats.requests++;
  const host = req.headers.host || "";

  let token = extractTokenFromHost(host);
  let aliasKey = null;
  if (!token) {
    const alias = extractAliasFromHost(host);
    if (alias) {
      aliasKey = alias;
      token = await resolveAliasToToken(alias);
    }
  }
  if (!token) {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }

  if (!checkRateLimit(token)) {
    socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }

  const clientData = clients.get(token);
  if (!clientData) {
    socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }

  const id = randomUUID();

  // Reconstruct the raw HTTP upgrade request so the local server sees the
  // exact handshake the browser sent (rawHeaders preserves casing and order).
  const headerLines = [];
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    headerLines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
  }
  const rawHead = `${req.method} ${req.url} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`;

  wsSessions.set(id, { socket, token });

  const tTok = getTraffic(trafficByToken, token);
  if (tTok) {
    tTok.requests += 1;
    tTok.lastSeenAt = Date.now();
  }
  const tAli = getTraffic(trafficByAlias, aliasKey);
  if (tAli) {
    tAli.requests += 1;
    tAli.lastSeenAt = Date.now();
  }

  try {
    clientData.socket.write(
      JSON.stringify({
        type: "ws-open",
        id,
        head: Buffer.concat([Buffer.from(rawHead), head]).toString("base64"),
      }) + "\n"
    );
  } catch (err) {
    logError(err, "Failed to open ws session");
    wsSessions.delete(id);
    return socket.destroy();
  }

  socket.on("data", (data) => {
    if (!wsSessions.has(id)) return;
    const t = getTraffic(trafficByToken, token);
    if (t) {
      t.bytesIn += data.length;
      t.lastSeenAt = Date.now();
    }
    try {
      clientData.socket.write(
        JSON.stringify({ type: "ws-data", id, data: data.toString("base64") }) + "\n"
      );
    } catch {
      socket.destroy();
    }
  });

  const closeSession = () => {
    if (!wsSessions.has(id)) return;
    wsSessions.delete(id);
    try {
      clientData.socket.write(JSON.stringify({ type: "ws-close", id }) + "\n");
    } catch {
      /* control channel gone; client-side cleanup handles it */
    }
  };
  socket.on("close", closeSession);
  socket.on("error", closeSession);

  socket.setKeepAlive(true, 15000);
  socket.setNoDelay(true);
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

// NOTE: /health is served by the main request handler above (gated on a
// non-public host). A second "request" listener here would double-respond and
// leaked stats via the alias domain, so it has been removed.

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

