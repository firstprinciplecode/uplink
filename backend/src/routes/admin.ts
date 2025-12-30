import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { makeError } from "../schemas/error";
import http from "http";
import { randomUUID, randomBytes } from "crypto";
import { hashToken, tokenPrefix } from "../utils/token-hash";
import { validateBody, validateQuery } from "../middleware/validate";
import { createTokenSchema, revokeTokenSchema, listQuerySchema } from "../schemas/validation";
import { tokenCreationRateLimiter } from "../middleware/rate-limit";
import { logger, auditLog } from "../utils/logger";

export const adminRouter = Router();

function requireAdmin(user?: { id: string; role?: string }) {
  return user && user.role === "admin";
}

type RelayTrafficStatsResponse = {
  relayRunId: string;
  since: string;
  timestamp: string;
  totals?: {
    tokensTracked: number;
    aliasesTracked: number;
    connected: number;
    pending: number;
  };
  byAlias: Array<{
    alias: string;
    requests: number;
    responses: number;
    bytesIn: number;
    bytesOut: number;
    lastSeenAt: number | null;
    lastStatus: number | null;
  }>;
};

async function fetchRelayTrafficStats(): Promise<RelayTrafficStatsResponse | null> {
  const relayHttpPort = Number(process.env.TUNNEL_RELAY_HTTP || 7070);
  const relayHost = process.env.TUNNEL_RELAY_HOST || "127.0.0.1";
  const relaySecret = process.env.RELAY_INTERNAL_SECRET || "";
  const INTERNAL_SECRET_HEADER = "x-relay-internal-secret";

  return new Promise((resolve) => {
    const req = http.get(
      {
        host: relayHost,
        port: relayHttpPort,
        path: "/internal/traffic-stats",
        timeout: 3000,
        headers: relaySecret ? { [INTERNAL_SECRET_HEADER]: relaySecret } : undefined,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
  });
}

function isoOrNull(ms: number | null | undefined): string | null {
  if (!ms || typeof ms !== "number") return null;
  try {
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
}

async function syncAliasTrafficFromRelayToDb(relay: RelayTrafficStatsResponse) {
  if (!relay?.relayRunId || !Array.isArray(relay.byAlias)) return;

  const nowIso = new Date().toISOString();

  // Use a transaction; works for both pg and sqlite implementation in pool
  await pool.query("BEGIN");
  try {
    for (const a of relay.byAlias) {
      const alias = String(a.alias || "").trim().toLowerCase();
      if (!alias) continue;

      const relayRunId = relay.relayRunId;
      const newRequests = Number(a.requests || 0);
      const newBytesIn = Number(a.bytesIn || 0);
      const newBytesOut = Number(a.bytesOut || 0);
      const lastSeenAt = isoOrNull(a.lastSeenAt);
      const lastStatus = a.lastStatus === null || a.lastStatus === undefined ? null : Number(a.lastStatus);

      // Fetch previous snapshot for this alias/run to compute delta
      const prevRes = await pool.query(
        `SELECT requests, bytes_in, bytes_out
         FROM alias_traffic_runs
         WHERE alias = $1 AND relay_run_id = $2
         LIMIT 1`,
        [alias, relayRunId]
      );
      const prev = prevRes.rows?.[0] || {};
      const prevRequests = Number(prev.requests || 0);
      const prevBytesIn = Number(prev.bytes_in || 0);
      const prevBytesOut = Number(prev.bytes_out || 0);

      const deltaRequests = Math.max(0, newRequests - prevRequests);
      const deltaBytesIn = Math.max(0, newBytesIn - prevBytesIn);
      const deltaBytesOut = Math.max(0, newBytesOut - prevBytesOut);

      // Upsert snapshot for this run
      await pool.query(
        `INSERT INTO alias_traffic_runs (alias, relay_run_id, requests, bytes_in, bytes_out, last_seen_at, last_status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (alias, relay_run_id) DO UPDATE SET
           requests = EXCLUDED.requests,
           bytes_in = EXCLUDED.bytes_in,
           bytes_out = EXCLUDED.bytes_out,
           last_seen_at = EXCLUDED.last_seen_at,
           last_status = EXCLUDED.last_status,
           updated_at = EXCLUDED.updated_at`,
        [alias, relayRunId, newRequests, newBytesIn, newBytesOut, lastSeenAt, lastStatus, nowIso]
      );

      // Update totals by delta
      await pool.query(
        `INSERT INTO alias_traffic_totals (alias, requests, bytes_in, bytes_out, last_seen_at, last_status, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (alias) DO UPDATE SET
           requests = alias_traffic_totals.requests + $2,
           bytes_in = alias_traffic_totals.bytes_in + $3,
           bytes_out = alias_traffic_totals.bytes_out + $4,
           last_seen_at = CASE
             WHEN $5 IS NULL THEN alias_traffic_totals.last_seen_at
             WHEN alias_traffic_totals.last_seen_at IS NULL THEN $5
             WHEN $5 > alias_traffic_totals.last_seen_at THEN $5
             ELSE alias_traffic_totals.last_seen_at
           END,
           last_status = COALESCE($6, alias_traffic_totals.last_status),
           updated_at = $7`,
        [alias, deltaRequests, deltaBytesIn, deltaBytesOut, lastSeenAt, lastStatus, nowIso]
      );
    }

    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

/**
 * GET /v1/admin/stats
 * Get system statistics
 */
adminRouter.get("/stats", async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }
    if (!requireAdmin(user)) {
      return res.status(403).json(makeError("FORBIDDEN", "Admin only"));
    }

    // Get tunnel stats
    const tunnelStats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'active') as active,
        COUNT(*) FILTER (WHERE status = 'inactive') as inactive,
        COUNT(*) FILTER (WHERE status = 'deleted') as deleted,
        COUNT(*) as total
      FROM tunnels
    `);

    // Get database stats
    const dbStats = await pool.query(`
      SELECT 
        COUNT(*) FILTER (WHERE status = 'ready') as ready,
        COUNT(*) FILTER (WHERE status = 'provisioning') as provisioning,
        COUNT(*) FILTER (WHERE status = 'failed') as failed,
        COUNT(*) FILTER (WHERE status = 'deleted') as deleted,
        COUNT(*) as total
      FROM databases
    `);

    // Get recent activity (last 24 hours)
    const recentTunnels = await pool.query(`
      SELECT COUNT(*) as count
      FROM tunnels
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);

    const recentDbs = await pool.query(`
      SELECT COUNT(*) as count
      FROM databases
      WHERE created_at > NOW() - INTERVAL '24 hours'
    `);

    return res.json({
      tunnels: {
        active: Number(tunnelStats.rows[0].active),
        inactive: Number(tunnelStats.rows[0].inactive),
        deleted: Number(tunnelStats.rows[0].deleted),
        total: Number(tunnelStats.rows[0].total),
        createdLast24h: Number(recentTunnels.rows[0].count),
      },
      databases: {
        ready: Number(dbStats.rows[0].ready),
        provisioning: Number(dbStats.rows[0].provisioning),
        failed: Number(dbStats.rows[0].failed),
        deleted: Number(dbStats.rows[0].deleted),
        total: Number(dbStats.rows[0].total),
        createdLast24h: Number(recentDbs.rows[0].count),
      },
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "admin.stats.error", error: err.message, stack: err.stack });
    return res.status(500).json(
      makeError("INTERNAL_ERROR", "Failed to get stats", { error: err.message })
    );
  }
});

