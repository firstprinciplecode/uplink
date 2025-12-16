import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { makeError } from "../schemas/error";
import http from "http";

export const adminRouter = Router();

// Simple auth stub – replace with real auth middleware
interface AuthedRequest extends Request {
  user?: { id: string };
}

// Admin endpoints - currently accessible to any authenticated user
// TODO: Add proper admin role checking

/**
 * GET /v1/admin/stats
 * Get system statistics
 */
adminRouter.get("/stats", async (req: AuthedRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
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
  } catch (error: any) {
    console.error("Error getting admin stats:", error);
    return res.status(500).json(
      makeError("INTERNAL_ERROR", "Failed to get stats", { error: error.message })
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
adminRouter.get("/tunnels", async (req: AuthedRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
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
  } catch (error: any) {
    console.error("Error listing admin tunnels:", error);
    return res.status(500).json(
      makeError("INTERNAL_ERROR", "Failed to list tunnels", { error: error.message })
    );
  }
});

/**
 * GET /v1/admin/databases
 * List all databases (admin view)
 */
adminRouter.get("/databases", async (req: AuthedRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
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
  } catch (error: any) {
    console.error("Error listing admin databases:", error);
    return res.status(500).json(
      makeError("INTERNAL_ERROR", "Failed to list databases", { error: error.message })
    );
  }
});


