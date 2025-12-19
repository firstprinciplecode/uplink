import fetch from "node-fetch";

function getApiBase(): string {
  return process.env.AGENTCLOUD_API_BASE ?? "https://api.uplink.spot";
}

function isLocalApiBase(apiBase: string): boolean {
  return (
    apiBase.includes("://localhost") ||
    apiBase.includes("://127.0.0.1") ||
    apiBase.includes("://0.0.0.0")
  );
}

function getApiToken(apiBase: string): string | undefined {
  // Production (non-local) always requires an explicit token.
  if (!isLocalApiBase(apiBase)) {
    return process.env.AGENTCLOUD_TOKEN || undefined;
  }

  // Local dev convenience:
  // - Prefer AGENTCLOUD_TOKEN if set
  // - Otherwise allow AGENTCLOUD_TOKEN_DEV / dev-token
  return (
    process.env.AGENTCLOUD_TOKEN ||
    process.env.AGENTCLOUD_TOKEN_DEV ||
    "dev-token"
  );
}

export async function apiRequest(
  method: string,
  path: string,
  body?: unknown
): Promise<any> {
  const apiBase = getApiBase();
  const apiToken = getApiToken(apiBase);
  if (!apiToken) {
    throw new Error("Missing AGENTCLOUD_TOKEN");
  }

  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(JSON.stringify(json, null, 2));
  }

  return json;
}



