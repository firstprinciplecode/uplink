import { Request, Response, NextFunction } from "express";

// Simple auth stub with role tagging:
// - Admins: tokens listed in ADMIN_TOKENS (comma-separated) or dev-token
// - Users: any other non-empty token
// TODO: Replace with real JWT/API key validation and user lookup
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
  const adminTokens = (
    process.env.ADMIN_TOKENS || devToken
  )
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  if (!token) {
    return res.status(401).json({
      error: { code: "UNAUTHORIZED", message: "Invalid token" },
    });
  }

  const isAdmin = adminTokens.includes(token);
  const role = isAdmin ? "admin" : "user";
  const userId = isAdmin
    ? token === devToken
      ? "dev-user"
      : `admin-${token.slice(0, 8)}`
    : `user-${token.slice(0, 8)}`;

  (req as any).user = { id: userId, role };
  return next();
}