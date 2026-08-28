import fetch from "node-fetch";
import { getResolvedApiBase, getResolvedApiToken } from "../../utils/api-base";

export async function unauthenticatedRequest(
  method: string,
  path: string,
  body?: unknown,
  options: { includeCurrentToken?: boolean } = {}
): Promise<any> {
  const apiBase = getResolvedApiBase();
  const token = options.includeCurrentToken ? getResolvedApiToken(apiBase) : undefined;
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(JSON.stringify(json, null, 2));
  }
  return json;
}
