import { Request, Response, NextFunction } from "express";

// Simple auth stub: accepts Bearer dev-token or any token for now
// TODO: Replace with real JWT/API key validation
export function authMiddleware(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) {
    return res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Missing or invalid token" },
    });
  }

  const token = auth.slice("Bearer ".length);
  const devToken = process.env.AGENTCLOUD_TOKEN_DEV || "dev-token";

  // For now, accept dev-token or any non-empty token
  // In production, validate JWT or check API key against DB
  if (token === devToken || token.length > 0) {
    (req as any).user = { id: token === devToken ? "dev-user" : `user-${token.slice(0, 8)}` };
    return next();
  }

  return res.status(401).json({
    error: { code: "UNAUTHORIZED", message: "Invalid token" },
  });
}




