import fetch from "node-fetch";

export async function checkApiHealth(args: {
  apiBase?: string;
  healthUrl?: string;
  relayInternalSecret?: string;
  timeoutMs?: number;
}): Promise<{ ok: boolean; status: number | null }> {
  const apiBase = args.apiBase || process.env.AGENTCLOUD_API_BASE || "https://api.uplink.spot";
  const healthUrl = args.healthUrl || process.env.RELAY_HEALTH_URL || `${apiBase}/health`;
  const relayInternalSecret = args.relayInternalSecret ?? process.env.RELAY_INTERNAL_SECRET ?? "";
  const timeoutMs = args.timeoutMs ?? 2000;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {};
    if (relayInternalSecret) headers["x-relay-internal-secret"] = relayInternalSecret;
    const res = await fetch(healthUrl, { signal: controller.signal, headers });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: null };
  } finally {
    clearTimeout(timer);
  }
}

