import { Router, Request, Response } from "express";
import { randomUUID, randomBytes } from "crypto";
import { makeError } from "../schemas/error";
import { pool } from "../db/pool";
import { TunnelRecord, TunnelStatus, toTunnelResponse } from "../models/tunnel";
import { validateBody } from "../middleware/validate";
import { createTunnelSchema } from "../schemas/validation";
import { tunnelCreationRateLimiter } from "../middleware/rate-limit";
import { logger, auditLog } from "../utils/logger";
import { config } from "../utils/config";
import http from "http";

export const tunnelRouter = Router();

const TUNNEL_DOMAIN = config.tunnelDomain;
const ALIAS_DOMAIN = config.aliasDomain;
const USE_HOST_ROUTING = process.env.TUNNEL_USE_HOST !== "false"; // Default to host-based
const RELAY_INTERNAL_SECRET = process.env.RELAY_INTERNAL_SECRET || "";
const RELAY_HTTP_PORT = Number(process.env.TUNNEL_RELAY_HTTP || 7070);
const RELAY_HOST = process.env.TUNNEL_RELAY_HOST || "127.0.0.1";

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
  // Fail closed: internal endpoints must be protected by a shared secret.
  if (!RELAY_INTERNAL_SECRET) return false;
  const provided = req.headers["x-relay-internal-secret"];
  return provided === RELAY_INTERNAL_SECRET;
}

