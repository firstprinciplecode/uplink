#!/usr/bin/env node
/**
 * Improved tunnel client with auto-reconnect, better error handling, and health checks.
 * Usage: TUNNEL_TOKEN=<token> node scripts/tunnel/client-improved.js --port 3000 --ctrl tunnel.uplink.spot:7443
 */

const net = require("net");
const tls = require("tls");
const http = require("http");
const fs = require("fs");

// Configuration
const MAX_RECONNECT_DELAY = 30000; // 30 seconds max
const INITIAL_RECONNECT_DELAY = 1000; // Start with 1 second
const MAX_REQUEST_SIZE = 10 * 1024 * 1024; // 10MB max request body
const HEALTH_CHECK_INTERVAL = 30000; // Check local service every 30s
const REQUEST_TIMEOUT = 30000; // 30s timeout for local requests

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--token") {
      // Refuse argv tokens: argv is world-readable via `ps`. Env only.
      console.error("--token is no longer supported; pass the token via the TUNNEL_TOKEN env var.");
      process.exit(1);
    } else if (a === "--port") out.port = Number(args[++i]);
    else if (a === "--ctrl") out.ctrl = args[++i];
    else if (a === "--max-size") out.maxSize = Number(args[++i]);
  }
  return out;
}

const parsed = parseArgs();
// The token comes from the environment so it never appears on argv (which is
// world-readable via `ps`).
const token = process.env.TUNNEL_TOKEN;
const { port, ctrl, maxSize } = parsed;
if (!token || !port || !ctrl) {
  console.error("Usage: TUNNEL_TOKEN=<token> node scripts/tunnel/client-improved.js --port <port> --ctrl <host:port> [--max-size <bytes>]");
  process.exit(1);
}

const [CTRL_HOST, CTRL_PORT] = ctrl.split(":");
const MAX_BODY_SIZE = maxSize || MAX_REQUEST_SIZE;
// TLS is the default for any non-loopback relay; the token and all proxied
// traffic cross this channel. Set TUNNEL_CTRL_TLS=false only for local dev.
const CTRL_HOST_IS_LOOPBACK = ["localhost", "127.0.0.1", "::1"].includes(CTRL_HOST);
const CTRL_TLS_ENABLED = process.env.TUNNEL_CTRL_TLS
  ? process.env.TUNNEL_CTRL_TLS === "true"
  : !CTRL_HOST_IS_LOOPBACK;
const CTRL_TLS_INSECURE = process.env.TUNNEL_CTRL_TLS_INSECURE === "true";
const CTRL_TLS_CA_PATH = process.env.TUNNEL_CTRL_CA || "";
const CTRL_TLS_CERT_PATH = process.env.TUNNEL_CTRL_CERT || "";
const CTRL_TLS_KEY_PATH = process.env.TUNNEL_CTRL_KEY || "";

function optionalRead(path) {
  if (!path) return undefined;
  try {
    return fs.readFileSync(path);
  } catch {
    log("warn", `Could not read TLS file: ${path}`);
    return undefined;
  }
}

// State
let socket = null;
// wsId -> net.Socket — active WebSocket (upgrade) passthrough sessions to the local service
const wsSessions = new Map();
let reconnectDelay = INITIAL_RECONNECT_DELAY;
let reconnectTimer = null;
let isConnected = false;
let isRegistered = false;
let shuttingDown = false;
let healthCheckTimer = null;
let lastHealthTimeoutLog = 0;
let stats = {
  requests: 0,
  errors: 0,
  reconnects: 0,
  startTime: Date.now(),
};

function log(level, ...args) {
  const prefix = {
    info: "ℹ️",
    error: "❌",
    warn: "⚠️",
    success: "✅",
  }[level] || "•";
  console.log(`${new Date().toISOString()} ${prefix}`, ...args);
}

