import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { makeError } from "../schemas/error";

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
 * GET /v1/admin/tunnels
 * List all tunnels (admin view)
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

    return res.json({
      tunnels: result.rows,
      count: result.rows.length,
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