/**
 * Query relay for connected tokens
 * Returns empty set if relay is unreachable (fail gracefully)
 */
async function getConnectedTokens(): Promise<Set<string>> {
  const relayHttpPort = Number(process.env.TUNNEL_RELAY_HTTP || 7070);
  const relayHost = process.env.TUNNEL_RELAY_HOST || "127.0.0.1";
  const relaySecret = process.env.RELAY_INTERNAL_SECRET || "";
  const INTERNAL_SECRET_HEADER = "x-relay-internal-secret";
  
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: relayHost,
        port: relayHttpPort,
        path: "/internal/connected-tokens",
        timeout: 2000,
        headers: relaySecret ? { [INTERNAL_SECRET_HEADER]: relaySecret } : undefined,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve(new Set(json.tokens || []));
          } catch {
            // If we can't parse the response, assume no connections
            resolve(new Set());
          }
        });
      }
    );
    req.on("error", () => {
      // If relay is unreachable, return empty set (all tunnels show as disconnected)
      resolve(new Set());
    });
    req.on("timeout", () => {
      req.destroy();
      resolve(new Set());
    });
  });
}

type RelayConnectedTunnel = {
  token: string;
  clientIp: string;
  targetPort: number;
  connectedAt: string;
};

async function getConnectedTunnels(): Promise<RelayConnectedTunnel[]> {
  const relayHttpPort = Number(process.env.TUNNEL_RELAY_HTTP || 7070);
  const relayHost = process.env.TUNNEL_RELAY_HOST || "127.0.0.1";
  const relaySecret = process.env.RELAY_INTERNAL_SECRET || "";
  const INTERNAL_SECRET_HEADER = "x-relay-internal-secret";

  return new Promise((resolve) => {
    const req = http.get(
      {
        host: relayHost,
        port: relayHttpPort,
        path: "/internal/connected-tokens",
        timeout: 3000,
        headers: relaySecret ? { [INTERNAL_SECRET_HEADER]: relaySecret } : undefined,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk.toString();
        });
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            resolve((json.tunnels || []) as RelayConnectedTunnel[]);
          } catch {
            resolve([]);
          }
        });
      }
    );
    req.on("error", () => resolve([]));
    req.on("timeout", () => {
      req.destroy();
      resolve([]);
    });
  });
}

