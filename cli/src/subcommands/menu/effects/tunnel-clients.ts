import { execSync, spawn } from "child_process";
import { resolveProjectRoot } from "../../utils/project-root";

export type TunnelClient = { pid: number; port: number; token: string };

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
    execSync(`kill -TERM ${pid}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function killAllTunnelClients(clients: TunnelClient[]): number {
  let killed = 0;
  for (const c of clients) {
    if (killTunnelClient(c.pid)) killed++;
  }
  return killed;
}

type ApiRequest = (method: string, path: string, body?: unknown) => Promise<any>;

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
  const ctrl = process.env.TUNNEL_CTRL || "tunnel.uplink.spot:7071";

  // Start tunnel client in background
  // (CommonJS build: __dirname available)
  const path = require("path");
  const projectRoot = resolveProjectRoot(__dirname);
  const clientPath = path.join(projectRoot, "scripts/tunnel/client-improved.js");
  const clientProcess = spawn("node", [clientPath, "--token", token, "--port", String(port), "--ctrl", ctrl], {
    stdio: "ignore",
    detached: true,
    cwd: projectRoot,
  });
  clientProcess.unref();

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

