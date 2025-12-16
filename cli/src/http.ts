import fetch from "node-fetch";

// Default to production API if not specified
const API_BASE = process.env.AGENTCLOUD_API_BASE ?? "https://api.uplink.spot";
const isLocalApiBase =
  API_BASE.includes("://localhost") ||
  API_BASE.includes("://127.0.0.1") ||
  API_BASE.includes("://0.0.0.0");
const API_TOKEN =
  process.env.AGENTCLOUD_TOKEN ??
  (isLocalApiBase ? process.env.AGENTCLOUD_TOKEN_DEV || "dev-token" : "dev-token");

export async function apiRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<any> {
  if (!API_TOKEN) {
    throw new Error(
      "Missing AGENTCLOUD_TOKEN (required when AGENTCLOUD_API_BASE is non-local)"
    );
  }

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_TOKEN}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(JSON.stringify(json, null, 2));
  }

  return json;
}



