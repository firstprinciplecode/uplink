import { unauthenticatedRequest } from "../subcommands/menu/requests";
import { getResolvedApiBase } from "./api-base";
import { writeStoredCredentials } from "./credentials";

export type LoginToken = {
  id: string;
  token: string;
  tokenPrefix: string;
  role: string;
  userId: string;
  label: string;
  createdAt: string;
  expiresAt: string | null;
  message?: string;
};

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export function isEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizeEmail(raw));
}

export async function requestLoginCode(email: string): Promise<{ ok: boolean; message?: string }> {
  return unauthenticatedRequest(
    "POST",
    "/v1/auth/otp/request",
    { email: normalizeEmail(email) },
    { includeCurrentToken: true }
  );
}

export async function verifyLoginCode(email: string, code: string): Promise<LoginToken> {
  return unauthenticatedRequest(
    "POST",
    "/v1/auth/otp/verify",
    {
      email: normalizeEmail(email),
      code: code.trim(),
    },
    { includeCurrentToken: true }
  );
}

export function persistLogin(result: { token: string; userId: string }, email?: string): string {
  const apiBase = getResolvedApiBase();
  const path = writeStoredCredentials({
    token: result.token,
    userId: result.userId,
    email,
    accountType: email ? "verified" : "guest",
    apiBase,
  });
  process.env.AGENTCLOUD_TOKEN = result.token;
  return path;
}
