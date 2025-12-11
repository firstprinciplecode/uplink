#!/usr/bin/env node
/**
 * Minimal stub control-plane API for local smoke testing.
 * No persistence, no external deps; uses Node's http module.
 * Auth: Bearer <token> matching AGENTCLOUD_TOKEN_DEV (default: dev-token).
 */

const http = require("http");
const { randomUUID } = require("crypto");
const url = require("url");

const PORT = process.env.PORT || 4000;
const AUTH_TOKEN = process.env.AGENTCLOUD_TOKEN_DEV || "dev-token";
const TUNNEL_DOMAIN = process.env.TUNNEL_DOMAIN || "dev.uplink.spot";
const USE_HOST_ROUTING = process.env.TUNNEL_USE_HOST !== "false"; // Default to host-based

/** @type {Array<any>} */
const dbs = [];

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function unauthorized(res) {
  send(res, 401, { error: { code: "UNAUTHORIZED", message: "Missing or invalid token" } });
}

function notFound(res, msg, details = {}) {
  send(res, 404, { error: { code: "NOT_FOUND", message: msg, details } });
}

function invalid(res, msg, details = {}) {
  send(res, 400, { error: { code: "INVALID_INPUT", message: msg, details } });
}

function conflict(res, code, msg, details = {}) {
  send(res, 409, { error: { code, message: msg, details } });
}

function methodNotAllowed(res) {
  send(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed" } });
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
  });
}

function authOk(req) {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) return false;
  const token = auth.slice("Bearer ".length);
  return token === AUTH_TOKEN;
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname || "";
  const method = req.method || "GET";

  // Health check (no auth required)
  if (path === "/health" && method === "GET") {
    return send(res, 200, { status: "ok" });
  }

  // Auth check
  if (!authOk(req)) {
    return unauthorized(res);
  }

  // Routes
  if (path === "/v1/tunnels" && method === "POST") {
    let body;
    try {
      body = await parseBody(req);
    } catch {
      return invalid(res, "Invalid JSON body");
    }
    const targetPort = body?.port || body?.targetPort;
    if (!targetPort) {
      return invalid(res, "port is required");
    }
    const id = `tun_${randomUUID()}`;
    const token = randomUUID().replace(/-/g, "").slice(0, 12); // Shorter token for subdomain
    const urlStr = USE_HOST_ROUTING
      ? `https://${token}.${TUNNEL_DOMAIN}`
      : `http://127.0.0.1:7070/t/${token}`;
    const record = { id, token, url: urlStr, targetPort };
    // In-memory only for stub
    dbs.push({ ...record, kind: "tunnel" });
    return send(res, 201, record);
  }

  if (path.startsWith("/v1/tunnels/") && method === "DELETE") {
    const id = path.split("/")[3];
    const idx = dbs.findIndex((d) => d.id === id && d.kind === "tunnel");
    if (idx === -1) return notFound(res, "Tunnel not found", { id });
    dbs.splice(idx, 1);
    return send(res, 200, { id, status: "deleted" });
  }

  if (path === "/v1/dbs" && method === "POST") {
    let body;
    try {
      body = await parseBody(req);
    } catch {
      return invalid(res, "Invalid JSON body");
    }
    const { name, project, provider = "neon", region = "eu-central-1", plan = "dev" } = body || {};
    if (!name || !project) {
      return invalid(res, "name and project are required");
    }
    if (dbs.find((d) => d.project === project && d.name === name && d.status !== "deleted")) {
      return conflict(res, "DB_NAME_TAKEN", "Database name already exists in project", {
        project,
        name,
      });
    }
    const id = `db_${randomUUID()}`;
    const now = new Date().toISOString();
    const record = {
      id,
      name,
      project,
      provider,
      engine: "postgres",
      version: "16",
      region,
      status: "ready",
      ready: true,
      host: "localhost",
      port: 5432,
      database: `${name}_db`,
      user: `${name}_user`,
      createdAt: now,
      updatedAt: now,
      connection: {
        host: "localhost",
        port: 5432,
        database: `${name}_db`,
        user: `${name}_user`,
        ssl: true,
        connectionStrings: {
          direct: `postgres://${name}_user:******@localhost:5432/${name}_db?sslmode=require`,
          pooled: `postgres://${name}_user:******@localhost:5432/${name}_db?sslmode=require`,
        },
      },
    };
    dbs.push(record);
    return send(res, 201, record);
  }

  if (path === "/v1/dbs" && method === "GET") {
    const project = parsed.query.project;
    const items = dbs
      .filter((d) => d.status !== "deleted")
      .filter((d) => (!project ? true : d.project === project))
      .map((d) => ({
        id: d.id,
        name: d.name,
        project: d.project,
        provider: d.provider,
        engine: d.engine,
        region: d.region,
        status: d.status,
        ready: d.status === "ready",
        createdAt: d.createdAt,
      }));
    return send(res, 200, { items });
  }

  if (path.startsWith("/v1/dbs/") && !path.endsWith("/link-service")) {
    const id = path.split("/")[3];
    if (method === "GET") {
      const db = dbs.find((d) => d.id === id);
      if (!db) return notFound(res, "Database not found", { id });
      return send(res, 200, db);
    }
    if (method === "DELETE") {
      const db = dbs.find((d) => d.id === id);
      if (!db) return notFound(res, "Database not found", { id });
      db.status = "deleted";
      db.ready = false;
      db.updatedAt = new Date().toISOString();
      return send(res, 200, { id, status: "deleted" });
    }
    return methodNotAllowed(res);
  }

  if (path.endsWith("/link-service") && method === "POST") {
    const id = path.split("/")[3];
    const db = dbs.find((d) => d.id === id);
    if (!db) return notFound(res, "Database not found", { id });
    let body;
    try {
      body = await parseBody(req);
    } catch {
      return invalid(res, "Invalid JSON body");
    }
    const { service, envVar } = body || {};
    if (!service || !envVar) {
      return invalid(res, "service and envVar are required");
    }
    return send(res, 200, {
      service,
      envVar,
      dbId: id,
      status: "linked",
    });
  }

  return methodNotAllowed(res);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Stub control-plane API listening on 127.0.0.1:${PORT}`);
  console.log(`Auth token: ${AUTH_TOKEN}`);
});

