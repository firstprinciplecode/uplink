#!/usr/bin/env node
/**
 * Minimal tunnel relay (ngrok-lite) for local testing.
 * - Ingress HTTP: LISTEN_HTTP (default 7070)
 * - Control channel (client connections): LISTEN_CTRL (default 7071)
 * - Status API: LISTEN_STATUS (default 7072) - shows connected tunnels with IPs
 * Protocol: newline-delimited JSON messages.
 */

const http = require("http");
const net = require("net");
const { randomUUID } = require("crypto");

const LISTEN_HTTP = Number(process.env.TUNNEL_RELAY_HTTP || 7070);
const LISTEN_CTRL = Number(process.env.TUNNEL_RELAY_CTRL || 7071);
const LISTEN_STATUS = Number(process.env.TUNNEL_RELAY_STATUS || 7072);

// token -> { socket, clientIp, targetPort, connectedAt }
const clients = new Map();
// requestId -> http response
const pending = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
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

// Control server: clients connect and register their token/port
const ctrlServer = net.createServer((socket) => {
  let buf = "";
  const clientIp = getClientIp(socket);

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
          // Store client with metadata
          clients.set(msg.token, {
            socket,
            clientIp,
            targetPort: msg.targetPort || 0,
            connectedAt: new Date().toISOString(),
          });
          socket.token = msg.token;
          log("registered client", msg.token, "port", msg.targetPort, "ip", clientIp);
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
      const client = clients.get(socket.token);
      clients.delete(socket.token);
      log("client disconnected", socket.token, "ip", client?.clientIp || "unknown");
    }
  });

  socket.on("error", (err) => {
    log("ctrl socket error", err.message);
  });
});

ctrlServer.listen(LISTEN_CTRL, "0.0.0.0", () => {
  log(`Tunnel control listening on ${LISTEN_CTRL}`);
});

// HTTP ingress -> forward to client
const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "t" || !parts[1]) {
    res.statusCode = 404;
    return res.end("not found");
  }
  const token = parts[1];
  const path = "/" + parts.slice(2).join("/") + (url.search || "");
  const clientData = clients.get(token);
  if (!clientData) {
    res.statusCode = 502;
    return res.end("tunnel not connected");
  }

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
  clientData.socket.write(JSON.stringify(msg) + "\n");

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
});

httpServer.on("error", (err) => log("http error", err.message));

// Status API server - shows connected tunnels with IPs
const statusServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  
  // CORS headers for browser access
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "application/json");
  
  if (req.method === "OPTIONS") {
    res.statusCode = 204;
    return res.end();
  }
  
  if (url.pathname === "/status" || url.pathname === "/") {
    const tunnels = [];
    for (const [token, data] of clients.entries()) {
      tunnels.push({
        token,
        clientIp: data.clientIp,
        targetPort: data.targetPort,
        connectedAt: data.connectedAt,
        connectedFor: getTimeSince(data.connectedAt),
      });
    }
    
    return res.end(JSON.stringify({
      status: "ok",
      connectedTunnels: tunnels.length,
      tunnels,
      timestamp: new Date().toISOString(),
    }, null, 2));
  }
  
  // Get specific tunnel by token
  if (url.pathname.startsWith("/tunnel/")) {
    const token = url.pathname.slice(8);
    const data = clients.get(token);
    if (!data) {
      res.statusCode = 404;
      return res.end(JSON.stringify({ error: "tunnel not found" }));
    }
    return res.end(JSON.stringify({
      token,
      clientIp: data.clientIp,
      targetPort: data.targetPort,
      connectedAt: data.connectedAt,
      connectedFor: getTimeSince(data.connectedAt),
    }, null, 2));
  }
  
  res.statusCode = 404;
  res.end(JSON.stringify({ error: "not found" }));
});

function getTimeSince(isoDate) {
  const seconds = Math.floor((Date.now() - new Date(isoDate).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${mins}m`;
}

statusServer.listen(LISTEN_STATUS, "127.0.0.1", () => {
  log(`Tunnel status API listening on ${LISTEN_STATUS} (localhost only)`);
});

statusServer.on("error", (err) => log("status server error", err.message));





