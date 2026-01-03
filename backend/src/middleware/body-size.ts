import { Request, Response, NextFunction } from "express";
import bodyParser from "body-parser";
import { makeError } from "../schemas/error";

/**
 * Per-route body size limit middleware.
 * Overrides the global body parser limit for specific routes.
 * 
 * Usage:
 *   app.post("/v1/tunnels", bodySizeLimit("1mb"), handler);
 * 
 * @param limit - Size limit (e.g., "1mb", "500kb", "10mb")
 */
export function bodySizeLimit(limit: string) {
  return bodyParser.json({ limit });
}

/**
 * Pre-configured body size limits for common endpoints
 */
export const bodySizeLimits = {
  // Small payloads (tunnel creation, token operations)
  small: bodyParser.json({ limit: "1mb" }),
  // Medium payloads (database operations, bulk operations)
  medium: bodyParser.json({ limit: "5mb" }),
  // Large payloads (file uploads, bulk data)
  large: bodyParser.json({ limit: "50mb" }),
};
