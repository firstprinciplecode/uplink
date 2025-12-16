#!/usr/bin/env node
/**
 * Tunnel relay with host-based routing (production-ready).
 * Routes by Host header: <token>.dev.uplink.spot -> token
 * - Ingress HTTP: LISTEN_HTTP (default 7070)
 * - Control channel: LISTEN_CTRL (default 7071)
 */

const http = require("http");
const net = require("net");
const { randomUUID } = require("crypto");

const LISTEN_HTTP = Number(process.env.TUNNEL_RELAY_HTTP || 7070);
const LISTEN_CTRL = Number(process.env.TUNNEL_RELAY_CTRL || 7071);
const TUNNEL_DOMAIN = process.env.TUNNEL_DOMAIN || "dev.uplink.spot";

// token -> client socket
const clients = new Map();
// requestId -> http response
const pending = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

// Extract token from Host header: abc123.dev.uplink.spot -> abc123
function extractTokenFromHost(host) {
  if (!host) return null;
  const parts = host.split(".");
  if (parts.length < 3) return null;
  // Assume format: <token>.dev.uplink.spot
  const token = parts[0];
  const domain = parts.slice(1).join(".");
  if (domain === TUNNEL_DOMAIN || domain.endsWith(`.${TUNNEL_DOMAIN}`)) {
    return token;
  }
  return null;
}

// Control server: clients connect and register their token/port
const ctrlServer = net.createServer((socket) => {
  let buf = "";

  socket.on("data", (chunk) => {
    buf += chunk.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.type === "register" && msg.token) {
          clients.set(msg.token, socket);
          socket.token = msg.token;
          log("registered client", msg.token, "port", msg.targetPort);
          socket.write(JSON.stringify({ type: "registered" }) + "\n");
        } else if (msg.type === "response" && msg.id) {
          const res = pending.get(msg.id);
          if (!res) return;
          pending.delete(msg.id);
          const body = msg.body ? Buffer.from(msg.body, "base64") : Buffer.alloc(0);
          // set headers
          Object.entries(msg.headers || {}).forEach(([k, v]) => {
            try {
              res.setHeader(k, v);
            } catch {
              /* ignore bad headers */
            }
          });
          res.statusCode = msg.status || 502;
          res.end(body);
        }
      } catch (err) {
        log("ctrl parse error", err);
      }
    }
  });

  socket.on("close", () => {
    if (socket.token) {
      clients.delete(socket.token);
      log("client disconnected", socket.token);
    }
  });

  socket.on("error", (err) => {
    log("ctrl socket error", err.message);
  });
});

ctrlServer.listen(LISTEN_CTRL, "0.0.0.0", () => {
  log(`Tunnel control listening on ${LISTEN_CTRL}`);
});

// HTTP ingress -> forward to client (host-based routing)
const httpServer = http.createServer(async (req, res) => {
  const host = req.headers.host;
  const token = extractTokenFromHost(host);
  
  if (!token) {
    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain");
    return res.end(`Invalid host. Expected format: <token>.${TUNNEL_DOMAIN}`);
  }

  const client = clients.get(token);
  if (!client) {
    res.statusCode = 502;
    res.setHeader("Content-Type", "text/plain");
    return res.end("tunnel not connected");
  }

  const url = new URL(req.url, `http://${host}`);
  const path = url.pathname + (url.search || "");

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
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
  client.write(JSON.stringify(msg) + "\n");

  // timeout
  const timer = setTimeout(() => {
    if (pending.has(id)) {
      pending.delete(id);
      res.statusCode = 504;
      res.end("upstream timeout");
    }
  }, 30000);

  res.on("close", () => clearTimeout(timer));
});

httpServer.listen(LISTEN_HTTP, "0.0.0.0", () => {
  log(`Tunnel ingress listening on ${LISTEN_HTTP}`);
  log(`Domain: ${TUNNEL_DOMAIN}`);
  log(`Expected format: <token>.${TUNNEL_DOMAIN}`);
});

httpServer.on("error", (err) => log("http error", err.message));