function logError(err, context) {
  const message = err.message || String(err);
  const code = err.code || "";
  log("error", context, message, code ? `(${code})` : "");
  
  // Provide helpful error messages
  if (code === "ECONNREFUSED") {
    log("info", `Cannot connect to relay at ${CTRL_HOST}:${CTRL_PORT}. Is the relay running?`);
  } else if (code === "ETIMEDOUT") {
    log("info", `Connection timeout. Check network connectivity and firewall rules.`);
  } else if (code === "ENOTFOUND") {
    log("info", `Cannot resolve hostname "${CTRL_HOST}". Check DNS settings.`);
  }
}

function checkLocalService() {
  // Allow disabling the health check if it is noisy or not needed
  if ((process.env.TUNNEL_HEALTH_CHECK_DISABLE || "").toLowerCase() === "true") {
    return;
  }

  const timeoutMs = Number(process.env.TUNNEL_HEALTH_CHECK_TIMEOUT_MS || 2000);
  const options = {
    hostname: "127.0.0.1",
    port,
    path: "/",
    method: "HEAD",
    timeout: timeoutMs,
  };

  const req = http.request(options, (res) => {
    if (res.statusCode >= 200 && res.statusCode < 500) {
      // Service is responding
      return;
    }
    log("warn", `Local service returned status ${res.statusCode}. Is it running correctly?`);
  });

  req.on("error", (err) => {
    if (err.code === "ECONNREFUSED") {
      log("error", `Local service on port ${port} is not responding. Is your app running?`);
    } else {
      log("warn", `Health check failed: ${err.message}`);
    }
  });

  req.on("timeout", () => {
    req.destroy();
    // Rate-limit timeout warnings to avoid log spam
    const now = Date.now();
    if (now - lastHealthTimeoutLog > 60_000) {
      lastHealthTimeoutLog = now;
      log("warn", `Health check timeout. Local service may be slow or unresponsive.`);
    }
  });

  req.end();
}

function connect() {
  if (shuttingDown) return;
  if (socket && !socket.destroyed) {
    socket.destroy();
  }

  log("info", `Connecting to relay at ${CTRL_HOST}:${CTRL_PORT}... ${CTRL_TLS_ENABLED ? "(TLS)" : "(plain)"}`);

  if (CTRL_TLS_ENABLED) {
    const ca = optionalRead(CTRL_TLS_CA_PATH);
    const cert = optionalRead(CTRL_TLS_CERT_PATH);
    const key = optionalRead(CTRL_TLS_KEY_PATH);
    const options = {
      host: CTRL_HOST,
      port: Number(CTRL_PORT),
      ca: ca ? [ca] : undefined,
      cert,
      key,
      rejectUnauthorized: !CTRL_TLS_INSECURE,
      servername: CTRL_HOST,
    };
    socket = tls.connect(options, () => {
      isConnected = true;
      reconnectDelay = INITIAL_RECONNECT_DELAY;
      log("success", "Connected to relay (TLS)");
      socket.setKeepAlive(true, 15000);
      socket.write(JSON.stringify({ type: "register", token, targetPort: port }) + "\n");
    });
  } else {
    socket = net.createConnection({ host: CTRL_HOST, port: Number(CTRL_PORT) }, () => {
      isConnected = true;
      reconnectDelay = INITIAL_RECONNECT_DELAY; // Reset delay on successful connection
      log("success", "Connected to relay");
      socket.setKeepAlive(true, 15000);
      
      // Register with relay
      socket.write(
        JSON.stringify({ type: "register", token, targetPort: port }) + "\n"
      );
    });
  }

  let buf = "";
  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      
      // Check message size
      if (line.length > MAX_BODY_SIZE) {
        log("error", `Message too large: ${line.length} bytes (max: ${MAX_BODY_SIZE})`);
        continue;
      }
      
      try {
        const msg = JSON.parse(line);
        if (msg.type === "request") {
          handleRequest(msg);
        } else if (msg.type === "ws-open") {
          handleWsOpen(msg);
        } else if (msg.type === "ws-data") {
          const local = wsSessions.get(msg.id);
          if (local && !local.destroyed) {
            local.write(Buffer.from(msg.data || "", "base64"));
          }
        } else if (msg.type === "ws-close") {
          const local = wsSessions.get(msg.id);
          wsSessions.delete(msg.id);
          if (local && !local.destroyed) local.end();
        } else if (msg.type === "registered") {
          isRegistered = true;
          log("success", `Registered with relay (token: ${token.substring(0, 8)}...)`);
          stats.reconnects = 0; // Reset reconnect count on successful registration
        } else if (msg.type === "error") {
          log("error", "Relay error:", msg.message || "Unknown error");
          if (/invalid token/i.test(String(msg.message || ""))) {
            log("error", "Token rejected by relay; exiting");
            shutdown(1);
          }
        }
      } catch (err) {
        log("error", "Parse error:", err.message, `(message length: ${line.length})`);
      }
    }
  });

  socket.on("error", (err) => {
    isConnected = false;
    isRegistered = false;
    closeAllWsSessions();
    logError(err, "Connection error");
    if (!shuttingDown) scheduleReconnect();
  });

  socket.on("close", () => {
    const wasRegistered = isRegistered;
    isConnected = false;
    isRegistered = false;
    closeAllWsSessions();

    if (shuttingDown) return;
    if (wasRegistered) {
      log("warn", "Connection closed. Attempting to reconnect...");
      scheduleReconnect();
    } else {
      log("warn", "Connection closed before registration");
    }
  });
}

