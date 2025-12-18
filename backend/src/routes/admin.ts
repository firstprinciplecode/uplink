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

    let sql = "SELECT * FROM tunnels WHERE status <> 'deleted'";
    const params: any[] = [];

    if (status) {
      sql += " AND status = $1";
      params.push(status);
    }

    sql += " ORDER BY created_at DESC LIMIT $" + (params.length + 1) + " OFFSET $" + (params.length + 2);
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

    let sql = "SELECT * FROM databases WHERE status <> 'deleted'";
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


