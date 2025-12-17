import { Request, Response, NextFunction } from "express";
import { pool } from "../db/pool";
import { hashToken } from "../utils/token-hash";
import { makeError } from "../schemas/error";

// Auth with role tagging:
// - Primary: tokens stored in DB (hashed, revocable, optional expiry)
// - Break-glass: raw tokens listed in ADMIN_TOKENS (comma-separated)
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  // Do async work in an IIFE so the middleware signature stays non-async.
  void (async () => {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      return res
        .status(401)
        .json(makeError("UNAUTHORIZED", "Missing or invalid token"));
    }

    const token = auth.slice("Bearer ".length).trim();
    if (!token) {
      return res.status(401).json(makeError("UNAUTHORIZED", "Invalid token"));
    }

    // Break-glass admin tokens (raw) - keep until we're fully confident.
    const adminTokens = (process.env.ADMIN_TOKENS || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    if (adminTokens.includes(token)) {
      (req as any).user = { id: `admin-${token.slice(0, 8)}`, role: "admin" };
      return next();
    }

    // Optional dev token only when using SQLite (local dev convenience).
    const dbUrl =
      process.env.CONTROL_PLANE_DATABASE_URL || "sqlite:./data/control-plane.db";
    const isSqlite = dbUrl.startsWith("sqlite:");
    const devToken = isSqlite ? process.env.AGENTCLOUD_TOKEN_DEV || "dev-token" : "";
    if (devToken && token === devToken) {
      (req as any).user = { id: "dev-user", role: "admin" };
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
        return res.status(401).json(makeError("UNAUTHORIZED", "Invalid token"));
      }

      const row = result.rows[0] as any;
      if (row.revoked_at) {
        return res.status(401).json(makeError("UNAUTHORIZED", "Token revoked"));
      }
      if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
        return res.status(401).json(makeError("UNAUTHORIZED", "Token expired"));
      }

      const role = row.role === "admin" ? "admin" : "user";
      const userId = String(row.user_id || "");
      if (!userId) {
        return res
          .status(500)
          .json(makeError("INTERNAL_ERROR", "Token is missing user_id"));
      }

      (req as any).user = { id: userId, role };
      return next();
    } catch (err: any) {
      console.error("Auth token lookup failed:", err);
      return res
        .status(500)
        .json(makeError("INTERNAL_ERROR", "Auth lookup failed"));
    }
  })();
}