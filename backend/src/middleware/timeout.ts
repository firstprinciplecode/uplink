import { Request, Response, NextFunction } from "express";
import { logger } from "../utils/logger";

/**
 * Request timeout middleware to prevent slow-request DoS attacks.
 * Sets a timeout on the request/response cycle and terminates if exceeded.
 */
export function requestTimeout(timeoutMs: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const timer = setTimeout(() => {
      if (!res.headersSent) {
        logger.warn({
          event: "request.timeout",
          path: req.path,
          method: req.method,
          ip: req.ip,
          timeoutMs,
        });
        res.status(504).json({
          code: "REQUEST_TIMEOUT",
          message: "Request timeout - the server took too long to respond",
        });
        // Force close the connection
        res.end();
      }
    }, timeoutMs);

    // Clear timeout when response finishes
    res.on("finish", () => {
      clearTimeout(timer);
    });

    // Clear timeout on error
    res.on("close", () => {
      clearTimeout(timer);
    });

    next();
  };
}

// Default timeout: 30 seconds (reasonable for most API endpoints)
export const defaultTimeout = requestTimeout(30 * 1000);

// Long timeout: 5 minutes (for endpoints that may take longer, e.g., database provisioning)
export const longTimeout = requestTimeout(5 * 60 * 1000);
