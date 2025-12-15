#!/usr/bin/env node
/**
 * Minimal tunnel relay (ngrok-lite) for local testing.
 * - Ingress HTTP: LISTEN_HTTP (default 7070)
 * - Control channel (client connections): LISTEN_CTRL (default 7071)
 * Protocol: newline-delimited JSON messages.
 */

const http = require("http");
const net = require("net");
const { randomUUID } = require("crypto");

const LISTEN_HTTP = Number(process.env.TUNNEL_RELAY_HTTP || 7070);
const LISTEN_CTRL = Number(process.env.TUNNEL_RELAY_CTRL || 7071);

// token -> client socket
const clients = new Map();
// requestId -> http response
const pending = new Map();

function log(...args) {
  console.log(new Date().toISOString(), ...args);
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
  const client = clients.get(token);
  if (!client) {
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
});

httpServer.on("error", (err) => log("http error", err.message));