/**
 * GET /v1/admin/tunnels
 * List all tunnels (admin view) with connection status from relay
 */
adminRouter.get("/tunnels", validateQuery(listQuerySchema), async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }
    if (!requireAdmin(user)) {
      return res.status(403).json(makeError("FORBIDDEN", "Admin only"));
    }

    const status = req.query.status as string | undefined;
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;

    // Join with aliases in a single query (avoids N+1)
    let sql = `SELECT t.id, t.owner_user_id, t.token, t.target_port, t.status, 
                      t.created_at, t.updated_at, t.expires_at, a.alias
               FROM tunnels t
               LEFT JOIN tunnel_aliases a ON a.tunnel_id = t.id
               WHERE t.status <> 'deleted'`;
    const params: any[] = [];

    if (status) {
      sql += " AND t.status = $1";
      params.push(status);
    }

    sql += " ORDER BY t.created_at DESC LIMIT $" + (params.length + 1) + " OFFSET $" + (params.length + 2);
    params.push(limit, offset);

    const result = await pool.query(sql, params);
    const totalResult = await pool.query(
      "SELECT COUNT(*) as count FROM tunnels WHERE status <> 'deleted'",
      []
    );

    // Get connected tokens from relay
    const connectedTokens = await getConnectedTokens();

    // Add connection status to each tunnel
    const tunnels = result.rows.map((row: any) => ({
      ...row,
      connected: connectedTokens.has(row.token),
    }));

    return res.json({
      tunnels,
      count: tunnels.length,
      total: Number(totalResult.rows[0].count),
      limit,
      offset,
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "admin.tunnels.list.error", error: err.message, stack: err.stack });
    return res.status(500).json(
      makeError("INTERNAL_ERROR", "Failed to list tunnels", { error: error.message })
    );
  }
});

/**
 * GET /v1/admin/databases
 * List all databases (admin view)
 */
adminRouter.get("/databases", validateQuery(listQuerySchema), async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }
    if (!requireAdmin(user)) {
      return res.status(403).json(makeError("FORBIDDEN", "Admin only"));
    }

    const status = req.query.status as string | undefined;
    const limit = Number(req.query.limit) || 50;
    const offset = Number(req.query.offset) || 0;

    // Select specific columns, excluding encrypted_password for security
    let sql = `SELECT id, owner_user_id, project_id, name, provider, provider_database_id, 
               engine, version, region, status, host, port, database, "user", created_at, updated_at
               FROM databases WHERE status <> 'deleted'`;
    const params: any[] = [];

    if (status) {
      sql += " AND status = $1";
      params.push(status);
    }

    sql += " ORDER BY created_at DESC LIMIT $" + (params.length + 1) + " OFFSET $" + (params.length + 2);
    params.push(limit, offset);

    const result = await pool.query(sql, params);
    const totalResult = await pool.query(
      "SELECT COUNT(*) as count FROM databases WHERE status <> 'deleted'",
      []
    );

    return res.json({
      databases: result.rows,
      count: result.rows.length,
      total: Number(totalResult.rows[0].count),
      limit,
      offset,
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "admin.databases.list.error", error: err.message, stack: err.stack });
    return res.status(500).json(
      makeError("INTERNAL_ERROR", "Failed to list databases", { error: error.message })
    );
  }
});

