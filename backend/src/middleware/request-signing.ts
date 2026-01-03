import { Request, Response, NextFunction } from "express";
import { createHmac, timingSafeEqual } from "crypto";
import { makeError } from "../schemas/error";
import { logger } from "../utils/logger";

/**
 * Request signing middleware for internal endpoints.
 * Validates HMAC signatures on requests to prevent replay attacks.
 * 
 * Expected headers:
 *   x-signature: HMAC-SHA256 hex digest of (timestamp + method + path + body)
 *   x-timestamp: Unix timestamp in seconds (must be within 5 minutes of now)
 * 
 * The signature is computed as:
 *   HMAC-SHA256(secret, timestamp + method + path + body)
 * 
 * Usage:
 *   app.use("/internal", requestSigning());
 * 
 * Requires RELAY_INTERNAL_SECRET to be set.
 */
export function requestSigning() {
  const secret = process.env.RELAY_INTERNAL_SECRET || "";
  const MAX_AGE_SECONDS = 5 * 60; // 5 minutes

  // If no secret configured, skip signing (fail-open for compatibility)
  if (!secret) {
    return (req: Request, res: Response, next: NextFunction) => {
      next();
    };
  }

  return (req: Request, res: Response, next: NextFunction) => {
    const signature = req.headers["x-signature"] as string;
    const timestamp = req.headers["x-timestamp"] as string;

    if (!signature || !timestamp) {
      logger.warn({
        event: "request_signing.missing_headers",
        path: req.path,
        ip: req.ip,
      });
      return res.status(401).json(
        makeError("UNAUTHORIZED", "Missing signature or timestamp headers")
      );
    }

    // Validate timestamp (prevent replay attacks)
    const timestampNum = Number(timestamp);
    if (isNaN(timestampNum)) {
      return res.status(400).json(
        makeError("INVALID_REQUEST", "Invalid timestamp format")
      );
    }

    const now = Math.floor(Date.now() / 1000);
    const age = Math.abs(now - timestampNum);
    if (age > MAX_AGE_SECONDS) {
      logger.warn({
        event: "request_signing.timestamp_expired",
        path: req.path,
        ip: req.ip,
        age,
        maxAge: MAX_AGE_SECONDS,
      });
      return res.status(401).json(
        makeError("UNAUTHORIZED", "Request timestamp expired or too far in future")
      );
    }

    // Compute expected signature
    const method = req.method.toUpperCase();
    const path = req.path;
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body || {});
    const message = `${timestamp}${method}${path}${body}`;
    const expectedSignature = createHmac("sha256", secret).update(message).digest("hex");

    // Timing-safe comparison to prevent timing attacks
    if (signature.length !== expectedSignature.length) {
      return res.status(401).json(
        makeError("UNAUTHORIZED", "Invalid signature")
      );
    }

    try {
      const signatureBuf = Buffer.from(signature, "hex");
      const expectedBuf = Buffer.from(expectedSignature, "hex");
      if (!timingSafeEqual(signatureBuf, expectedBuf)) {
        logger.warn({
          event: "request_signing.invalid_signature",
          path: req.path,
          ip: req.ip,
        });
        return res.status(401).json(
          makeError("UNAUTHORIZED", "Invalid signature")
        );
      }
    } catch (err) {
      logger.error({
        event: "request_signing.error",
        error: err instanceof Error ? err.message : String(err),
      });
      return res.status(500).json(
        makeError("INTERNAL_ERROR", "Signature validation failed")
      );
    }

    next();
  };
}
