import { isBackInput } from "../io";
import type { MenuChoice } from "../types";
import type { SelectOption } from "../inline-tree-select";

type Deps = {
  apiRequest: (method: string, path: string, body?: unknown) => Promise<any>;
  promptLine: (question: string) => Promise<string>;
  restoreRawMode: () => void;
  truncate: (text: string, max: number) => string;
  formatBytes: (bytes: number) => string;
  inlineSelect: (
    title: string,
    options: SelectOption[],
    includeBack?: boolean
  ) => Promise<{ index: number; value: string | number | null } | null>;
  scanCommonPorts: () => Promise<number[]>;
  findTunnelClients: () => Array<{ pid: number; port: number; token: string }>;
  createAndStartTunnel: (port: number) => Promise<string>;
  killTunnelClient: (pid: number) => boolean;
  killAllTunnelClients: (clients: Array<{ pid: number; port: number; token: string }>) => number;
  colorDim: (text: string) => string;
  colorRed: (text: string) => string;
};

export function buildManageTunnelsMenu(deps: Deps): MenuChoice {
  const {
    apiRequest,
    promptLine,
    restoreRawMode,
    truncate,
    formatBytes,
    inlineSelect,
    scanCommonPorts,
    findTunnelClients,
    createAndStartTunnel,
    killTunnelClient,
    killAllTunnelClients,
    colorDim,
    colorRed,
  } = deps;

  return {
    label: "Share",
    subMenu: [
      {
        label: "Start (Auto)",
        action: async () => {
          try {
            // Scan for active ports
            console.log(colorDim("\nScanning for active servers..."));

            // Temporarily disable raw mode for scanning
            try {
              process.stdin.setRawMode(false);
            } catch {
              /* ignore */
            }
            const activePorts = await scanCommonPorts();

            // Filter out ports that already have tunnels running
            const runningTunnels = findTunnelClients();
            const portsWithTunnels = new Set(runningTunnels.map((t) => t.port));
            const availablePorts = activePorts.filter((p) => !portsWithTunnels.has(p));

            if (availablePorts.length === 0) {
              // No ports found - show selector with just custom option and back
              const options: SelectOption[] = [{ label: "Enter custom port", value: "custom" }];

              const result = await inlineSelect("No active servers detected", options, true);

              if (result === null) {
                // User selected Back
                restoreRawMode();
                return ""; // Return empty to go back without message
              }

              // Custom port entry
              try {
                process.stdin.setRawMode(false);
              } catch {
                /* ignore */
              }
              const answer = await promptLine('Enter port number (default 3000, or "back"): ');
              if (isBackInput(answer)) {
                restoreRawMode();
                return "";
              }
              const port = Number(answer) || 3000;
              restoreRawMode();
              return await createAndStartTunnel(port);
            }

            // Build options from found ports (excluding those with running tunnels)
            const options: SelectOption[] = availablePorts.map((port) => ({
              label: `Port ${port}`,
              value: port,
            }));
            // Show ports with running tunnels as info
            if (portsWithTunnels.size > 0) {
              for (const port of portsWithTunnels) {
                options.push({ label: `Port ${port} (tunnel running)`, value: `skip-${port}` });
              }
            }
            options.push({ label: "Enter custom port", value: "custom" });

            const result = await inlineSelect("Select port to expose", options, true);

            if (result === null) {
              // User selected Back
              restoreRawMode();
              return ""; // Return empty to go back without message
            }

            let port: number;
            if (result.value === "custom") {
              // Custom port entry
              try {
                process.stdin.setRawMode(false);
              } catch {
                /* ignore */
              }
              const answer = await promptLine('Enter port number (default 3000, or "back"): ');
              if (isBackInput(answer)) {
                restoreRawMode();
                return "";
              }
              port = Number(answer) || 3000;
            } else if (typeof result.value === "string" && result.value.startsWith("skip-")) {
              // Port with running tunnel selected - show info message
              restoreRawMode();
              return `⚠ Port ${result.value.replace("skip-", "")} already has a tunnel running.\nUse "Stop Tunnel" first to disconnect it.`;
            } else {
              port = result.value as number;
            }

            restoreRawMode();
            return await createAndStartTunnel(port);
          } catch (err: any) {
            restoreRawMode();
            throw err;
          }
        },
      },
      {
        label: "Start (Manual)",
        action: async () => {
          const answer = await promptLine('Local port to expose (default 3000, or "back"): ');
          if (isBackInput(answer)) {
            restoreRawMode();
            return "";
          }
          const port = Number(answer) || 3000;
          try {
            const result = await apiRequest("POST", "/v1/tunnels", { port });
            try {
              process.stdin.setRawMode(true);
              process.stdin.resume();
            } catch {
              /* ignore */
            }
            const url = result.url || "(no url)";
            const token = result.token || "(no token)";
            const httpFallback = typeof url === "string" && url.startsWith("https://") ? url.replace(/^https:\/\//, "http://") : "";
            return [
              `Created tunnel: ${url}`,
              httpFallback && url !== httpFallback ? `HTTP fallback: ${httpFallback}` : "",
              `Token: ${token}`,
              "",
              "To start the tunnel client, run:",
              `  node scripts/tunnel/client-improved.js --token ${token} --port ${port} --ctrl ${process.env.TUNNEL_CTRL || "tunnel.uplink.spot:7071"}`,
            ]
              .filter(Boolean)
              .join("\n");
          } catch (err: any) {
            try {
              process.stdin.setRawMode(true);
              process.stdin.resume();
            } catch {
              /* ignore */
            }
            throw err;
          }
        },
      },
      {
        label: "Stop Tunnel",
        action: async () => {
          try {
            // Find running tunnel client processes
            const processes = findTunnelClients();

            if (processes.length === 0) {
              restoreRawMode();
              return "No running tunnel clients found.";
            }

            // Build options from running tunnels
            const options: SelectOption[] = processes.map((p) => ({
              label: `Port ${p.port} ${colorDim(`(${truncate(p.token, 8)})`)}`,
              value: p.pid,
            }));

            // Add "Stop all" option if more than one tunnel
            if (processes.length > 1) {
              options.push({ label: colorRed("Stop all tunnels"), value: "all" });
            }

            const result = await inlineSelect("Select tunnel to stop", options, true);

            if (result === null) {
              // User selected Back
              restoreRawMode();
              return ""; // Return empty to go back without message
            }

            let killed = 0;
            if (result.value === "all") {
              // Kill all
              killed = killAllTunnelClients(processes);
            } else {
              // Kill specific client
              const pid = result.value as number;
              const ok = killTunnelClient(pid);
              if (!ok) {
                restoreRawMode();
                throw new Error(`Failed to kill process ${pid}`);
              }
              killed = 1;
            }

            restoreRawMode();
            return `✓ Stopped ${killed} tunnel client${killed !== 1 ? "s" : ""}`;
          } catch (err: any) {
            restoreRawMode();
            throw err;
          }
        },
      },
      {
        label: "View Tunnel Stats",
        action: async () => {
          try {
            // Show stats for running tunnels only
            const runningClients = findTunnelClients();
            if (runningClients.length === 0) {
              restoreRawMode();
              return "No active tunnels. Start a tunnel first.";
            }

            // Get alias info
            let aliasMap: Record<number, string> = {};
            try {
              const aliasResult = await apiRequest("GET", "/v1/tunnels/aliases");
              const aliases = aliasResult.aliases || [];
              for (const a of aliases) {
                aliasMap[a.targetPort || a.target_port] = a.alias;
              }
            } catch {
              // Continue without alias info
            }

            const options: SelectOption[] = runningClients.map((c) => {
              const token = truncate(c.token, 12);
              const alias = aliasMap[c.port] ? `${aliasMap[c.port]}.uplink.spot` : `port ${c.port}`;
              return { label: `${token}    ${alias}`, value: c.token };
            });

            const choice = await inlineSelect("Select tunnel to view stats", options, true);
            if (choice === null) {
              restoreRawMode();
              return "";
            }

            // Find the tunnel by token to get its ID
            const result = await apiRequest("GET", "/v1/tunnels");
            const tunnels = result.tunnels || [];
            const tunnel = tunnels.find((t: any) => t.token === choice.value);

            if (!tunnel) {
              return "Tunnel not found in backend. It may have been cleaned up.";
            }

            const stats = (await apiRequest("GET", `/v1/tunnels/${tunnel.id}/stats`)) as any;
            const connected = stats.connected ? "yes" : "no";
            const alias = stats.alias || null;

            if (!alias) {
              const s = stats.inMemory || {};
              return [
                `Connected: ${connected}`,
                `Requests:  ${s.requests || 0}`,
                `In:        ${formatBytes(s.bytesIn || 0)}`,
                `Out:       ${formatBytes(s.bytesOut || 0)}`,
              ].join("\n");
            }

            const totals = stats.totals || {};
            const current = stats.currentRun || {};
            const permanentUrl = `https://${alias}.uplink.spot`;
            return [
              `Permanent URL: ${permanentUrl}`,
              `Connected:     ${connected}`,
              "",
              "Totals (persisted):",
              `  Requests  ${totals.requests || 0}`,
              `  In        ${formatBytes(totals.bytesIn || 0)}`,
              `  Out       ${formatBytes(totals.bytesOut || 0)}`,
              "",
              "Current run:",
              `  Requests  ${current.requests || 0}`,
              `  In        ${formatBytes(current.bytesIn || 0)}`,
              `  Out       ${formatBytes(current.bytesOut || 0)}`,
            ].join("\n");
          } catch (err: any) {
            restoreRawMode();
            throw err;
          }
        },
      },
      {
        label: "Active Tunnels",
        action: async () => {
          // Get tunnels from API with connection status
          let connectedTunnels: Array<{ token: string; targetPort: number; url: string; alias?: string; aliasUrl?: string }> = [];
          try {
            const tunnelsResult = await apiRequest("GET", "/v1/tunnels");
            const tunnels = tunnelsResult.tunnels || [];
            // Only show tunnels that are actually connected to the relay
            connectedTunnels = tunnels.filter((t: any) => t.connected === true);
          } catch {
            // If API fails, fall back to local process check
            const runningClients = findTunnelClients();
            if (runningClients.length === 0) {
              return "No active tunnels. Use 'Start' to create one.";
            }
            // Show warning that we can't verify connection status
            const lines = runningClients.map((c) => {
              const token = truncate(c.token, 12);
              const port = String(c.port).padEnd(5);
              return `${token.padEnd(14)}  ${port}  (status unknown)`;
            });
            return [
              "⚠ Could not verify connection status from relay",
              "",
              "Token          Port   Status",
              "-".repeat(40),
              ...lines,
            ].join("\n");
          }

          if (connectedTunnels.length === 0) {
            return "No active tunnels connected to relay. Use 'Start' to create one.";
          }

          // Match with local processes to get port info
          const runningClients = findTunnelClients();
          const tokenToClient = new Map(runningClients.map((c) => [c.token, c]));

          const lines = connectedTunnels.map((tunnel) => {
            const token = truncate(tunnel.token, 12);
            const client = tokenToClient.get(tunnel.token);
            const port = client ? String(client.port).padEnd(5) : String(tunnel.targetPort).padEnd(5);
            const alias = tunnel.aliasUrl || (tunnel.alias ? `https://${tunnel.alias}.uplink.spot` : "-");
            return `${token.padEnd(14)}  ${port}  connected    ${alias}`;
          });

          return ["Token          Port   Status       Permanent URL", "-".repeat(60), ...lines].join("\n");
        },
      },
    ],
  };
}