/**
 * GET /v1/admin/tokens
 * List tokens (does NOT return raw tokens, only metadata)
 */
adminRouter.get("/tokens", validateQuery(listQuerySchema), async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }
    if (!requireAdmin(user)) {
      return res.status(403).json(makeError("FORBIDDEN", "Admin only"));
    }

    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;

    const result = await pool.query(
      `SELECT id, token_prefix, role, user_id, label, created_by_user_id, created_at, revoked_at, expires_at
       FROM tokens
       ORDER BY created_at DESC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const totalResult = await pool.query("SELECT COUNT(*) as count FROM tokens", []);

    return res.json({
      tokens: result.rows,
      count: result.rows.length,
      total: Number(totalResult.rows[0]?.count || 0),
      limit,
      offset,
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "admin.tokens.list.error", error: err.message, stack: err.stack });
    return res
      .status(500)
      .json(makeError("INTERNAL_ERROR", "Failed to list tokens", { error: err.message }));
  }
});

/**
 * POST /v1/admin/tokens
 * Mint a new token (returns the raw token once)
 */
adminRouter.post(
  "/tokens",
  tokenCreationRateLimiter,
  validateBody(createTokenSchema),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
      }
      if (!requireAdmin(user)) {
        return res.status(403).json(makeError("FORBIDDEN", "Admin only"));
      }

      const { role, label, expiresInDays } = req.body;

    const id = `tok_${randomUUID()}`;
    const rawToken = randomBytes(32).toString("hex"); // 64-char high-entropy token
    const tokHash = hashToken(rawToken);
    const prefix = tokenPrefix(rawToken, 8);
    const userId = role === "admin" ? `admin_${randomUUID()}` : `user_${randomUUID()}`;

    const now = new Date();
    const expiresAt =
      expiresInDays && expiresInDays > 0
        ? new Date(now.getTime() + expiresInDays * 24 * 60 * 60 * 1000)
        : null;

    await pool.query(
      `INSERT INTO tokens (id, token_hash, token_prefix, role, user_id, label, created_by_user_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        tokHash,
        prefix,
        role,
        userId,
        label,
        user.id,
        now.toISOString(),
        expiresAt ? expiresAt.toISOString() : null,
      ]
    );

    auditLog.tokenCreated(userId, id, role);

    return res.status(201).json({
      id,
      token: rawToken, // return once
      tokenPrefix: prefix,
      role,
      userId,
      label,
      createdAt: now.toISOString(),
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "admin.tokens.create.error", error: err.message, stack: err.stack });
    return res
      .status(500)
      .json(makeError("INTERNAL_ERROR", "Failed to mint token", { error: err.message }));
  }
});

/**
 * POST /v1/admin/tokens/revoke
 * Revoke by id (preferred) or by raw token (supported but avoid if possible).
 */
adminRouter.post(
  "/tokens/revoke",
  validateBody(revokeTokenSchema),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
      }
      if (!requireAdmin(user)) {
        return res.status(403).json(makeError("FORBIDDEN", "Admin only"));
      }

      const { id, token: rawToken } = req.body;
      const now = new Date().toISOString();

      if (id) {
        await pool.query("UPDATE tokens SET revoked_at = $1 WHERE id = $2", [now, id]);
        auditLog.tokenRevoked("", id, user.id);
        return res.json({ ok: true, revokedAt: now, id });
    }

    const tokHash = hashToken(rawToken);
    await pool.query("UPDATE tokens SET revoked_at = $1 WHERE token_hash = $2", [
      now,
      tokHash,
    ]);
    auditLog.tokenRevoked("", "", user.id);
    return res.json({ ok: true, revokedAt: now });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "admin.tokens.revoke.error", error: err.message, stack: err.stack });
    return res
      .status(500)
      .json(makeError("INTERNAL_ERROR", "Failed to revoke token", { error: err.message }));
  }
});