async function fetchRelayJson(path: string, timeoutMs: number): Promise<any | null> {
  const headers: Record<string, string> = {};
  if (RELAY_INTERNAL_SECRET) headers["x-relay-internal-secret"] = RELAY_INTERNAL_SECRET;

  return new Promise((resolve) => {
    const req = http.get(
      {
        host: RELAY_HOST,
        port: RELAY_HTTP_PORT,
        path,
        timeout: timeoutMs,
        headers: Object.keys(headers).length ? headers : undefined,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk.toString()));
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

async function isTokenConnected(token: string): Promise<boolean> {
  const json = await fetchRelayJson("/internal/connected-tokens", 2000);
  const tokens = json?.tokens;
  if (Array.isArray(tokens)) return tokens.includes(token);
  return false;
}

type RelayTrafficStats = {
  relayRunId?: string;
  byToken?: Array<{ token: string; requests: number; bytesIn: number; bytesOut: number; lastSeenAt: number | null; lastStatus: number | null; connected?: boolean }>;
  byAlias?: Array<{ alias: string; requests: number; bytesIn: number; bytesOut: number; lastSeenAt: number | null; lastStatus: number | null }>;
};

async function fetchRelayTrafficStats(): Promise<RelayTrafficStats | null> {
  return (await fetchRelayJson("/internal/traffic-stats", 3000)) as RelayTrafficStats | null;
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
      // SECURITY: tunnel URL tokens are public identifiers; make them high-entropy to prevent guessing.
      // 16 bytes => 128-bit, encoded as 32 hex chars (safe for DNS labels).
      const token = randomBytes(16).toString("hex");
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

      // Auto-assign existing aliases for this (owner_user_id, target_port) to the new tunnel
      const existingAliases = await pool.query(
        `SELECT id, alias FROM tunnel_aliases 
         WHERE owner_user_id = $1 AND target_port = $2`,
        [user.id, port]
      );

      const assignedAliases: string[] = [];
      for (const aliasRow of existingAliases.rows) {
        await pool.query(
          `UPDATE tunnel_aliases 
           SET tunnel_id = $1, updated_at = $2 
           WHERE id = $3`,
          [id, now, aliasRow.id]
        );
        assignedAliases.push(aliasRow.alias);
      }

      // Get alias for response (if any were assigned)
      const alias = assignedAliases.length > 0 ? assignedAliases[0] : null;

      const response = toTunnelResponse(tunnelRecord, TUNNEL_DOMAIN, USE_HOST_ROUTING, ALIAS_DOMAIN, alias);

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
 * This is exported so it can be mounted at /internal/resolve-alias (outside /v1) to bypass auth
 */
export async function resolveAliasHandler(req: Request, res: Response) {
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
    `SELECT t.token, t.id as tunnel_id, t.owner_user_id
     FROM tunnel_aliases a
     JOIN tunnels t ON t.owner_user_id = a.owner_user_id 
       AND t.target_port = a.target_port
     WHERE a.alias = $1 AND t.status = 'active'
     ORDER BY t.created_at DESC
     LIMIT 1`,
    [alias]
  );

  if (result.rowCount === 0) {
    return res.status(404).json(makeError("NOT_FOUND", "Alias not found"));
  }

  return res.json({ token: result.rows[0].token });
}

/**
 * POST /v1/tunnels/:id/alias
 * Create or update an alias for a tunnel
 */
tunnelRouter.post("/:id/alias", async (req: Request, res: Response) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
  }

  // Check if user has alias permission
  const permResult = await pool.query(
    "SELECT alias_limit FROM tokens WHERE user_id = $1 LIMIT 1",
    [user.id]
  );
  const aliasLimit = permResult.rows[0]?.alias_limit ?? 0;

  if (aliasLimit === 0) {
    return res.status(403).json(
      makeError(
        "ALIAS_NOT_ENABLED",
        "Permanent aliases are a premium feature. Contact us on Discord at uplink.spot to upgrade.",
        { upgrade_url: "https://uplink.spot", user_id: user.id }
      )
    );
  }

  // If aliasLimit > 0, check they haven't exceeded their limit
  if (aliasLimit > 0) {
    const countResult = await pool.query(
      "SELECT COUNT(*) as count FROM tunnel_aliases WHERE owner_user_id = $1",
      [user.id]
    );
    const currentCount = parseInt(countResult.rows[0]?.count || "0", 10);
    if (currentCount >= aliasLimit) {
      return res.status(403).json(
        makeError(
          "ALIAS_LIMIT_REACHED",
          `You've reached your alias limit (${aliasLimit}). Contact us to increase your limit.`,
          { current: currentCount, limit: aliasLimit }
        )
      );
    }
  }
  // aliasLimit === -1 means unlimited (admin)

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

  // Verify tunnel ownership (select only needed columns)
  const tunnelResult = await pool.query(
    `SELECT id, owner_user_id, token, target_port, status, created_at, updated_at, expires_at 
     FROM tunnels WHERE id = $1 AND status <> 'deleted'`,
    [id]
  );
  if (tunnelResult.rowCount === 0) {
    return res.status(404).json(makeError("NOT_FOUND", "Tunnel not found", { id }));
  }
  const tunnel = tunnelResult.rows[0] as TunnelRecord & { owner_user_id?: string };
  const ownerId = tunnel.ownerUserId || tunnel.owner_user_id;
  if (ownerId !== user.id) {
    return res.status(403).json(makeError("FORBIDDEN", "Access denied"));
  }

  const now = new Date().toISOString();
  const aliasId = `alias_${randomUUID()}`;

  try {
    await pool.query("BEGIN");

    const targetPort = (tunnel.targetPort || (tunnel as any).target_port) as number;

    // Check if alias already exists for another (owner_user_id, target_port) combination
    const existing = await pool.query(
      `SELECT id, tunnel_id FROM tunnel_aliases 
       WHERE alias = $1 AND owner_user_id = $2 AND target_port = $3`,
      [alias, user.id, targetPort]
    );
    if (existing.rowCount > 0 && existing.rows[0].tunnel_id !== id) {
      await pool.query("ROLLBACK");
      return res.status(409).json(makeError("ALIAS_TAKEN", "Alias is already in use for this port"));
    }

    // Remove any existing alias for this tunnel
    await pool.query("DELETE FROM tunnel_aliases WHERE tunnel_id = $1", [id]);

    // Also remove any existing alias for this (owner_user_id, target_port) to ensure uniqueness
    await pool.query(
      `DELETE FROM tunnel_aliases 
       WHERE owner_user_id = $1 AND target_port = $2 AND alias = $3`,
      [user.id, targetPort, alias]
    );

    // Insert new alias with target_port
    await pool.query(
      `INSERT INTO tunnel_aliases (id, owner_user_id, tunnel_id, alias, target_port, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [aliasId, user.id, id, alias, targetPort, now, now]
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
    `SELECT id, owner_user_id, token, target_port, status, created_at, updated_at, expires_at
     FROM tunnels WHERE id = $1 AND status <> 'deleted'`,
    [id]
  );
  if (tunnelResult.rowCount === 0) {
    return res.status(404).json(makeError("NOT_FOUND", "Tunnel not found", { id }));
  }
  const tunnel = tunnelResult.rows[0] as TunnelRecord & { owner_user_id?: string };
  const ownerId = tunnel.ownerUserId || tunnel.owner_user_id;
  if (ownerId !== user.id) {
    return res.status(403).json(makeError("FORBIDDEN", "Access denied"));
  }

  await pool.query("DELETE FROM tunnel_aliases WHERE tunnel_id = $1", [id]);

  const response = toTunnelResponse(tunnel, TUNNEL_DOMAIN, USE_HOST_ROUTING);
  return res.json(response);
});

// ============================================================================
// ALIAS ROUTES - Must be defined BEFORE /:id routes to avoid matching issues
// ============================================================================

/**
 * GET /v1/tunnels/aliases
 * List all aliases for the authenticated user
 */
tunnelRouter.get("/aliases", async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }

    const result = await pool.query(
      `SELECT id, alias, target_port, created_at, updated_at
       FROM tunnel_aliases
       WHERE owner_user_id = $1
       ORDER BY created_at DESC`,
      [user.id]
    );

    const aliases = result.rows.map((row: any) => ({
      id: row.id,
      alias: row.alias,
      targetPort: row.target_port,
      url: `https://${row.alias}.${ALIAS_DOMAIN}`,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    return res.json({
      aliases,
      count: aliases.length,
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "aliases.list.error", error: err.message, stack: err.stack });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to list aliases"));
  }
});

