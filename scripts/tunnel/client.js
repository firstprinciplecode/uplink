#!/usr/bin/env node
/**
 * Minimal tunnel client for local testing.
 * Connects to control server, receives HTTP requests, proxies to localhost:port.
 * Usage: node scripts/tunnel/client.js --token <token> --port 3000 --ctrl 127.0.0.1:7071
 */

const net = require("net");
const http = require("http");

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--token") out.token = args[++i];
    else if (a === "--port") out.port = Number(args[++i]);
    else if (a === "--ctrl") out.ctrl = args[++i];
  }
  return out;
}

const { token, port, ctrl } = parseArgs();
if (!token || !port || !ctrl) {
  console.error("Usage: node scripts/tunnel/client.js --token <token> --port <port> --ctrl <host:port>");
  process.exit(1);
}

const [CTRL_HOST, CTRL_PORT] = ctrl.split(":");

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

const socket = net.createConnection({ host: CTRL_HOST, port: Number(CTRL_PORT) }, () => {
  log("connected to relay ctrl");
  socket.write(
    JSON.stringify({ type: "register", token, targetPort: port }) + "\n"
  );
});

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
      if (msg.type === "request") {
        handleRequest(msg);
      } else if (msg.type === "registered") {
        log("registered with relay");
      }
    } catch (err) {
      log("client parse error", err.message);
    }
  }
});

socket.on("error", (err) => {
  log("ctrl connection error", err.message);
  process.exit(1);
});

socket.on("close", () => {
  log("ctrl connection closed");
  process.exit(1);
});

function handleRequest(msg) {
  const options = {
    hostname: "127.0.0.1",
    port,
    path: msg.path || "/",
    method: msg.method || "GET",
    headers: msg.headers || {},
  };

  const req = http.request(options, (resp) => {
    const chunks = [];
    resp.on("data", (d) => chunks.push(d));
    resp.on("end", () => {
      const body = Buffer.concat(chunks);
      const resMsg = {
        type: "response",
        id: msg.id,
        status: resp.statusCode,
        headers: resp.headers,
        body: body.length ? body.toString("base64") : "",
      };
      socket.write(JSON.stringify(resMsg) + "\n");
    });
  });

  req.on("error", (err) => {
    const resMsg = {
      type: "response",
      id: msg.id,
      status: 502,
      headers: { "x-tunnel-error": err.message },
      body: "",
    };
    socket.write(JSON.stringify(resMsg) + "\n");
  });

  if (msg.body) {
    req.write(Buffer.from(msg.body, "base64"));
  }
  req.end();
}