function scheduleReconnect() {
  if (shuttingDown) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }

  stats.reconnects++;
  const delay = Math.min(reconnectDelay, MAX_RECONNECT_DELAY);
  
  log("info", `Reconnecting in ${delay / 1000}s (attempt ${stats.reconnects})...`);
  
  reconnectTimer = setTimeout(() => {
    reconnectDelay *= 2; // Exponential backoff
    connect();
  }, delay);
}

function handleRequest(msg) {
  stats.requests++;
  
  // Validate request
  if (!msg.id) {
    log("error", "Received request without ID");
    return;
  }

  // Check body size
  if (msg.body) {
    const bodySize = Buffer.from(msg.body, "base64").length;
    if (bodySize > MAX_BODY_SIZE) {
      log("error", `Request body too large: ${bodySize} bytes (max: ${MAX_BODY_SIZE})`);
      sendErrorResponse(msg.id, 413, "Request entity too large");
      return;
    }
  }

  // Clean headers - remove hop-by-hop headers and undefined values
  const cleanHeaders = { ...msg.headers };
  delete cleanHeaders.connection;
  delete cleanHeaders["keep-alive"];
  delete cleanHeaders["transfer-encoding"];
  // Remove any undefined values
  Object.keys(cleanHeaders).forEach(key => {
    if (cleanHeaders[key] === undefined) {
      delete cleanHeaders[key];
    }
  });

  const options = {
    hostname: "127.0.0.1",
    port,
    path: msg.path || "/",
    method: msg.method || "GET",
    headers: cleanHeaders,
    timeout: REQUEST_TIMEOUT,
  };
  log("info", `Local ${options.method} ${options.path} host=${cleanHeaders.host || cleanHeaders.Host || "-"}`);

  const req = http.request(options, (resp) => {
    // Stream the response over the control channel instead of buffering it.
    // This removes the response size cap (needed e.g. for large dev-mode JS
    // chunks) and keeps memory usage flat regardless of response size.
    let aborted = false;
    const send = (obj) => {
      if (!socket || socket.destroyed || !isRegistered) {
        aborted = true;
        resp.destroy();
        return false;
      }
      return socket.write(JSON.stringify(obj) + "\n");
    };

    send({
      type: "response-head",
      id: msg.id,
      status: resp.statusCode,
      headers: resp.headers,
    });

    resp.on("data", (d) => {
      if (aborted) return;
      const ok = send({ type: "response-chunk", id: msg.id, data: d.toString("base64") });
      // Backpressure: pause the local response while the control socket drains
      if (ok === false && socket && !socket.destroyed) {
        resp.pause();
        socket.once("drain", () => resp.resume());
      }
    });

    resp.on("end", () => {
      if (!aborted) send({ type: "response-end", id: msg.id });
    });

    resp.on("error", () => {
      if (!aborted) send({ type: "response-end", id: msg.id });
    });
  });

  req.on("error", (err) => {
    stats.errors++;
    logError(err, "Local request error");
    
    const errorMsg = err.code === "ECONNREFUSED"
      ? "Local service not available"
      : err.message;
    
    sendErrorResponse(msg.id, 502, errorMsg);
  });

  req.on("timeout", () => {
    req.destroy();
    stats.errors++;
    log("error", `Request timeout after ${REQUEST_TIMEOUT}ms`);
    sendErrorResponse(msg.id, 504, "Gateway timeout");
  });

  if (msg.body) {
    try {
      req.write(Buffer.from(msg.body, "base64"));
    } catch (err) {
      log("error", "Error writing request body:", err.message);
      sendErrorResponse(msg.id, 400, "Invalid request body");
      return;
    }
  }
  
  req.end();
}