/**
 * POST /v1/tunnels/aliases
 * Create a new alias for a port (port-based, not tunnel-based)
 */
tunnelRouter.post("/aliases", async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }

    const { alias, port } = req.body;
    if (!alias || !port) {
      return res.status(400).json(makeError("BAD_REQUEST", "alias and port are required"));
    }

    // Check if user has alias permission
    const permResult = await pool.query(
      "SELECT alias_limit FROM tokens WHERE user_id = $1 LIMIT 1",
      [user.id]
    );
    const aliasLimit = permResult.rows[0]?.alias_limit ?? 0;

    if (aliasLimit === 0) {
      return res.status(403).json(
        makeError(
          "ALIAS_NOT_ENABLED",
          "Permanent aliases are a premium feature. Contact us on Discord at uplink.spot to upgrade.",
          { upgrade_url: "https://uplink.spot", user_id: user.id }
        )
      );
    }

    // Check alias limit
    const countResult = await pool.query(
      "SELECT COUNT(*) as count FROM tunnel_aliases WHERE owner_user_id = $1",
      [user.id]
    );
    const currentCount = parseInt(countResult.rows[0]?.count || "0", 10);
    if (aliasLimit > 0 && currentCount >= aliasLimit) {
      return res.status(403).json(
        makeError("ALIAS_LIMIT_REACHED", `You have reached your limit of ${aliasLimit} aliases`)
      );
    }

    // Check if alias is already taken
    const existingAlias = await pool.query(
      "SELECT id FROM tunnel_aliases WHERE alias = $1",
      [alias]
    );
    if (existingAlias.rowCount > 0) {
      return res.status(409).json(makeError("ALIAS_TAKEN", "Alias is already in use"));
    }

    // Check if user already has an alias for this port
    const existingPort = await pool.query(
      "SELECT id, alias FROM tunnel_aliases WHERE owner_user_id = $1 AND target_port = $2",
      [user.id, port]
    );
    if (existingPort.rowCount > 0) {
      return res.status(409).json(
        makeError("PORT_HAS_ALIAS", `Port ${port} already has alias: ${existingPort.rows[0].alias}`)
      );
    }

    const aliasId = `alias_${randomUUID()}`;
    const now = new Date().toISOString();

    await pool.query(
      `INSERT INTO tunnel_aliases (id, owner_user_id, tunnel_id, alias, target_port, created_at, updated_at)
       VALUES ($1, $2, NULL, $3, $4, $5, $6)`,
      [aliasId, user.id, alias, port, now, now]
    );

    return res.status(201).json({
      id: aliasId,
      alias,
      targetPort: port,
      url: `https://${alias}.${ALIAS_DOMAIN}`,
      createdAt: now,
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "alias.create.error", error: err.message, stack: err.stack });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to create alias"));
  }
});

