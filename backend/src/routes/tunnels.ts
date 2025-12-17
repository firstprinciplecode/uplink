import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { makeError } from "../schemas/error";
import { pool } from "../db/pool";
import { TunnelRecord, TunnelStatus, toTunnelResponse } from "../models/tunnel";

export const tunnelRouter = Router();

// Simple auth stub – replace with real auth middleware
interface AuthedRequest extends Request {
  user?: { id: string; role?: string };
}

const TUNNEL_DOMAIN = process.env.TUNNEL_DOMAIN || "dev.uplink.spot";
const USE_HOST_ROUTING = process.env.TUNNEL_USE_HOST !== "false"; // Default to host-based

// Helper to check if a token exists (for on-demand TLS ask endpoint)
export async function tunnelTokenExists(token: string): Promise<boolean> {
  try {
    const result = await pool.query(
      "SELECT id FROM tunnels WHERE token = $1 AND status = 'active'",
      [token]
    );
    return result.rowCount > 0;
  } catch (error) {
    console.error("Error checking tunnel token:", error);
    return false;
  }
}

/**
 * POST /v1/tunnels
 * Create a new tunnel
 */
tunnelRouter.post("/", async (req: AuthedRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }

    const { port, project } = req.body;
    
    if (!port || typeof port !== "number") {
      return res.status(400).json(
        makeError("INVALID_INPUT", "port is required and must be a number")
      );
    }

    const id = `tun_${randomUUID()}`;
    const token = randomUUID().replace(/-/g, "").slice(0, 12); // Shorter token for subdomain
    const projectId = project || null;
    const status: TunnelStatus = "active";
    const now = new Date().toISOString();

    // Insert into database
    await pool.query(
      `INSERT INTO tunnels (id, owner_user_id, project_id, token, target_port, status, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, user.id, projectId, token, port, status, now, now]
    );

    const tunnelRecord: TunnelRecord = {
      id,
      ownerUserId: user.id,
      projectId,
      token,
      targetPort: port,
      status,
      createdAt: now,
      updatedAt: now,
      expiresAt: null,
    };

    const response = toTunnelResponse(tunnelRecord, TUNNEL_DOMAIN, USE_HOST_ROUTING);

    return res.status(201).json(response);
  } catch (error: any) {
    console.error("Error creating tunnel:", error);
    return res.status(500).json(
      makeError("INTERNAL_ERROR", "Failed to create tunnel", { error: error.message })
    );
  }
});

/**
 * GET /v1/tunnels/:id
 * Get tunnel information
 */
tunnelRouter.get("/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }

    const { id } = req.params;
    const result = await pool.query(
      "SELECT * FROM tunnels WHERE id = $1",
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json(
        makeError("NOT_FOUND", "Tunnel not found", { id })
      );
    }

    const record = result.rows[0] as TunnelRecord;

    // Check authorization (user can only see their own tunnels)
    if (record.ownerUserId !== user.id) {
      return res.status(403).json(
        makeError("FORBIDDEN", "Access denied")
      );
    }

    const response = toTunnelResponse(record, TUNNEL_DOMAIN, USE_HOST_ROUTING);
    return res.json(response);
  } catch (error: any) {
    console.error("Error getting tunnel:", error);
    return res.status(500).json(
      makeError("INTERNAL_ERROR", "Failed to get tunnel", { error: error.message })
    );
  }
});

/**
 * DELETE /v1/tunnels/:id
 * Delete a tunnel
 */
tunnelRouter.delete("/:id", async (req: AuthedRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }

    const { id } = req.params;
    const result = await pool.query(
      "SELECT owner_user_id FROM tunnels WHERE id = $1",
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json(
        makeError("NOT_FOUND", "Tunnel not found", { id })
      );
    }

    // Check authorization
    if (result.rows[0].owner_user_id !== user.id) {
      return res.status(403).json(
        makeError("FORBIDDEN", "Access denied")
      );
    }

    // Soft delete (set status to deleted)
    await pool.query(
      "UPDATE tunnels SET status = 'deleted', updated_at = $1 WHERE id = $2",
      [new Date().toISOString(), id]
    );

    return res.json({
      id,
      status: "deleted",
    });
  } catch (error: any) {
    console.error("Error deleting tunnel:", error);
    return res.status(500).json(
      makeError("INTERNAL_ERROR", "Failed to delete tunnel", { error: error.message })
    );
  }
});

/**
 * GET /v1/tunnels
 * List all tunnels for the authenticated user
 */
tunnelRouter.get("/", async (req: AuthedRequest, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }

    const result = await pool.query(
      "SELECT * FROM tunnels WHERE owner_user_id = $1 AND status <> 'deleted' ORDER BY created_at DESC",
      [user.id]
    );

    const tunnels = result.rows.map((row: TunnelRecord) =>
      toTunnelResponse(row, TUNNEL_DOMAIN, USE_HOST_ROUTING)
    );

    return res.json({
      tunnels,
      count: tunnels.length,
    });
  } catch (error: any) {
    console.error("Error listing tunnels:", error);
    return res.status(500).json(
      makeError("INTERNAL_ERROR", "Failed to list tunnels", { error: error.message })
    );
  }
});

