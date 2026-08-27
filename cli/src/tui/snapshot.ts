import fetch from "node-fetch";
import { connectedProviders } from "../registrars";
import { health, tunnelClients } from "../subcommands/menu/effects";
import { getResolvedApiBase, getResolvedApiToken } from "../utils/api-base";
import type { MenuStatus } from "./App";

const SNAPSHOT_TIMEOUT_MS = 2000;
const ARTIFACT_CAP_BYTES = 500_000_000;

export { ARTIFACT_CAP_BYTES };

type JsonObject = Record<string, unknown>;

function localTunnels(): MenuStatus["tunnels"] {
  const domain = process.env.TUNNEL_DOMAIN || "x.uplink.spot";
  const scheme = (process.env.TUNNEL_URL_SCHEME || "https").toLowerCase();
  return tunnelClients.findTunnelClients().map((client) => ({
    url: `${scheme}://${client.token}.${domain}`,
    port: client.port,
  }));
}

async function apiGet(path: string, timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<unknown | null> {
  const apiBase = getResolvedApiBase();
  const token = getResolvedApiToken(apiBase);
  if (!token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${apiBase}${path}`, {
      signal: controller.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function fetchApps(): Promise<MenuStatus["apps"]> {
  const body = asObject(await apiGet("/v1/apps"));
  const apps = body?.apps;
  if (!Array.isArray(apps)) return [];
  const parsed: MenuStatus["apps"] = [];
  for (const item of apps) {
    const rec = asObject(item);
    if (!rec) continue;
    const name = asString(rec.name);
    const id = asString(rec.id);
    if (!name || !id) continue;
    parsed.push({
      name,
      id,
      url: asString(rec.url),
      createdAt: asString(rec.createdAt),
    });
  }
  return parsed;
}

async function fetchHealth(): Promise<{ connected: boolean; latencyMs: number | null }> {
  const started = Date.now();
  const healthRes = await health.checkApiHealth({});
  if (!healthRes.ok) return { connected: false, latencyMs: null };
  return { connected: true, latencyMs: Date.now() - started };
}

export async function fetchMenuSnapshot(): Promise<MenuStatus> {
  const tunnels = localTunnels();
  const [healthStatus, apps, providers] = await Promise.all([
    fetchHealth(),
    fetchApps(),
    Promise.resolve(connectedProviders()),
  ]);
  return {
    connected: healthStatus.connected,
    latencyMs: healthStatus.latencyMs,
    tunnels,
    apps,
    providers,
  };
}

export type AppInspect = {
  name: string;
  url: string;
  createdAt?: string;
  deploy?: string;
  build?: string;
  sizeBytes?: number;
  domains: { hostname: string; verified: boolean }[];
};

export async function fetchAppInspect(id: string): Promise<AppInspect | null> {
  const [statusBody, domainsBody] = await Promise.all([
    apiGet(`/v1/apps/${id}/status`),
    apiGet(`/v1/apps/${id}/domains`),
  ]);
  const status = asObject(statusBody);
  if (!status) return null;
  const app = asObject(status.app);
  const release = asObject(status.activeRelease);
  const deployment = asObject(status.activeDeployment);
  const domainList = asObject(domainsBody)?.domains;
  const domains: AppInspect["domains"] = [];
  if (Array.isArray(domainList)) {
    for (const item of domainList) {
      const rec = asObject(item);
      const hostname = rec ? asString(rec.hostname) : undefined;
      if (!hostname) continue;
      domains.push({ hostname, verified: rec?.verified === true });
    }
  }
  const size = release?.sizeBytes;
  return {
    name: asString(app?.name) || id,
    url: asString(app?.url) || "",
    createdAt: asString(app?.createdAt),
    deploy: asString(deployment?.status),
    build: asString(release?.buildStatus),
    sizeBytes: typeof size === "number" && Number.isFinite(size) ? size : undefined,
    domains,
  };
}

export async function fetchAppLogs(id: string): Promise<string> {
  const body = asObject(await apiGet(`/v1/apps/${id}/logs`, 4000));
  if (!body) return "No logs available.";
  const lines = body.lines;
  if (!Array.isArray(lines) || lines.length === 0) return "No log lines.";
  return lines
    .filter((line): line is string => typeof line === "string")
    .slice(-40)
    .join("\n");
}