/**
 * GET /v1/admin/relay-status
 * Get relay status including connected tunnels with client IPs
 */
adminRouter.get("/relay-status", async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }
    if (!requireAdmin(user)) {
      return res.status(403).json(makeError("FORBIDDEN", "Admin only"));
    }
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/ab5d6743-9469-4ee1-a93a-181a6c692c76',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'run1',hypothesisId:'H-relay-status',location:'backend/src/routes/admin.ts:relay-status',message:'relay-status entry',data:{userId:user.id,role:user.role,relayHost:process.env.TUNNEL_RELAY_HOST||'127.0.0.1',relayHttp:process.env.TUNNEL_RELAY_HTTP||'7070'},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    const tunnels = await getConnectedTunnels();

    const now = Date.now();
    const withUptime = tunnels.map((t) => {
      let connectedFor = "";
      try {
        const start = new Date(t.connectedAt).getTime();
        const seconds = Math.max(0, Math.floor((now - start) / 1000));
        const mins = Math.floor(seconds / 60);
        const hrs = Math.floor(mins / 60);
        const days = Math.floor(hrs / 24);
        if (days > 0) connectedFor = `${days}d${hrs % 24}h`;
        else if (hrs > 0) connectedFor = `${hrs}h${mins % 60}m`;
        else connectedFor = `${mins}m${seconds % 60}s`;
      } catch {
        connectedFor = "";
      }
      return { ...t, connectedFor };
    });

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/ab5d6743-9469-4ee1-a93a-181a6c692c76',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'run1',hypothesisId:'H-relay-status',location:'backend/src/routes/admin.ts:relay-status',message:'relay-status result',data:{count:withUptime.length,rawCount:tunnels.length},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return res.json({
      connectedTunnels: withUptime.length,
      tunnels: withUptime,
      timestamp: new Date().toISOString(),
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "admin.relay-status.error", error: err.message, stack: err.stack });
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/ab5d6743-9469-4ee1-a93a-181a6c692c76',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'run1',hypothesisId:'H-relay-status',location:'backend/src/routes/admin.ts:relay-status',message:'relay-status error',data:{error:err.message},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return res.status(500).json(
      makeError("INTERNAL_ERROR", "Failed to get relay status", { error: err.message })
    );
  }
});

/**
 * GET /v1/admin/traffic-stats
 * Returns persisted totals per alias; can optionally sync from relay first with ?sync=true
 */
adminRouter.get("/traffic-stats", async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }
    if (!requireAdmin(user)) {
      return res.status(403).json(makeError("FORBIDDEN", "Admin only"));
    }

    const sync = String(req.query.sync || "").toLowerCase() === "true";

    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/ab5d6743-9469-4ee1-a93a-181a6c692c76',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'run1',hypothesisId:'H-traffic-stats',location:'backend/src/routes/admin.ts:traffic-stats',message:'traffic-stats entry',data:{userId:user.id,role:user.role,sync},timestamp:Date.now()})}).catch(()=>{});
    // #endregion

    let relayMeta: { relayRunId: string; since: string; timestamp: string } | null = null;
    if (sync) {
      const relay = await fetchRelayTrafficStats();
      if (relay) {
        relayMeta = { relayRunId: relay.relayRunId, since: relay.since, timestamp: relay.timestamp };
        await syncAliasTrafficFromRelayToDb(relay);
        // #region agent log
        fetch('http://127.0.0.1:7242/ingest/ab5d6743-9469-4ee1-a93a-181a6c692c76',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'run1',hypothesisId:'H-traffic-stats',location:'backend/src/routes/admin.ts:traffic-stats',message:'relay sync done',data:{relayRunId:relay.relayRunId,byAliasCount:Array.isArray(relay.byAlias)?relay.byAlias.length:null},timestamp:Date.now()})}).catch(()=>{});
        // #endregion
      }
    }

    const totalsRes = await pool.query(
      `SELECT alias, requests, bytes_in, bytes_out, last_seen_at, last_status, updated_at
       FROM alias_traffic_totals
       ORDER BY requests DESC
       LIMIT 200`,
      []
    );

    const aliases = (totalsRes.rows || []).map((r: any) => ({
      alias: r.alias,
      requests: Number(r.requests || 0),
      bytesIn: Number(r.bytes_in || 0),
      bytesOut: Number(r.bytes_out || 0),
      lastSeenAt: r.last_seen_at || null,
      lastStatus: r.last_status === null || r.last_status === undefined ? null : Number(r.last_status),
      updatedAt: r.updated_at,
    }));

    return res.json({
      timestamp: new Date().toISOString(),
      relay: relayMeta,
      count: aliases.length,
      aliases,
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "admin.traffic_stats.error", error: err.message, stack: err.stack });
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/ab5d6743-9469-4ee1-a93a-181a6c692c76',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'debug-session',runId:'run1',hypothesisId:'H-traffic-stats',location:'backend/src/routes/admin.ts:traffic-stats',message:'traffic-stats error',data:{error:err.message},timestamp:Date.now()})}).catch(()=>{});
    // #endregion
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to get traffic stats"));
  }
});