/**
 * PUT /v1/tunnels/aliases/:alias
 * Reassign an alias to a different port
 */
tunnelRouter.put("/aliases/:alias", async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }

    const { alias } = req.params;
    const { port } = req.body;
    if (!port) {
      return res.status(400).json(makeError("BAD_REQUEST", "port is required"));
    }

    // Check ownership
    const result = await pool.query(
      "SELECT id FROM tunnel_aliases WHERE alias = $1 AND owner_user_id = $2",
      [alias, user.id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json(makeError("NOT_FOUND", "Alias not found or not owned by you"));
    }

    // Check if another alias already exists for the target port
    const existingPort = await pool.query(
      "SELECT id, alias FROM tunnel_aliases WHERE owner_user_id = $1 AND target_port = $2 AND alias != $3",
      [user.id, port, alias]
    );
    if (existingPort.rowCount > 0) {
      return res.status(409).json(
        makeError("PORT_HAS_ALIAS", `Port ${port} already has alias: ${existingPort.rows[0].alias}`)
      );
    }

    const now = new Date().toISOString();
    await pool.query(
      "UPDATE tunnel_aliases SET target_port = $1, tunnel_id = NULL, updated_at = $2 WHERE alias = $3 AND owner_user_id = $4",
      [port, now, alias, user.id]
    );

    return res.json({
      alias,
      targetPort: port,
      url: `https://${alias}.${ALIAS_DOMAIN}`,
      updatedAt: now,
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "alias.update.error", error: err.message, stack: err.stack });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to update alias"));
  }
});

/**
 * DELETE /v1/tunnels/aliases/:alias
 * Delete an alias
 */
tunnelRouter.delete("/aliases/:alias", async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }

    const { alias } = req.params;

    const result = await pool.query(
      "DELETE FROM tunnel_aliases WHERE alias = $1 AND owner_user_id = $2 RETURNING id",
      [alias, user.id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json(makeError("NOT_FOUND", "Alias not found or not owned by you"));
    }

    return res.json({ deleted: true, alias });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "alias.delete.error", error: err.message, stack: err.stack });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to delete alias"));
  }
});

