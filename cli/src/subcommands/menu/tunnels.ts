import { spawn, execSync } from "child_process";
import { join } from "path";
import { apiRequest } from "../../http";
import { resolveProjectRoot } from "../../utils/project-root";

export async function createAndStartTunnel(port: number): Promise<string> {
  // Check if tunnel already running on this port
  const existing = findTunnelClients().filter(c => c.port === port);
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

  const result = await apiRequest("POST", "/v1/tunnels", { port });
  const url = result.url || "(no url)";
  const token = result.token || "(no token)";
  const alias = result.alias || null;
  const ctrl = process.env.TUNNEL_CTRL || "tunnel.uplink.spot:7071";

  const path = require("path");
  const projectRoot = resolveProjectRoot(__dirname);
  const clientPath = path.join(projectRoot, "scripts/tunnel/client-improved.js");
  const clientProcess = spawn("node", [clientPath, "--token", token, "--port", String(port), "--ctrl", ctrl], {
    stdio: "ignore",
    detached: true,
    cwd: projectRoot,
  });
  clientProcess.unref();

  await new Promise((resolve) => setTimeout(resolve, 2000));

  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  } catch {
    /* ignore */
  }

  const lines = [
    `✓ Tunnel created and client started`,
    ``,
    `→ Public URL    ${url}`,
  ];
  
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
    `Use "Stop Tunnel" to disconnect.`,
  );
  
  return lines.join("\n");
}

export function findTunnelClients(): Array<{ pid: number; port: number; token: string }> {
  try {
    const user = process.env.USER || "";
    const psCmd = user ? `ps -u ${user} -o pid=,command=` : "ps -eo pid=,command=";
    const output = execSync(psCmd, { encoding: "utf-8" });
    const lines = output
      .trim()
      .split("\n")
      .filter((line) => line.includes("scripts/tunnel/client-improved.js"));

    const clients: Array<{ pid: number; port: number; token: string }> = [];

    for (const line of lines) {
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
