import rateLimit from "express-rate-limit";
import { Request, Response } from "express";
import { makeError } from "../schemas/error";
import { logger } from "../utils/logger";

// General API rate limiter
export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  handler: (req: Request, res: Response) => {
    logger.warn({
      event: "rate_limit.exceeded",
      ip: req.ip,
      path: req.path,
    });
    res.status(429).json(
      makeError("RATE_LIMIT_EXCEEDED", "Too many requests, please try again later.")
    );
  },
});

// Stricter rate limiter for auth endpoints
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Limit each IP to 10 auth attempts per windowMs
  message: "Too many authentication attempts, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    logger.warn({
      event: "rate_limit.auth_exceeded",
      ip: req.ip,
      path: req.path,
    });
    res.status(429).json(
      makeError("RATE_LIMIT_EXCEEDED", "Too many authentication attempts, please try again later.")
    );
  },
});

// Rate limiter for token creation (admin only, but still rate limit)
export const tokenCreationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20, // Limit to 20 token creations per hour
  message: "Too many token creation requests, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    logger.warn({
      event: "rate_limit.token_creation_exceeded",
      ip: req.ip,
      path: req.path,
    });
    res.status(429).json(
      makeError("RATE_LIMIT_EXCEEDED", "Too many token creation requests, please try again later.")
    );
  },
});

// Rate limiter for tunnel creation
export const tunnelCreationRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // Limit to 50 tunnel creations per hour per IP
  message: "Too many tunnel creation requests, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    logger.warn({
      event: "rate_limit.tunnel_creation_exceeded",
      ip: req.ip,
      path: req.path,
    });
    res.status(429).json(
      makeError("RATE_LIMIT_EXCEEDED", "Too many tunnel creation requests, please try again later.")
    );
  },
});

// Stricter rate limiter for public signup (to prevent abuse)
export const signupRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // Limit to 5 signups per hour per IP (stricter than admin token creation)
  message: "Too many signup requests, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    logger.warn({
      event: "rate_limit.signup_exceeded",
      ip: req.ip,
      path: req.path,
    });
    res.status(429).json(
      makeError("RATE_LIMIT_EXCEEDED", "Too many signup requests, please try again later.")
    );
  },
});

// Rate limiter for unauthenticated internal endpoints (e.g., Caddy ask endpoint)
// NOTE: Keep this fairly high because legitimate usage can spike during certificate issuance/renewal,
// but still protect against DoS and enumeration attempts.
export const internalAllowTlsRateLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 120, // 120/min per IP
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req: Request, res: Response) => {
    logger.warn({
      event: "rate_limit.internal_allow_tls_exceeded",
      ip: req.ip,
      path: req.path,
    });
    res.status(429).json(
      makeError("RATE_LIMIT_EXCEEDED", "Too many requests, please try again later.")
    );
  },
});

