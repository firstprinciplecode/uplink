import { Command } from "commander";
import fetch from "node-fetch";
import { spawn, execSync } from "child_process";
import readline from "readline";
import { apiRequest } from "../http";
import { scanCommonPorts, testHttpPort } from "../utils/port-scanner";

type MenuChoice = {
  label: string;
  action?: () => Promise<string>;
  subMenu?: MenuChoice[];
};

const ASCII_UPLINK = [
  "██╗   ██╗██████╗ ██╗     ██╗███╗   ██╗██╗  ██╗",
  "██║   ██║██╔══██╗██║     ██║████╗  ██║██║ ██╔╝",
  "██║   ██║██████╔╝██║     ██║██╔██╗ ██║█████╔╝ ",
  "██║   ██║██╔═══╝ ██║     ██║██║╚██╗██║██╔═██╗ ",
  "╚██████╔╝██║     ███████╗██║██║ ╚████║██║  ██╗",
  " ╚═════╝ ╚═╝     ╚══════╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝",
].join("\n");

function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function clearScreen() {
  process.stdout.write("\x1b[2J\x1b[0f");
}

function colorCyan(text: string) {
  return `\x1b[36m${text}\x1b[0m`;
}

function colorYellow(text: string) {
  return `\x1b[33m${text}\x1b[0m`;
}

function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

