import { execSync, spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { resolveProjectRoot } from "../../../utils/project-root";

export type TunnelClient = { pid: number; port: number; token: string };

export function resolveTunnelClientPath(): string {
  const projectRoot = resolveProjectRoot(__dirname);
  const clientPath = path.join(projectRoot, "scripts/tunnel/client-improved.js");
  if (!existsSync(clientPath)) {
    throw new Error(`Tunnel client not found at ${clientPath}`);
  }
  return clientPath;
}

/** Start the local tunnel client in the background (detached). */
export function startTunnelClient(opts: {
  token: string;
  port: number;
  ctrl?: string;
}): { pid: number; clientPath: string } {
  const projectRoot = resolveProjectRoot(__dirname);
  const clientPath = resolveTunnelClientPath();
  const ctrl = opts.ctrl || process.env.TUNNEL_CTRL || "tunnel.uplink.spot:7071";
  const clientProcess = spawn(
    "node",
    [clientPath, "--token", opts.token, "--port", String(opts.port), "--ctrl", ctrl],
    {
      stdio: "ignore",
      detached: true,
      cwd: projectRoot,
    }
  );
  clientProcess.unref();
  if (!clientProcess.pid) {
    throw new Error("Failed to start tunnel client process");
  }
  return { pid: clientProcess.pid, clientPath };
}

export function findTunnelClients(): TunnelClient[] {
  try {
    // Find processes running client-improved.js (current user, match script path to avoid false positives)
    const user = process.env.USER || "";
    const psCmd = user ? `ps -u ${user} -o pid=,command=` : "ps -eo pid=,command=";
    const output = execSync(psCmd, { encoding: "utf-8" });
    const lines = output
      .trim()
      .split("\n")
      .filter((line) => line.includes("scripts/tunnel/client-improved.js"));

    const clients: TunnelClient[] = [];

    for (const line of lines) {
      // Parse process line: PID COMMAND (from ps -o pid=,command=)
      const pidMatch = line.match(/^\s*(\d+)/);
      const tokenMatch = line.match(/--token\s+(\S+)/);
      const portMatch = line.match(/--port\s+(\d+)/);

      if (pidMatch && tokenMatch && portMatch) {
        clients.push({
          pid: parseInt(pidMatch[1], 10),
          port: parseInt(portMatch[1], 10),
          token: tokenMatch[1],
        });
      }
    }

    return clients;
  } catch {
    return [];
  }
}

export function killTunnelClient(pid: number): boolean {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  try {
    execSync(`kill -0 ${pid} && sleep 0.4 && kill -KILL ${pid} || true`, {
      stdio: "ignore",
    });
  } catch {
    /* process already gone */
  }
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

export function killAllTunnelClients(clients: TunnelClient[]): number {
  let killed = 0;
  for (const c of clients) {
    if (killTunnelClient(c.pid)) killed++;
  }
  return killed;
}

type ApiTunnel = { id?: string; token?: string; connected?: boolean };

type ApiRequest = (method: string, path: string, body?: unknown) => Promise<any>;

export async function stopTunnelClients(
  apiRequest: ApiRequest,
  clients: TunnelClient[],
  opts: { connectedGhosts?: boolean } = {}
): Promise<{ killed: number; deleted: number }> {
  const tokens = new Set(clients.map((c) => c.token));
  let deleted = 0;

  try {
    const result = await apiRequest("GET", "/v1/tunnels");
    const tunnels = (result.tunnels || []) as ApiTunnel[];
    for (const tunnel of tunnels) {
      if (!tunnel.id) continue;
      const matched = Boolean(tunnel.token && tokens.has(tunnel.token));
      const ghost = Boolean(opts.connectedGhosts && tunnel.connected);
      if (!matched && !ghost) continue;
      try {
        await apiRequest("DELETE", `/v1/tunnels/${tunnel.id}`);
        deleted++;
      } catch {
        /* keep stopping the rest */
      }
    }
  } catch {
    /* still kill local processes */
  }

  let killed = 0;
  for (const c of clients) {
    if (killTunnelClient(c.pid)) killed++;
  }
  return { killed, deleted };
}

/**
 * Create a tunnel via API and start the local client in background.
 * NOTE: Maintains existing behavior including the brief post-spawn delay.
 */
export async function createAndStartTunnel(apiRequest: ApiRequest, port: number): Promise<string> {
  // Check if tunnel already running on this port
  const existing = findTunnelClients().filter((c) => c.port === port);
  if (existing.length > 0) {
    return [
      `⚠ Tunnel already running on port ${port}`,
      ``,
      `→ PID: ${existing[0].pid}`,
      `→ Token: ${existing[0].token.substring(0, 8)}...`,
      ``,
      `Use "Stop Tunnel" first to disconnect the existing tunnel.`,
    ].join("\n");
  }

  // Create tunnel
  const result = await apiRequest("POST", "/v1/tunnels", { port });
  const url = result.url || "(no url)";
  const token = result.token || "(no token)";
  const alias = result.alias || null;

  startTunnelClient({ token, port });

  // Wait a moment for client to connect
  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  } catch {
    /* ignore */
  }

  const lines = [`✓ Tunnel created and client started`, ``, `→ Public URL    ${url}`];

  if (alias) {
    // Use aliasUrl from backend if available, otherwise construct it
    const aliasUrl = result.aliasUrl || `https://${alias}.uplink.spot`;
    lines.push(`→ Alias         ${alias}`);
    lines.push(`→ Alias URL     ${aliasUrl}`);
  }

  lines.push(
    `→ Token         ${token}`,
    `→ Local port    ${port}`,
    ``,
    `Tunnel client running in background.`,
    `Use "Stop Tunnel" to disconnect.`
  );

  return lines.join("\n");
}