/**
 * POST /v1/admin/cleanup/dev-user-tunnels
 * Clean up old tunnels owned by dev-user (from before token system)
 */
adminRouter.post("/cleanup/dev-user-tunnels", async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }
    if (!requireAdmin(user)) {
      return res.status(403).json(makeError("FORBIDDEN", "Admin only"));
    }

    // Mark all dev-user tunnels as deleted
    const result = await pool.query(
      `UPDATE tunnels 
       SET status = 'deleted', updated_at = NOW() 
       WHERE owner_user_id = 'dev-user' AND status <> 'deleted'`,
      []
    );

    return res.json({
      ok: true,
      deleted: result.rowCount || 0,
      message: `Marked ${result.rowCount || 0} dev-user tunnels as deleted`,
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "admin.cleanup.error", error: err.message, stack: err.stack });
    return res
      .status(500)
      .json(makeError("INTERNAL_ERROR", "Failed to cleanup tunnels", { error: error.message }));
  }
});

/**
 * POST /v1/admin/grant-alias
 * Grant alias access to a user by setting their alias_limit
 */
adminRouter.post("/grant-alias", async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }
    if (!requireAdmin(user)) {
      return res.status(403).json(makeError("FORBIDDEN", "Admin only"));
    }

    const { userId, aliasLimit } = req.body as { userId?: string; aliasLimit?: number };

    if (!userId) {
      return res.status(400).json(makeError("INVALID_REQUEST", "userId is required"));
    }
    if (aliasLimit === undefined || typeof aliasLimit !== "number") {
      return res.status(400).json(makeError("INVALID_REQUEST", "aliasLimit must be a number"));
    }
    if (aliasLimit < -1 || aliasLimit > 100) {
      return res.status(400).json(makeError("INVALID_REQUEST", "aliasLimit must be -1 (unlimited) or 0-100"));
    }

    // Check if user exists
    const userResult = await pool.query(
      "SELECT id, user_id, role FROM tokens WHERE user_id = $1 LIMIT 1",
      [userId]
    );
    if (userResult.rowCount === 0) {
      return res.status(404).json(makeError("NOT_FOUND", "User not found", { userId }));
    }

    // Update alias_limit for all tokens belonging to this user
    const result = await pool.query(
      "UPDATE tokens SET alias_limit = $1 WHERE user_id = $2",
      [aliasLimit, userId]
    );

    auditLog.tokenRevoked(userId, "", user.id); // Reusing audit log for now
    logger.info({
      event: "admin.grant_alias",
      targetUserId: userId,
      aliasLimit,
      updatedTokens: result.rowCount,
      grantedBy: user.id,
    });

    return res.json({
      success: true,
      userId,
      aliasLimit,
      updatedTokens: result.rowCount,
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "admin.grant_alias.error", error: err.message, stack: err.stack });
    return res.status(500).json(
      makeError("INTERNAL_ERROR", "Failed to grant alias access", { error: err.message })
    );
  }
});


