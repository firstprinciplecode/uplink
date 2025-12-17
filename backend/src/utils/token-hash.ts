import { createHmac } from "crypto";

/**
 * Hash a raw token for storage/lookup.
 *
 * We use HMAC-SHA256 with an optional server-side pepper so that a DB leak
 * does not directly expose raw tokens.
 *
 * If CONTROL_PLANE_TOKEN_PEPPER is not set, tokens are still high-entropy,
 * but setting a pepper is strongly recommended for production.
 */
export function hashToken(rawToken: string): string {
  const pepper = process.env.CONTROL_PLANE_TOKEN_PEPPER || "";
  return createHmac("sha256", pepper).update(rawToken).digest("hex");
}

export function tokenPrefix(rawToken: string, len = 8): string {
  return rawToken.slice(0, Math.max(0, len));
}



