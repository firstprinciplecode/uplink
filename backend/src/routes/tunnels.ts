import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { makeError } from "../schemas/error";
import { pool } from "../db/pool";
import { TunnelRecord, TunnelStatus, toTunnelResponse } from "../models/tunnel";
import { validateBody } from "../middleware/validate";
import { createTunnelSchema } from "../schemas/validation";
import { tunnelCreationRateLimiter } from "../middleware/rate-limit";
import { logger, auditLog } from "../utils/logger";
import { config } from "../utils/config";

export const tunnelRouter = Router();

const TUNNEL_DOMAIN = config.tunnelDomain;
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
    logger.error({ event: "tunnel_token_check.error", error });
    return false;
  }
}

/**
 * POST /v1/tunnels
 * Create a new tunnel
 */
tunnelRouter.post(
  "/",
  tunnelCreationRateLimiter,
  validateBody(createTunnelSchema),
  async (req: Request, res: Response) => {
    try {
      const user = req.user;
      if (!user) {
        return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
      }

      const { port } = req.body;
      const project = (req.body as { project?: string }).project;

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

      auditLog.tunnelCreated(user.id, id, token, port);

      const response = toTunnelResponse(tunnelRecord, TUNNEL_DOMAIN, USE_HOST_ROUTING);

      return res.status(201).json(response);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({ event: "tunnel.create.error", error: err.message, stack: err.stack });
      return res.status(500).json(
        makeError("INTERNAL_ERROR", "Failed to create tunnel", { error: err.message })
      );
    }
  }
);

/**
 * GET /v1/tunnels/:id
 * Get tunnel information
 */
tunnelRouter.get("/:id", async (req: Request, res: Response) => {
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
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "tunnel.get.error", error: err.message, stack: err.stack });
    return res.status(500).json(
      makeError("INTERNAL_ERROR", "Failed to get tunnel", { error: err.message })
    );
  }
});

/**
 * DELETE /v1/tunnels/:id
 * Delete a tunnel
 */
tunnelRouter.delete("/:id", async (req: Request, res: Response) => {
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

    auditLog.tunnelDeleted(user.id, id);

    return res.json({
      id,
      status: "deleted",
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "tunnel.delete.error", error: err.message, stack: err.stack });
    return res.status(500).json(
      makeError("INTERNAL_ERROR", "Failed to delete tunnel", { error: err.message })
    );
  }
});

/**
 * GET /v1/tunnels
 * List all tunnels for the authenticated user
 */
tunnelRouter.get("/", async (req: Request, res: Response) => {
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
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "tunnel.list.error", error: err.message, stack: err.stack });
    return res.status(500).json(
      makeError("INTERNAL_ERROR", "Failed to list tunnels", { error: err.message })
    );
  }
});

