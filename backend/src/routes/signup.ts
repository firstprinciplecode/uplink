import { Router, Request, Response } from "express";
import { pool } from "../db/pool";
import { makeError } from "../schemas/error";
import { randomUUID, randomBytes } from "crypto";
import { hashToken, tokenPrefix } from "../utils/token-hash";
import { validateBody } from "../middleware/validate";
import { signupSchema } from "../schemas/validation";
import { signupRateLimiter } from "../middleware/rate-limit";
import { logger, auditLog } from "../utils/logger";

export const signupRouter = Router();

/**
 * POST /v1/signup
 * Public endpoint for users to create their own tokens (user role only)
 * No authentication required - this is the onboarding endpoint
 */
signupRouter.post(
  "/",
  signupRateLimiter, // Stricter rate limiting for public signup
  validateBody(signupSchema),
  async (req: Request, res: Response) => {
    try {
      const { label, expiresInDays } = req.body;

      // Always create user role tokens (not admin) via public signup
      const role = "user";
      const id = `tok_${randomUUID()}`;
      const rawToken = randomBytes(32).toString("hex"); // 64-char high-entropy token
      const tokHash = hashToken(rawToken);
      const prefix = tokenPrefix(rawToken, 8);
      const userId = `user_${randomUUID()}`;

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
          label || "Self-registered",
          userId, // Self-created, so created_by_user_id is the same as user_id
          now.toISOString(),
          expiresAt ? expiresAt.toISOString() : null,
        ]
      );

      auditLog.tokenCreated(userId, id, role);

      logger.info({
        event: "signup.success",
        userId,
        tokenId: id,
        ip: req.ip,
        label: label || "Self-registered",
      });

      return res.status(201).json({
        id,
        token: rawToken, // return once - this is the only time the user sees it
        tokenPrefix: prefix,
        role,
        userId,
        label: label || "Self-registered",
        createdAt: now.toISOString(),
        expiresAt: expiresAt ? expiresAt.toISOString() : null,
        message: "Token created successfully. Save this token securely - it will not be shown again.",
      });
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      logger.error({
        event: "signup.error",
        error: err.message,
        stack: err.stack,
        ip: req.ip,
      });
      return res
        .status(500)
        .json(makeError("INTERNAL_ERROR", "Failed to create token", { error: err.message }));
    }
  }
);