// WebSocket / HTTP Upgrade passthrough: open a raw TCP connection to the
// local service, replay the original handshake bytes, then stream data in
// both directions over the control channel until either side closes.
function handleWsOpen(msg) {
  if (!msg.id || !msg.head) return;
  stats.requests++;

  const local = net.createConnection({ host: "127.0.0.1", port }, () => {
    local.write(Buffer.from(msg.head, "base64"));
  });
  local.setNoDelay(true);
  wsSessions.set(msg.id, local);

  local.on("data", (data) => {
    if (!socket || socket.destroyed || !isRegistered) return;
    try {
      socket.write(
        JSON.stringify({ type: "ws-data", id: msg.id, data: data.toString("base64") }) + "\n"
      );
    } catch {
      local.destroy();
    }
  });

  const closeSession = () => {
    if (!wsSessions.has(msg.id)) return;
    wsSessions.delete(msg.id);
    if (socket && !socket.destroyed && isRegistered) {
      try {
        socket.write(JSON.stringify({ type: "ws-close", id: msg.id }) + "\n");
      } catch {
        /* control channel gone */
      }
    }
  };
  local.on("close", closeSession);
  local.on("error", (err) => {
    stats.errors++;
    logError(err, "Local ws connection error");
    closeSession();
  });
}

function closeAllWsSessions() {
  for (const [, local] of wsSessions.entries()) {
    if (!local.destroyed) local.destroy();
  }
  wsSessions.clear();
}

function sendErrorResponse(id, status, message) {
  if (!socket || socket.destroyed || !isRegistered) {
    return;
  }
  
  const resMsg = {
    type: "response",
    id,
    status,
    headers: { "content-type": "text/plain" },
    body: Buffer.from(message).toString("base64"),
  };
  
  try {
    socket.write(JSON.stringify(resMsg) + "\n");
  } catch (err) {
    log("error", "Failed to send error response:", err.message);
  }
}

// Graceful shutdown
function shutdown(exitCode = 0) {
  if (shuttingDown) {
    process.exit(exitCode);
    return;
  }
  shuttingDown = true;
  log("info", "Shutting down...");

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (healthCheckTimer) {
    clearInterval(healthCheckTimer);
    healthCheckTimer = null;
  }

  closeAllWsSessions();

  if (socket && !socket.destroyed) {
    socket.removeAllListeners("close");
    socket.removeAllListeners("error");
    socket.destroy();
  }

  const uptime = Math.floor((Date.now() - stats.startTime) / 1000);
  log("info", `Stats: ${stats.requests} requests, ${stats.errors} errors, ${stats.reconnects} reconnects, ${uptime}s uptime`);

  process.exit(exitCode);
}

// Start connection
connect();

// Start health checks
healthCheckTimer = setInterval(checkLocalService, HEALTH_CHECK_INTERVAL);
checkLocalService(); // Immediate check

// Handle shutdown signals
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// Print connection info
log("info", `Tunnel client starting`);
log("info", `Token: ${token.substring(0, 8)}...`);
log("info", `Local port: ${port}`);
log("info", `Relay: ${CTRL_HOST}:${CTRL_PORT}`);
log("info", `Max request size: ${MAX_BODY_SIZE / 1024 / 1024}MB`);

