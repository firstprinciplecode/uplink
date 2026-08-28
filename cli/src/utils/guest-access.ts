import fetch from "node-fetch";
import { getResolvedApiBase, getResolvedApiToken } from "./api-base";
import { readStoredCredentials, writeStoredCredentials } from "./credentials";

type GuestSignup = {
  token: string;
  userId: string;
  accountType?: "guest";
};

export async function ensureGuestAccess(options: { force?: boolean } = {}): Promise<void> {
  const apiBase = getResolvedApiBase();
  // force: mint a fresh guest token even when one resolves (e.g. it was rejected by the API).
  if (!options.force && getResolvedApiToken(apiBase)) return;

  const response = await fetch(`${apiBase}/v1/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ label: "Automatic guest access" }),
  });
  const json = (await response.json().catch(() => ({}))) as GuestSignup & {
    error?: { code?: string; message?: string };
  };
  if (!response.ok || !json.token) {
    const code = json.error?.code || "GUEST_ACCESS_FAILED";
    const message = json.error?.message || response.statusText;
    throw new Error(`${code}: ${message}`);
  }

  writeStoredCredentials({
    ...(readStoredCredentials() ?? {}),
    token: json.token,
    userId: json.userId,
    accountType: "guest",
    apiBase,
  });
  process.env.AGENTCLOUD_TOKEN = json.token;
}
