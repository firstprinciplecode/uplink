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
const ALIAS_DOMAIN = config.aliasDomain;
const USE_HOST_ROUTING = process.env.TUNNEL_USE_HOST !== "false"; // Default to host-based
const RELAY_INTERNAL_SECRET = process.env.RELAY_INTERNAL_SECRET || "";

const RESERVED_ALIASES = new Set([
  "www",
  "api",
  "x",
  "t",
  "docs",
  "support",
  "status",
  "health",
  "mail",
]);
const ALIAS_REGEX = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function normalizeAlias(alias: string): string {
  return alias.trim().toLowerCase();
}

function isReservedAlias(alias: string): boolean {
  return RESERVED_ALIASES.has(alias);
}

function isAuthorizedRelay(req: Request): boolean {
  if (!RELAY_INTERNAL_SECRET) return true;
  const provided = req.headers["x-relay-internal-secret"];
  return provided === RELAY_INTERNAL_SECRET;
}

async function getAliasForTunnel(tunnelId: string): Promise<string | null> {
  const result = await pool.query(
    "SELECT alias FROM tunnel_aliases WHERE tunnel_id = $1 LIMIT 1",
    [tunnelId]
  );
  if (result.rowCount > 0) {
    return result.rows[0].alias as string;
  }
  return null;
}

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
 * Internal: resolve alias -> token for relay
 */
tunnelRouter.get("/internal/resolve-alias", async (req: Request, res: Response) => {
  if (!isAuthorizedRelay(req)) {
    return res.status(403).json(makeError("FORBIDDEN", "Invalid relay secret"));
  }

  const aliasRaw = (req.query.alias as string) || "";
  if (!aliasRaw) {
    return res.status(400).json(makeError("INVALID_ALIAS", "Alias is required"));
  }
  const alias = normalizeAlias(aliasRaw);
  if (isReservedAlias(alias)) {
    return res.status(404).json(makeError("NOT_FOUND", "Alias not found"));
  }

  const result = await pool.query(
    `SELECT t.token
     FROM tunnel_aliases a
     JOIN tunnels t ON t.id = a.tunnel_id
     WHERE a.alias = $1 AND t.status = 'active'
     LIMIT 1`,
    [alias]
  );

  if (result.rowCount === 0) {
    return res.status(404).json(makeError("NOT_FOUND", "Alias not found"));
  }

  return res.json({ token: result.rows[0].token });
});

/**
 * POST /v1/tunnels/:id/alias
 * Create or update an alias for a tunnel
 */
tunnelRouter.post("/:id/alias", async (req: Request, res: Response) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
  }

  const aliasInput = (req.body as { alias?: string }).alias;
  if (!aliasInput) {
    return res.status(400).json(makeError("INVALID_ALIAS", "Alias is required"));
  }

  const alias = normalizeAlias(aliasInput);
  if (!ALIAS_REGEX.test(alias)) {
    return res
      .status(400)
      .json(makeError("INVALID_ALIAS", "Alias must be 1-63 chars, alphanumeric + hyphen, cannot start/end with hyphen"));
  }
  if (isReservedAlias(alias)) {
    return res.status(400).json(makeError("ALIAS_RESERVED", "Alias is reserved"));
  }

  const { id } = req.params;

  // Verify tunnel ownership
  const tunnelResult = await pool.query(
    "SELECT * FROM tunnels WHERE id = $1 AND status <> 'deleted'",
    [id]
  );
  if (tunnelResult.rowCount === 0) {
    return res.status(404).json(makeError("NOT_FOUND", "Tunnel not found", { id }));
  }
  const tunnel = tunnelResult.rows[0] as TunnelRecord;
  if (tunnel.ownerUserId !== user.id) {
    return res.status(403).json(makeError("FORBIDDEN", "Access denied"));
  }

  const now = new Date().toISOString();
  const aliasId = `alias_${randomUUID()}`;

  try {
    await pool.query("BEGIN");

    // Check if alias already exists for another tunnel
    const existing = await pool.query(
      "SELECT tunnel_id FROM tunnel_aliases WHERE alias = $1",
      [alias]
    );
    if (existing.rowCount > 0 && existing.rows[0].tunnel_id !== id) {
      await pool.query("ROLLBACK");
      return res.status(409).json(makeError("ALIAS_TAKEN", "Alias is already in use"));
    }

    // Remove any existing alias for this tunnel
    await pool.query("DELETE FROM tunnel_aliases WHERE tunnel_id = $1", [id]);

    // Insert new alias
    await pool.query(
      `INSERT INTO tunnel_aliases (id, owner_user_id, tunnel_id, alias, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [aliasId, user.id, id, alias, now, now]
    );

    await pool.query("COMMIT");
  } catch (err) {
    await pool.query("ROLLBACK").catch(() => {});
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ event: "tunnel.alias.error", error: message });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to set alias"));
  }

  const response = toTunnelResponse(
    tunnel,
    TUNNEL_DOMAIN,
    USE_HOST_ROUTING,
    ALIAS_DOMAIN,
    alias
  );
  return res.status(201).json(response);
});

/**
 * DELETE /v1/tunnels/:id/alias
 * Remove alias from a tunnel
 */
tunnelRouter.delete("/:id/alias", async (req: Request, res: Response) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
  }

  const { id } = req.params;
  const tunnelResult = await pool.query(
    "SELECT * FROM tunnels WHERE id = $1 AND status <> 'deleted'",
    [id]
  );
  if (tunnelResult.rowCount === 0) {
    return res.status(404).json(makeError("NOT_FOUND", "Tunnel not found", { id }));
  }
  const tunnel = tunnelResult.rows[0] as TunnelRecord;
  if (tunnel.ownerUserId !== user.id) {
    return res.status(403).json(makeError("FORBIDDEN", "Access denied"));
  }

  await pool.query("DELETE FROM tunnel_aliases WHERE tunnel_id = $1", [id]);

  const response = toTunnelResponse(tunnel, TUNNEL_DOMAIN, USE_HOST_ROUTING);
  return res.json(response);
});

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
      `SELECT t.*, a.alias
       FROM tunnels t
       LEFT JOIN tunnel_aliases a ON a.tunnel_id = t.id
       WHERE t.id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json(
        makeError("NOT_FOUND", "Tunnel not found", { id })
      );
    }

    const record = result.rows[0] as TunnelRecord & { alias?: string | null };

    // Check authorization (user can only see their own tunnels)
    if (record.ownerUserId !== user.id) {
      return res.status(403).json(
        makeError("FORBIDDEN", "Access denied")
      );
    }

    const response = toTunnelResponse(
      record,
      TUNNEL_DOMAIN,
      USE_HOST_ROUTING,
      ALIAS_DOMAIN,
      record.alias || null
    );
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
      `SELECT t.*, a.alias
       FROM tunnels t
       LEFT JOIN tunnel_aliases a ON a.tunnel_id = t.id
       WHERE t.owner_user_id = $1 AND t.status <> 'deleted'
       ORDER BY t.created_at DESC`,
      [user.id]
    );

    const tunnels = result.rows.map((row: TunnelRecord & { alias?: string | null }) =>
      toTunnelResponse(row, TUNNEL_DOMAIN, USE_HOST_ROUTING, ALIAS_DOMAIN, row.alias || null)
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