export const menuCommand = new Command("menu")
  .description("Interactive terminal menu (arrow keys + enter)")
  .action(async () => {
    const apiBase = process.env.AGENTCLOUD_API_BASE || "https://api.uplink.spot";
    
    // Determine role (admin or user) via /v1/me; default to user on failure
    let isAdmin = false;
    try {
      const me = await apiRequest("GET", "/v1/me");
      isAdmin = me?.role === "admin";
    } catch {
      isAdmin = false;
    }

    // Build menu structure dynamically by role
    const mainMenu: MenuChoice[] = [];

    if (isAdmin) {
      mainMenu.push({
        label: "System Status",
        subMenu: [
          {
            label: "View Status",
            action: async () => {
              let health = "unknown";
              try {
                const res = await fetch(`${apiBase}/health`);
                const json = await res.json().catch(() => ({}));
                health = json.status || res.statusText || "unknown";
              } catch {
                health = "unreachable";
              }

              const stats = await apiRequest("GET", "/v1/admin/stats");
              return [
                `API health: ${health}`,
                "Tunnels:",
                `  Active ${stats.tunnels.active} | Inactive ${stats.tunnels.inactive} | Deleted ${stats.tunnels.deleted} | Total ${stats.tunnels.total}`,
                `  Created last 24h: ${stats.tunnels.createdLast24h}`,
                "Databases:",
                `  Ready ${stats.databases.ready} | Provisioning ${stats.databases.provisioning} | Failed ${stats.databases.failed} | Deleted ${stats.databases.deleted} | Total ${stats.databases.total}`,
                `  Created last 24h: ${stats.databases.createdLast24h}`,
              ].join("\n");
            },
          },
          {
            label: "Test: Tunnel",
            action: async () => {
              await runSmoke("smoke:tunnel");
              return "smoke:tunnel completed";
            },
          },
          {
            label: "Test: Database",
            action: async () => {
              await runSmoke("smoke:db");
              return "smoke:db completed";
            },
          },
          {
            label: "Test: All",
            action: async () => {
              await runSmoke("smoke:all");
              return "smoke:all completed";
            },
          },
        ],
      });
    }

    mainMenu.push({
      label: "Manage Tunnels",
      subMenu: [
          {
            label: "Start (Auto)",
            action: async () => {
              try {
                process.stdin.setRawMode(false);
                process.stdin.pause();
                
                // Scan for active ports
                console.log("Scanning for active servers...");
                const activePorts = await scanCommonPorts();
                
                if (activePorts.length === 0) {
                  // No ports found, prompt for manual entry
                  const answer = await promptLine("\nNo active servers detected. Enter port number (default 3000): ");
                  const port = Number(answer) || 3000;
                  return await createAndStartTunnel(port);
                }
                
                // Show port selection menu
                console.log("\nFound active servers on these ports:");
                activePorts.forEach((port, idx) => {
                  console.log(`  ${idx + 1}. Port ${port}`);
                });
                console.log(`  ${activePorts.length + 1}. Enter custom port`);
                
                const answer = await promptLine(`\nSelect port (1-${activePorts.length + 1}, default 1): `);
                const choice = Number(answer) || 1;
                
                let port: number;
                if (choice >= 1 && choice <= activePorts.length) {
                  port = activePorts[choice - 1];
                } else if (choice === activePorts.length + 1) {
                  const customAnswer = await promptLine("Enter port number: ");
                  port = Number(customAnswer) || 3000;
                } else {
                  port = activePorts[0]; // Default to first found port
                }
                
                return await createAndStartTunnel(port);
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
            label: "Start (Manual)",
            action: async () => {
              const answer = await promptLine("Local port to expose (default 3000): ");
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
                const httpFallback =
                  typeof url === "string" && url.startsWith("https://")
                    ? url.replace(/^https:\/\//, "http://")
                    : "";
                return [
                  `Created tunnel: ${url}`,
                  httpFallback && url !== httpFallback ? `HTTP fallback: ${httpFallback}` : "",
                  `Token: ${token}`,
                  "",
                  "To start the tunnel client, run:",
                  `  node scripts/tunnel/client-improved.js --token ${token} --port ${port} --ctrl ${process.env.TUNNEL_CTRL || "178.156.149.124:7071"}`,
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
                process.stdin.setRawMode(false);
                process.stdin.pause();
                
                // Find running tunnel client processes
                const processes = findTunnelClients();
                
                if (processes.length === 0) {
                  try {
                    process.stdin.setRawMode(true);
                    process.stdin.resume();
                  } catch {
                    /* ignore */
                  }
                  return "No running tunnel clients found.";
                }
                
                console.log("\nRunning tunnel clients:");
                processes.forEach((p, idx) => {
                  console.log(`  ${idx + 1}. Port ${p.port} | Token: ${p.token} | PID: ${p.pid}`);
                });
                console.log(`  ${processes.length + 1}. Kill all tunnel clients`);
                
                const answer = await promptLine(`\nSelect client to stop (1-${processes.length + 1}, default 1): `);
                const choice = Number(answer) || 1;
                
                let killed = 0;
                if (choice >= 1 && choice <= processes.length) {
                  // Kill specific client
                  const selected = processes[choice - 1];
                  try {
                    execSync(`kill -TERM ${selected.pid}`, { stdio: "ignore" });
                    killed = 1;
                  } catch (err: any) {
                    throw new Error(`Failed to kill process ${selected.pid}: ${err.message}`);
                  }
                } else if (choice === processes.length + 1) {
                  // Kill all
                  for (const p of processes) {
                    try {
                      execSync(`kill -TERM ${p.pid}`, { stdio: "ignore" });
                      killed++;
                    } catch {
                      // Process might have already exited
                    }
                  }
                } else {
                  // Default to first
                  try {
                    execSync(`kill -TERM ${processes[0].pid}`, { stdio: "ignore" });
                    killed = 1;
                  } catch (err: any) {
                    throw new Error(`Failed to kill process: ${err.message}`);
                  }
                }
                
                try {
                  process.stdin.setRawMode(true);
                  process.stdin.resume();
                } catch {
                  /* ignore */
                }
                
                return `✅ Stopped ${killed} tunnel client${killed !== 1 ? "s" : ""}.`;
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
        ],
      });

    mainMenu.push({
      label: "Usage",
      subMenu: [
        {
          label: isAdmin ? "List Tunnels (admin)" : "List My Tunnels",
          action: async () => {
            const runningClients = findTunnelClients();
            const path = isAdmin ? "/v1/admin/tunnels?limit=20" : "/v1/tunnels";
            const result = await apiRequest("GET", path);
            const tunnels = result.tunnels || result?.items || [];
            if (!tunnels || tunnels.length === 0) {
              return "No tunnels found.";
            }
            
            const lines = tunnels.map(
              (t: any) => {
                const token = t.token || "";
                const connectedFromApi = t.connected ?? false;
                const connectedLocal = runningClients.some((c) => c.token === token);
                const connectionStatus = isAdmin
                  ? (connectedFromApi ? "connected" : "disconnected")
                  : (connectedLocal ? "connected" : "unknown");
                
                return `${truncate(t.id, 12)}  ${truncate(token, 10).padEnd(12)}  ${String(
                  t.target_port ?? t.targetPort ?? "-"
                ).padEnd(5)}  ${connectionStatus.padEnd(12)}  ${truncate(
                  t.created_at ?? t.createdAt ?? "",
                  19
                )}`;
              }
            );
            return ["ID           Token         Port   Connection   Created", "-".repeat(70), ...lines].join(
              "\n"
            );
          },
        },
        {
          label: isAdmin ? "List Databases (admin)" : "List My Databases",
          action: async () => {
            const path = isAdmin ? "/v1/admin/databases?limit=20" : "/v1/dbs";
            const result = await apiRequest("GET", path);
            const databases = result.databases || result.items || [];
            if (!databases || databases.length === 0) {
              return "No databases found.";
            }
            const lines = databases.map(
              (db: any) =>
                `${truncate(db.id, 12)}  ${truncate(db.name ?? "-", 14).padEnd(14)}  ${truncate(
                  db.provider ?? "-",
                  8
                ).padEnd(8)}  ${truncate(db.region ?? "-", 10).padEnd(10)}  ${truncate(
                  db.status ?? (db.ready ? "ready" : db.status ?? "unknown"),
                  10
                ).padEnd(10)}  ${truncate(db.created_at ?? db.createdAt ?? "", 19)}`
            );
            return [
              "ID           Name            Prov     Region     Status      Created",
              "-".repeat(80),
              ...lines,
            ].join("\n");
          },
        },
      ],
    });

    mainMenu.push({
      label: "Exit",
      action: async () => "Goodbye!",
    });

    // Menu navigation state
    const menuStack: MenuChoice[][] = [mainMenu];
    const menuPath: string[] = [];
    let selected = 0;
    let message = "Use ↑/↓ and Enter. ← to go back. Ctrl+C to quit.";
    let exiting = false;
    let busy = false;
    
    // Cache active tunnels info - only update at start or when returning to main menu
    let cachedActiveTunnels = "";
    let cachedRelayStatus = "";

    const getCurrentMenu = () => menuStack[menuStack.length - 1];

    const updateActiveTunnelsCache = () => {
      const clients = findTunnelClients();
      if (clients.length === 0) {
        cachedActiveTunnels = "";
      } else {
        const domain = process.env.TUNNEL_DOMAIN || "t.uplink.spot";
        const scheme = (process.env.TUNNEL_URL_SCHEME || "https").toLowerCase();
        
        const tunnelLines = clients.map((client) => {
          const url = `${scheme}://${client.token}.${domain}`;
          return `  🌐 ${url} → localhost:${client.port}`;
        });
        
        cachedActiveTunnels = [
          "",
          colorYellow("Active Tunnels:"),
          ...tunnelLines,
          "",
        ].join("\n");
      }
    };

    const updateRelayStatusCache = async () => {
      const relayHealthUrl = process.env.RELAY_HEALTH_URL || "";
      if (!relayHealthUrl) {
        cachedRelayStatus = "";
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const headers: Record<string, string> = {};
        if (process.env.RELAY_INTERNAL_SECRET) {
          headers["x-relay-internal-secret"] = process.env.RELAY_INTERNAL_SECRET;
        }
        const res = await fetch(relayHealthUrl, { signal: controller.signal, headers });
        if (res.ok) {
          cachedRelayStatus = "Relay: ok";
        } else {
          cachedRelayStatus = `Relay: unreachable (HTTP ${res.status})`;
        }
      } catch {
        cachedRelayStatus = "Relay: unreachable";
      } finally {
        clearTimeout(timer);
      }
    };

    const refreshMainMenuCaches = async () => {
      updateActiveTunnelsCache();
      await updateRelayStatusCache();
      render();
    };

    const render = () => {
      clearScreen();
      console.log(colorCyan(ASCII_UPLINK));
      
      if (menuStack.length === 1 && cachedRelayStatus) {
        console.log(cachedRelayStatus);
      }

      // Show active tunnels if we're at the main menu (use cached value, no scanning)
      if (menuStack.length === 1 && cachedActiveTunnels) {
        console.log(cachedActiveTunnels);
      }
      
      console.log();
      
      const currentMenu = getCurrentMenu();
      const menuTitle = menuPath.length > 0 
        ? menuPath.join(" > ")
        : "Interactive menu";
      
      console.log(menuTitle);
      console.log("─".repeat(menuTitle.length));
      
      currentMenu.forEach((choice, idx) => {
        const pointer = idx === selected ? colorYellow("›") : " ";
        const label = idx === selected ? colorYellow(choice.label) : choice.label;
        const indicator = choice.subMenu ? " →" : "";
        console.log(`${pointer} ${label}${indicator}`);
      });
      
      if (busy) {
        console.log("\nWorking...");
      } else if (message) {
        console.log("\n" + message);
      }
      console.log("\nCtrl+C to exit" + (menuStack.length > 1 ? " | ← to go back" : ""));
    };

    const cleanup = () => {
      try {
        process.stdin.setRawMode(false);
      } catch {
        /* ignore */
      }
      process.stdin.pause();
    };

    const handleAction = async () => {
      const currentMenu = getCurrentMenu();
      const choice = currentMenu[selected];
      
      if (choice.subMenu) {
        // Navigate into sub-menu
        menuStack.push(choice.subMenu);
        menuPath.push(choice.label);
        selected = 0;
        // Invalidate caches when leaving main menu
        cachedActiveTunnels = "";
        cachedRelayStatus = "";
        render();
        return;
      }
      
      if (!choice.action) {
        return;
      }
      
      busy = true;
      render();
      try {
        const result = await choice.action();
        message = result;
        if (choice.label === "Exit") {
          exiting = true;
        }
      } catch (err: any) {
        message = `Error: ${err?.message || String(err)}`;
      } finally {
        busy = false;
        render();
        if (exiting) {
          cleanup();
          process.exit(0);
        }
      }
    };

    const onKey = async (key: Buffer) => {
      if (busy) return;
      const str = key.toString();
      const currentMenu = getCurrentMenu();
      
      if (str === "\u0003") {
        cleanup();
        process.exit(0);
      } else if (str === "\u001b[D") {
        // Left arrow - go back
        if (menuStack.length > 1) {
          menuStack.pop();
          menuPath.pop();
          selected = 0;
          // Refresh caches when returning to main menu
          if (menuStack.length === 1) {
            await refreshMainMenuCaches();
            return;
          }
          render();
        }
      } else if (str === "\u001b[A") {
        // Up
        selected = (selected - 1 + currentMenu.length) % currentMenu.length;
        render();
      } else if (str === "\u001b[B") {
        // Down
        selected = (selected + 1) % currentMenu.length;
        render();
      } else if (str === "\r") {
        await handleAction();
      }
    };

    // Initial scans for active tunnels and relay status at startup
    await refreshMainMenuCaches();
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onKey);
  });

async function createAndStartTunnel(port: number): Promise<string> {
  // Create tunnel
  const result = await apiRequest("POST", "/v1/tunnels", { port });
  const url = result.url || "(no url)";
  const token = result.token || "(no token)";
  const ctrl = process.env.TUNNEL_CTRL || "178.156.149.124:7071";
  
  // Start tunnel client in background
  const path = require("path");
  const projectRoot = path.join(__dirname, "../../..");
  const clientPath = path.join(projectRoot, "scripts/tunnel/client-improved.js");
  const clientProcess = spawn("node", [clientPath, "--token", token, "--port", String(port), "--ctrl", ctrl], {
    stdio: "ignore",
    detached: true,
    cwd: projectRoot,
  });
  clientProcess.unref();
  
  // Wait a moment for client to connect
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  } catch {
    /* ignore */
  }
  
  return [
    `✅ Tunnel created and client started!`,
    ``,
    `🌐 Public URL: ${url}`,
    `🔑 Token: ${token}`,
    `📡 Local port: ${port}`,
    ``,
    `The tunnel client is running in the background.`,
    `Open ${url} in your browser to access your local server!`,
    ``,
    `To stop the tunnel, find and kill the client process:`,
    `  pkill -f "client-improved.js.*${token}"`,
  ].join("\n");
}

function findTunnelClients(): Array<{ pid: number; port: number; token: string }> {
  try {
    // Find processes running client-improved.js (current user, match script path to avoid false positives)
    const user = process.env.USER || "";
    const psCmd = user ? `ps -u ${user} -o pid=,command=` : "ps -eo pid=,command=";
    const output = execSync(psCmd, { encoding: "utf-8" });
    const lines = output
      .trim()
      .split("\n")
      .filter((line) => line.includes("scripts/tunnel/client-improved.js"));

    const clients: Array<{ pid: number; port: number; token: string }> = [];

    for (const line of lines) {
      // macOS ps output starts with PID when using "-o pid=,command=",
      // so capture the leading number rather than assuming a USER column.
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

function runSmoke(script: "smoke:tunnel" | "smoke:db" | "smoke:all") {
  return new Promise<void>((resolve, reject) => {
    const env = {
      ...process.env,
      AGENTCLOUD_API_BASE: process.env.AGENTCLOUD_API_BASE ?? "https://api.uplink.spot",
      AGENTCLOUD_TOKEN: process.env.AGENTCLOUD_TOKEN ?? "dev-token",
    };
    const child = spawn("npm", ["run", script], { stdio: "inherit", env });
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${script} failed with exit code ${code}`));
      }
    });
    child.on("error", (err) => reject(err));
  });
}
