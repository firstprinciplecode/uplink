import fetch from "node-fetch";

export async function unauthenticatedRequest(method: string, path: string, body?: unknown): Promise<any> {
  const apiBase = process.env.AGENTCLOUD_API_BASE || "https://api.uplink.spot";
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(JSON.stringify(json, null, 2));
  }
  return json;
}
