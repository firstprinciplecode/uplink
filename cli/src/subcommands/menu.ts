import { Command } from "commander";
import fetch from "node-fetch";
import { spawn } from "child_process";
import readline from "readline";
import { apiRequest } from "../http";
import { scanCommonPorts, testHttpPort } from "../utils/port-scanner";

type Choice = {
  label: string;
  action: () => Promise<string>;
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
    const choices: Choice[] = [
      {
        label: "System status",
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
        label: "List tunnels (limit 20)",
        action: async () => {
          const result = await apiRequest("GET", "/v1/admin/tunnels?limit=20");
          if (!result.tunnels || result.tunnels.length === 0) {
            return "No tunnels found.";
          }
          const lines = result.tunnels.map(
            (t: any) =>
              `${truncate(t.id, 12)}  ${truncate(t.token, 10).padEnd(12)}  ${String(
                t.target_port ?? t.targetPort ?? "-"
              ).padEnd(5)}  ${String(t.status ?? "unknown").padEnd(9)}  ${truncate(
                t.created_at ?? t.createdAt ?? "",
                19
              )}`
          );
          return ["ID           Token         Port   Status     Created", "-".repeat(60), ...lines].join(
            "\n"
          );
        },
      },
      {
        label: "List databases (limit 20)",
        action: async () => {
          const result = await apiRequest("GET", "/v1/admin/databases?limit=20");
          if (!result.databases || result.databases.length === 0) {
            return "No databases found.";
          }
          const lines = result.databases.map(
            (db: any) =>
              `${truncate(db.id, 12)}  ${truncate(db.name ?? "-", 14).padEnd(14)}  ${truncate(
                db.provider ?? "-",
                8
              ).padEnd(8)}  ${truncate(db.region ?? "-", 10).padEnd(10)}  ${truncate(
                db.status ?? "unknown",
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
      {
        label: "🚀 Start tunnel (auto-detect port)",
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
        label: "Create tunnel (manual port)",
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
        label: "Smoke test: tunnel",
        action: async () => {
          await runSmoke("smoke:tunnel");
          return "smoke:tunnel completed";
        },
      },
      {
        label: "Smoke test: db",
        action: async () => {
          await runSmoke("smoke:db");
          return "smoke:db completed";
        },
      },
      {
        label: "Smoke test: all",
        action: async () => {
          await runSmoke("smoke:all");
          return "smoke:all completed";
        },
      },
      {
        label: "Exit",
        action: async () => "Goodbye!",
      },
    ];

    let selected = 0;
    let message = "Use ↑/↓ and Enter. Ctrl+C to quit.";
    let exiting = false;
    let busy = false;

    const render = () => {
      clearScreen();
      console.log(colorCyan(ASCII_UPLINK));
      console.log();
      console.log("Interactive menu");
      console.log("───────────────");
      choices.forEach((choice, idx) => {
        const pointer = idx === selected ? colorYellow("›") : " ";
        const label = idx === selected ? colorYellow(choice.label) : choice.label;
        console.log(`${pointer} ${label}`);
      });
      if (busy) {
        console.log("\nWorking...");
      } else if (message) {
        console.log("\n" + message);
      }
      console.log("\nCtrl+C to exit");
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
      busy = true;
      render();
      try {
        const result = await choices[selected].action();
        message = result;
        if (choices[selected].label === "Exit") {
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
      if (str === "\u0003") {
        cleanup();
        process.exit(0);
      } else if (str === "\u001b[A") {
        // Up
        selected = (selected - 1 + choices.length) % choices.length;
        render();
      } else if (str === "\u001b[B") {
        // Down
        selected = (selected + 1) % choices.length;
        render();
      } else if (str === "\r") {
        await handleAction();
      }
    };

    render();
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