// ============================================================================
// TUNNEL ID-BASED ROUTES - These must come AFTER /aliases routes
// ============================================================================

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
       LEFT JOIN tunnel_aliases a ON a.owner_user_id = t.owner_user_id 
         AND a.target_port = t.target_port
       WHERE t.id = $1`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json(
        makeError("NOT_FOUND", "Tunnel not found", { id })
      );
    }

    const record = result.rows[0] as TunnelRecord & { alias?: string | null; owner_user_id?: string };

    // Check authorization (user can only see their own tunnels)
    const ownerId = record.ownerUserId || record.owner_user_id;
    if (ownerId !== user.id) {
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

    // Hard delete - tunnels are ephemeral
    await pool.query("DELETE FROM tunnels WHERE id = $1", [id]);

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
       LEFT JOIN tunnel_aliases a ON a.owner_user_id = t.owner_user_id 
         AND a.target_port = t.target_port
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

/**
 * GET /v1/tunnels/:id/stats
 * - If tunnel has alias: return persisted totals by alias (+ current run overlay if available).
 * - If no alias: return in-memory per-token stats from relay.
 */
tunnelRouter.get("/:id/stats", async (req: Request, res: Response) => {
  try {
    const user = req.user;
    if (!user) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
    }

    const { id } = req.params;
    const result = await pool.query(
      `SELECT t.id, t.owner_user_id, t.token, t.target_port, t.status, t.created_at, t.updated_at, t.expires_at, a.alias
       FROM tunnels t
       LEFT JOIN tunnel_aliases a ON a.owner_user_id = t.owner_user_id 
         AND a.target_port = t.target_port
       WHERE t.id = $1 AND t.status <> 'deleted'
       LIMIT 1`,
      [id]
    );
    if (result.rowCount === 0) {
      return res.status(404).json(makeError("NOT_FOUND", "Tunnel not found", { id }));
    }

    const row = result.rows[0] as any;
    const ownerId = row.ownerUserId || row.owner_user_id;
    if (ownerId !== user.id) {
      return res.status(403).json(makeError("FORBIDDEN", "Access denied"));
    }

    const token = row.token as string;
    const alias = row.alias ? String(row.alias) : null;

    const connected = await isTokenConnected(token);
    const relay = await fetchRelayTrafficStats();

    const tokenRun = relay?.byToken?.find((t) => t.token === token) || null;
    const aliasRun = alias ? relay?.byAlias?.find((a) => a.alias === alias) || null : null;

    if (!alias) {
      return res.json({
        id,
        token,
        connected,
        inMemory: tokenRun
          ? {
              requests: Number(tokenRun.requests || 0),
              bytesIn: Number(tokenRun.bytesIn || 0),
              bytesOut: Number(tokenRun.bytesOut || 0),
              lastSeenAt: tokenRun.lastSeenAt ?? null,
              lastStatus: tokenRun.lastStatus ?? null,
              relayRunId: relay?.relayRunId || null,
            }
          : {
              requests: 0,
              bytesIn: 0,
              bytesOut: 0,
              lastSeenAt: null,
              lastStatus: null,
              relayRunId: relay?.relayRunId || null,
            },
      });
    }

    const totalsRes = await pool.query(
      `SELECT alias, requests, bytes_in, bytes_out, last_seen_at, last_status, updated_at
       FROM alias_traffic_totals
       WHERE alias = $1
       LIMIT 1`,
      [alias]
    );
    const totalsRow = totalsRes.rows?.[0] || null;

    return res.json({
      id,
      token,
      alias,
      connected,
      totals: totalsRow
        ? {
            requests: Number(totalsRow.requests || 0),
            bytesIn: Number(totalsRow.bytes_in || 0),
            bytesOut: Number(totalsRow.bytes_out || 0),
            lastSeenAt: totalsRow.last_seen_at || null,
            lastStatus: totalsRow.last_status === null || totalsRow.last_status === undefined ? null : Number(totalsRow.last_status),
            updatedAt: totalsRow.updated_at,
          }
        : {
            requests: 0,
            bytesIn: 0,
            bytesOut: 0,
            lastSeenAt: null,
            lastStatus: null,
            updatedAt: null,
          },
      currentRun: aliasRun
        ? {
            relayRunId: relay?.relayRunId || null,
            requests: Number(aliasRun.requests || 0),
            bytesIn: Number(aliasRun.bytesIn || 0),
            bytesOut: Number(aliasRun.bytesOut || 0),
            lastSeenAt: aliasRun.lastSeenAt ?? null,
            lastStatus: aliasRun.lastStatus ?? null,
          }
        : { relayRunId: relay?.relayRunId || null, requests: 0, bytesIn: 0, bytesOut: 0, lastSeenAt: null, lastStatus: null },
    });
  } catch (error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    logger.error({ event: "tunnel.stats.error", error: err.message, stack: err.stack });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to get tunnel stats"));
  }
});