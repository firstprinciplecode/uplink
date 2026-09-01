import { execFileSync, spawn } from "child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
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

// The tunnel token must not appear on the child's argv (it would be readable via
// `ps` by any local user, who could then hijack the tunnel). We pass it through
// the environment instead and keep a 0600 registry mapping pid -> {port, token}
// so `list`/`stop` can still correlate local clients to their API tunnels.
function registryDir(): string {
  return path.join(homedir(), ".uplink", "tunnels");
}

function registryPath(pid: number): string {
  return path.join(registryDir(), `${pid}.json`);
}

function writeTunnelRegistry(pid: number, entry: { port: number; token: string }): void {
  try {
    mkdirSync(registryDir(), { recursive: true, mode: 0o700 });
    writeFileSync(registryPath(pid), JSON.stringify(entry), { mode: 0o600 });
  } catch {
    /* registry is best-effort; token stays out of argv regardless */
  }
}

function readTunnelRegistry(pid: number): { port: number; token: string } | null {
  try {
    const raw = readFileSync(registryPath(pid), "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed?.token === "string" && typeof parsed?.port === "number") {
      return { port: parsed.port, token: parsed.token };
    }
  } catch {
    /* missing/corrupt entry */
  }
  return null;
}

function removeTunnelRegistry(pid: number): void {
  try {
    rmSync(registryPath(pid), { force: true });
  } catch {
    /* ignore */
  }
}

/** Start the local tunnel client in the background (detached). */
export function startTunnelClient(opts: {
  token: string;
  port: number;
  ctrl?: string;
}): { pid: number; clientPath: string } {
  const projectRoot = resolveProjectRoot(__dirname);
  const clientPath = resolveTunnelClientPath();
  // 7443 is the TLS control port; the client enables TLS by default for any
  // non-loopback relay host (see scripts/tunnel/client-improved.js).
  const ctrl = opts.ctrl || process.env.TUNNEL_CTRL || "tunnel.uplink.spot:7443";
  const clientProcess = spawn(
    "node",
    [clientPath, "--port", String(opts.port), "--ctrl", ctrl],
    {
      stdio: "ignore",
      detached: true,
      cwd: projectRoot,
      env: { ...process.env, TUNNEL_TOKEN: opts.token },
    }
  );
  clientProcess.unref();
  if (!clientProcess.pid) {
    throw new Error("Failed to start tunnel client process");
  }
  writeTunnelRegistry(clientProcess.pid, { port: opts.port, token: opts.token });
  return { pid: clientProcess.pid, clientPath };
}

export function findTunnelClients(): TunnelClient[] {
  try {
    // Find processes running client-improved.js (current user, match script path to avoid false positives)
    // execFileSync with an args array: $USER comes from the environment and must
    // never be interpolated into a shell string.
    const user = process.env.USER || "";
    const psArgs = user ? ["-u", user, "-o", "pid=,command="] : ["-eo", "pid=,command="];
    const output = execFileSync("ps", psArgs, { encoding: "utf-8" });
    const lines = output
      .trim()
      .split("\n")
      .filter((line) => line.includes("scripts/tunnel/client-improved.js"));

    const clients: TunnelClient[] = [];
    const livePids = new Set<number>();

    for (const line of lines) {
      // Parse process line: PID COMMAND (from ps -o pid=,command=). The token is
      // no longer on argv, so we only read pid + port here and recover the token
      // from the 0600 registry written at start time.
      const pidMatch = line.match(/^\s*(\d+)/);
      const portMatch = line.match(/--port\s+(\d+)/);
      if (!pidMatch || !portMatch) continue;

      const pid = parseInt(pidMatch[1], 10);
      livePids.add(pid);
      const registry = readTunnelRegistry(pid);
      clients.push({
        pid,
        port: parseInt(portMatch[1], 10),
        token: registry?.token ?? "",
      });
    }

    // Garbage-collect registry entries for clients that are no longer running.
    try {
      for (const file of readdirSync(registryDir())) {
        const pid = parseInt(file.replace(/\.json$/, ""), 10);
        if (Number.isFinite(pid) && !livePids.has(pid)) removeTunnelRegistry(pid);
      }
    } catch {
      /* registry dir may not exist yet */
    }

    return clients;
  } catch {
    return [];
  }
}

export function killTunnelClient(pid: number): boolean {
  removeTunnelRegistry(pid);
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return false;
  }
  try {
    // Grace period after SIGTERM, then SIGKILL if still alive. Pure JS — no shell.
    process.kill(pid, 0);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    process.kill(pid, "SIGKILL");
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

