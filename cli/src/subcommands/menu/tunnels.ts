import { spawn, execSync } from "child_process";
import { join } from "path";
import { apiRequest } from "../../http";

export async function createAndStartTunnel(port: number): Promise<string> {
  const result = await apiRequest("POST", "/v1/tunnels", { port });
  const url = result.url || "(no url)";
  const token = result.token || "(no token)";
  const ctrl = process.env.TUNNEL_CTRL || "tunnel.uplink.spot:7071";

  const path = require("path");
  const projectRoot = path.join(__dirname, "../../..");
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

  return [
    `✓ Tunnel created and client started`,
    ``,
    `→ Public URL    ${url}`,
    `→ Token         ${token}`,
    `→ Local port    ${port}`,
    ``,
    `Tunnel client running in background.`,
    `Use "Stop Tunnel" to disconnect.`,
  ].join("\n");
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
