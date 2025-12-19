import { Request, Response, NextFunction } from "express";
import { pool } from "../db/pool";
import { hashToken } from "../utils/token-hash";
import { makeError } from "../schemas/error";
import { logger, auditLog } from "../utils/logger";
import { config } from "../utils/config";

// Auth with role tagging:
// - Primary: tokens stored in DB (hashed, revocable, optional expiry)
// - Break-glass: raw tokens listed in ADMIN_TOKENS (comma-separated)
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Skip auth for public signup endpoint
  if (req.path === "/v1/signup" || req.path.startsWith("/v1/signup/")) {
    return next();
  }

  // Do async work in an IIFE so the middleware signature stays non-async.
  void (async () => {
    const auth = req.headers.authorization;
    const clientIp = req.ip || req.socket.remoteAddress;

    if (!auth || !auth.startsWith("Bearer ")) {
      auditLog.authFailed("Missing or invalid authorization header", clientIp);
      return res
        .status(401)
        .json(makeError("UNAUTHORIZED", "Missing or invalid token"));
    }

    const token = auth.slice("Bearer ".length).trim();
    if (!token) {
      auditLog.authFailed("Empty token", clientIp);
      return res.status(401).json(makeError("UNAUTHORIZED", "Invalid token"));
    }

    // Break-glass admin tokens (raw) - keep until we're fully confident.
    if (config.adminTokens.includes(token)) {
      const userId = `admin-${token.slice(0, 8)}`;
      req.user = { id: userId, role: "admin" };
      auditLog.authSuccess(userId, "admin", clientIp);
      return next();
    }

    // Optional dev token only when using SQLite (local dev convenience).
    const dbUrl = config.databaseUrl;
    const isSqlite = dbUrl.startsWith("sqlite:");
    const devToken = isSqlite ? process.env.AGENTCLOUD_TOKEN_DEV || "dev-token" : "";
    if (devToken && token === devToken) {
      req.user = { id: "dev-user", role: "admin" };
      auditLog.authSuccess("dev-user", "admin", clientIp);
      return next();
    }

    // DB-backed token lookup (hashed)
    try {
      const tokenHash = hashToken(token);
      const result = await pool.query(
        "SELECT role, user_id, revoked_at, expires_at FROM tokens WHERE token_hash = $1",
        [tokenHash]
      );

      if (result.rowCount === 0) {
        auditLog.authFailed("Token not found in database", clientIp);
        return res.status(401).json(makeError("UNAUTHORIZED", "Invalid token"));
      }

      const row = result.rows[0] as { role: string; user_id: string; revoked_at: string | null; expires_at: string | null };
      if (row.revoked_at) {
        auditLog.authFailed("Token revoked", clientIp);
        return res.status(401).json(makeError("UNAUTHORIZED", "Token revoked"));
      }
      if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
        auditLog.authFailed("Token expired", clientIp);
        return res.status(401).json(makeError("UNAUTHORIZED", "Token expired"));
      }

      const role = row.role === "admin" ? "admin" : "user";
      const userId = String(row.user_id || "");
      if (!userId) {
        logger.error({ event: "auth.error", error: "Token missing user_id", tokenHash: tokenHash.substring(0, 16) });
        return res
          .status(500)
          .json(makeError("INTERNAL_ERROR", "Token is missing user_id"));
      }

      req.user = { id: userId, role };
      auditLog.authSuccess(userId, role, clientIp);
      return next();
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ event: "auth.error", error: error.message, stack: error.stack });
      auditLog.authFailed("Database lookup failed", clientIp);
      return res
        .status(500)
        .json(makeError("INTERNAL_ERROR", "Auth lookup failed"));
    }
  })();
}