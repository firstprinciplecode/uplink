import { Command } from "commander";
import fetch from "node-fetch";
import { spawn, execSync } from "child_process";
import readline from "readline";
import { apiRequest } from "../http";
import { scanCommonPorts, testHttpPort } from "../utils/port-scanner";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";

type MenuChoice = {
  label: string;
  action?: () => Promise<string>;
  subMenu?: MenuChoice[];
};

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

// ─────────────────────────────────────────────────────────────
// Color palette (Oxide-inspired)
// ─────────────────────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  // Colors
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  white: "\x1b[97m",
  gray: "\x1b[90m",
  // Bright variants
  brightCyan: "\x1b[96m",
  brightGreen: "\x1b[92m",
  brightYellow: "\x1b[93m",
  brightWhite: "\x1b[97m",
};

function colorCyan(text: string) {
  return `${c.brightCyan}${text}${c.reset}`;
}

function colorYellow(text: string) {
  return `${c.yellow}${text}${c.reset}`;
}

function colorGreen(text: string) {
  return `${c.brightGreen}${text}${c.reset}`;
}

function colorDim(text: string) {
  return `${c.dim}${text}${c.reset}`;
}

function colorBold(text: string) {
  return `${c.bold}${c.brightWhite}${text}${c.reset}`;
}

function colorRed(text: string) {
  return `${c.red}${text}${c.reset}`;
}

function colorMagenta(text: string) {
  return `${c.magenta}${text}${c.reset}`;
}

// ASCII banner with color styling
const ASCII_UPLINK = colorCyan([
  "██╗   ██╗██████╗ ██╗     ██╗███╗   ██╗██╗  ██╗",
  "██║   ██║██╔══██╗██║     ██║████╗  ██║██║ ██╔╝",
  "██║   ██║██████╔╝██║     ██║██╔██╗ ██║█████╔╝ ",
  "██║   ██║██╔═══╝ ██║     ██║██║╚██╗██║██╔═██╗ ",
  "╚██████╔╝██║     ███████╗██║██║ ╚████║██║  ██╗",
  " ╚═════╝ ╚═╝     ╚══════╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝",
].join("\n"));

function truncate(text: string, max: number) {
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + "…";
}

function restoreRawMode() {
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  } catch {
    /* ignore */
  }
}

// Inline arrow-key selector (returns selected index, or -1 for "Back")
type SelectOption = { label: string; value: string | number | null };

async function inlineSelect(
  title: string,
  options: SelectOption[],
  includeBack: boolean = true
): Promise<{ index: number; value: string | number | null } | null> {
  return new Promise((resolve) => {
    // Add "Back" option if requested
    const allOptions = includeBack 
      ? [...options, { label: "Back", value: null }]
      : options;
    
    let selected = 0;
    
    const renderSelector = () => {
      // Clear previous render (move cursor up and clear lines)
      const linesToClear = allOptions.length + 3;
      process.stdout.write(`\x1b[${linesToClear}A\x1b[0J`);
      
      console.log();
      console.log(colorDim(title));
      console.log();
      
      allOptions.forEach((opt, idx) => {
        const isLast = idx === allOptions.length - 1;
        const isSelected = idx === selected;
        const branch = isLast ? "└─" : "├─";
        
        let label: string;
        let branchColor: string;
        
        if (isSelected) {
          branchColor = colorCyan(branch);
          if (opt.label === "Back") {
            label = colorDim(opt.label);
          } else {
            label = colorCyan(opt.label);
          }
        } else {
          branchColor = colorDim(branch);
          if (opt.label === "Back") {
            label = colorDim(opt.label);
          } else {
            label = opt.label;
          }
        }
        
        console.log(`${branchColor} ${label}`);
      });
    };
    
    // Initial render - print blank lines first so we can clear them
    console.log();
    console.log(colorDim(title));
    console.log();
    allOptions.forEach((opt, idx) => {
      const isLast = idx === allOptions.length - 1;
      const branch = isLast ? "└─" : "├─";
      const branchColor = idx === 0 ? colorCyan(branch) : colorDim(branch);
      const label = idx === 0 ? colorCyan(opt.label) : (opt.label === "Back" ? colorDim(opt.label) : opt.label);
      console.log(`${branchColor} ${label}`);
    });
    
    // Set up key handler
    try {
      process.stdin.setRawMode(true);
      process.stdin.resume();
    } catch {
      /* ignore */
    }
    
    const keyHandler = (key: Buffer) => {
      const str = key.toString();
      
      if (str === "\u0003") {
        // Ctrl+C
        process.stdin.removeListener("data", keyHandler);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.exit(0);
      } else if (str === "\u001b[A") {
        // Up arrow
        selected = (selected - 1 + allOptions.length) % allOptions.length;
        renderSelector();
      } else if (str === "\u001b[B") {
        // Down arrow
        selected = (selected + 1) % allOptions.length;
        renderSelector();
      } else if (str === "\u001b[D") {
        // Left arrow - same as selecting "Back"
        process.stdin.removeListener("data", keyHandler);
        resolve(null);
      } else if (str === "\r") {
        // Enter
        process.stdin.removeListener("data", keyHandler);
        const selectedOption = allOptions[selected];
        if (selectedOption.label === "Back" || selectedOption.value === null) {
          resolve(null);
        } else {
          resolve({ index: selected, value: selectedOption.value });
        }
      }
    };
    
    process.stdin.on("data", keyHandler);
  });
}

// Helper function to make unauthenticated requests (for signup)
async function unauthenticatedRequest(method: string, path: string, body?: unknown): Promise<any> {
  const apiBase = process.env.AGENTCLOUD_API_BASE || "https://api.uplink.spot";
  const response = await fetch(`${apiBase}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(JSON.stringify(json, null, 2));
  }
  return json;
}

export const menuCommand = new Command("menu")
  .description("Interactive terminal menu (arrow keys + enter)")
  .action(async () => {
    const apiBase = process.env.AGENTCLOUD_API_BASE || "https://api.uplink.spot";
    
    // Determine role (admin or user) via /v1/me; check if auth failed
    let isAdmin = false;
    let authFailed = false;
    try {
      const me = await apiRequest("GET", "/v1/me");
      isAdmin = me?.role === "admin";
    } catch (err: any) {
      // Check if it's an authentication error
      const errorMsg = err?.message || String(err);
      authFailed =
        errorMsg.includes("UNAUTHORIZED") ||
        errorMsg.includes("401") ||
        errorMsg.includes("Missing or invalid token") ||
        errorMsg.includes("Missing AGENTCLOUD_TOKEN");
      isAdmin = false;
    }

    // Build menu structure dynamically by role and auth status
    const mainMenu: MenuChoice[] = [];
    
    // If authentication failed, show ONLY "Get Started" and "Exit"
    if (authFailed) {
      mainMenu.push({
        label: "🚀 Get Started (Create Account)",
        action: async () => {
          restoreRawMode();
          clearScreen();
          try {
            process.stdout.write("\n");
            process.stdout.write(colorCyan("UPLINK") + colorDim(" │ ") + "Create Account\n");
            process.stdout.write(colorDim("─".repeat(40)) + "\n\n");

            const label = (await promptLine("Label (optional): ")).trim();
            const expiresInput = (await promptLine("Expires in days (optional): ")).trim();
            const expiresDays = expiresInput ? Number(expiresInput) : undefined;

            if (expiresDays && (isNaN(expiresDays) || expiresDays <= 0)) {
              restoreRawMode();
              return "Invalid expiration days. Please enter a positive number or leave empty.";
            }

            process.stdout.write("\nCreating your token...\n");
            process.stdout.write("");
            let result;
            try {
              result = await unauthenticatedRequest("POST", "/v1/signup", {
                label: label || undefined,
                expiresInDays: expiresDays || undefined,
              });
              if (!result) {
                restoreRawMode();
                return "❌ Error: No response from server.";
              }
            } catch (err: any) {
              restoreRawMode();
              const errorMsg = err?.message || String(err);
              console.error("\n❌ Signup error:", errorMsg);
              if (errorMsg.includes("429") || errorMsg.includes("RATE_LIMIT")) {
                return "⚠️  Too many signup attempts. Please try again later.";
              }
              return `❌ Error creating account: ${errorMsg}`;
            }

            if (!result || !result.token) {
              restoreRawMode();
              return "❌ Error: Invalid response from server. Token not received.";
            }

            const token = result.token;
            const tokenId = result.id;
            const userId = result.userId;

            process.stdout.write("\n");
            process.stdout.write(colorGreen("✓") + " Account created\n");
            process.stdout.write("\n");
            process.stdout.write(colorDim("├─") + " Token     " + colorCyan(token) + "\n");
            process.stdout.write(colorDim("├─") + " ID        " + tokenId + "\n");
            process.stdout.write(colorDim("├─") + " User      " + userId + "\n");
            process.stdout.write(colorDim("├─") + " Role      " + result.role + "\n");
            if (result.expiresAt) {
              process.stdout.write(colorDim("└─") + " Expires   " + result.expiresAt + "\n");
            } else {
              process.stdout.write(colorDim("└─") + " Expires   " + colorDim("never") + "\n");
            }
            process.stdout.write("\n");
            process.stdout.write(colorYellow("!") + " Save this token securely - shown only once\n");

            // Try to automatically add token to shell config
            const shell = process.env.SHELL || "";
            const homeDir = homedir();
            let configFile: string | null = null;
            let shellName = "";

            if (shell.includes("zsh")) {
              configFile = join(homeDir, ".zshrc");
              shellName = "zsh";
            } else if (shell.includes("bash")) {
              configFile = join(homeDir, ".bashrc");
              shellName = "bash";
            } else {
              if (existsSync(join(homeDir, ".zshrc"))) {
                configFile = join(homeDir, ".zshrc");
                shellName = "zsh";
              } else if (existsSync(join(homeDir, ".bashrc"))) {
                configFile = join(homeDir, ".bashrc");
                shellName = "bash";
              }
            }

            let tokenAdded = false;
            let tokenExists = false;

            if (configFile) {
              if (existsSync(configFile)) {
                const configContent = readFileSync(configFile, "utf-8");
                tokenExists = configContent.includes("AGENTCLOUD_TOKEN");
              }
            }

            if (configFile) {
              const promptText = tokenExists
                ? `\n→ Update existing token in ~/.${shellName}rc? (Y/n): `
                : `\n→ Add token to ~/.${shellName}rc? (Y/n): `;
              
              const addToken = (await promptLine(promptText)).trim().toLowerCase();
              if (addToken !== "n" && addToken !== "no") {
                try {
                  if (tokenExists) {
                    const configContent = readFileSync(configFile, "utf-8");
                    const lines = configContent.split("\n");
                    const updatedLines = lines.map((line) => {
                      if (line.match(/^\s*export\s+AGENTCLOUD_TOKEN=/)) {
                        return `export AGENTCLOUD_TOKEN=${token}`;
                      }
                      return line;
                    });
                    const wasReplaced = updatedLines.some((line, idx) => line !== lines[idx]);
                    if (!wasReplaced) {
                      updatedLines.push(`export AGENTCLOUD_TOKEN=${token}`);
                    }
                    writeFileSync(configFile, updatedLines.join("\n"), { flag: "w", mode: 0o644 });
                    tokenAdded = true;
                    console.log(colorGreen(`\n✓ Token updated in ~/.${shellName}rc`));
                    const verifyContent = readFileSync(configFile, "utf-8");
                    if (!verifyContent.includes(`export AGENTCLOUD_TOKEN=${token}`)) {
                      console.log(colorYellow(`\n! Warning: Token may not have been written correctly. Please check ~/.${shellName}rc`));
                    }
                  } else {
                    const exportLine = `\n# Uplink API Token (added automatically)\nexport AGENTCLOUD_TOKEN=${token}\n`;
                    writeFileSync(configFile, exportLine, { flag: "a", mode: 0o644 });
                    tokenAdded = true;
                    console.log(colorGreen(`\n✓ Token added to ~/.${shellName}rc`));
                    const verifyContent = readFileSync(configFile, "utf-8");
                    if (!verifyContent.includes(`export AGENTCLOUD_TOKEN=${token}`)) {
                      console.log(colorYellow(`\n! Warning: Token may not have been written correctly. Please check ~/.${shellName}rc`));
                    }
                  }
                } catch (err: any) {
                  console.log(colorYellow(`\n! Could not write to ~/.${shellName}rc: ${err.message}`));
                  console.log(`\n  Please add manually:`);
                  console.log(colorDim(`  echo 'export AGENTCLOUD_TOKEN=${token}' >> ~/.${shellName}rc`));
                }
              }
            } else {
              console.log(colorYellow(`\n→ Could not detect your shell. Add the token manually:`));
              console.log(colorDim(`  echo 'export AGENTCLOUD_TOKEN=${token}' >> ~/.zshrc  # for zsh`));
              console.log(colorDim(`  echo 'export AGENTCLOUD_TOKEN=${token}' >> ~/.bashrc  # for bash`));
            }

            if (!tokenAdded) {
            process.stdout.write("\n");
            process.stdout.write(colorYellow("!") + " Set this token as an environment variable:\n\n");
            process.stdout.write(colorDim("  ") + "export AGENTCLOUD_TOKEN=" + token + "\n");
            if (configFile) {
              process.stdout.write(colorDim(`\n  Or add to ~/.${shellName}rc:\n`));
              process.stdout.write(colorDim("  ") + `echo 'export AGENTCLOUD_TOKEN=${token}' >> ~/.${shellName}rc\n`);
              process.stdout.write(colorDim("  ") + `source ~/.${shellName}rc\n`);
            }
            process.stdout.write(colorDim("\n  Then restart this menu.\n\n"));
            }

            restoreRawMode();

            if (tokenAdded) {
              process.env.AGENTCLOUD_TOKEN = token;
              // Use stdout writes to avoid buffering/race with process.exit()
              process.stdout.write(`\n${colorGreen("✓")} Token saved to ~/.${shellName}rc\n`);
              process.stdout.write(`\n${colorYellow("→")} Next: run in your terminal:\n`);
              process.stdout.write(colorDim(`   source ~/.${shellName}rc && uplink\n\n`));
              
              setTimeout(() => {
                process.exit(0);
              }, 3000);
              
              return undefined as any;
            }

            console.log("\nPress Enter to continue...");
            await promptLine("");
            restoreRawMode();
            return "Token created! Please set AGENTCLOUD_TOKEN environment variable and restart the menu.";
          } catch (err: any) {
            restoreRawMode();
            const errorMsg = err?.message || String(err);
            if (errorMsg.includes("429") || errorMsg.includes("RATE_LIMIT")) {
              return "⚠️  Too many signup attempts. Please try again later.";
            }
            return `❌ Error creating account: ${errorMsg}`;
          }
        },
      });
      
      mainMenu.push({
        label: "Exit",
        action: async () => {
          return "Goodbye!";
        },
      });
    } else {
      // Only show other menu items if authentication succeeded

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
          {
            label: "Test: Comprehensive",
            action: async () => {
              await runSmoke("test:comprehensive");
              return "test:comprehensive completed";
            },
          },
        ],
      });
    }

    mainMenu.push({
      label: "Manage Tunnels",
      subMenu: [
          {
            label: "Start Tunnel",
            action: async () => {
              try {
                // Scan for active ports
                console.log(colorDim("\nScanning for active servers..."));
                
                // Temporarily disable raw mode for scanning
                try { process.stdin.setRawMode(false); } catch { /* ignore */ }
                const activePorts = await scanCommonPorts();
                
                if (activePorts.length === 0) {
                  // No ports found - show selector with just custom option and back
                  const options: SelectOption[] = [
                    { label: "Enter custom port", value: "custom" },
                  ];
                  
                  const result = await inlineSelect("No active servers detected", options, true);
                  
                  if (result === null) {
                    // User selected Back
                    restoreRawMode();
                    return ""; // Return empty to go back without message
                  }
                  
                  // Custom port entry
                  try { process.stdin.setRawMode(false); } catch { /* ignore */ }
                  const answer = await promptLine("Enter port number (default 3000): ");
                  const port = Number(answer) || 3000;
                  restoreRawMode();
                  return await createAndStartTunnel(port);
                }
                
                // Build options from found ports
                const options: SelectOption[] = activePorts.map((port) => ({
                  label: `Port ${port}`,
                  value: port,
                }));
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
                  try { process.stdin.setRawMode(false); } catch { /* ignore */ }
                  const answer = await promptLine("Enter port number (default 3000): ");
                  port = Number(answer) || 3000;
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
                  for (const p of processes) {
                    try {
                      execSync(`kill -TERM ${p.pid}`, { stdio: "ignore" });
                      killed++;
                    } catch {
                      // Process might have already exited
                    }
                  }
                } else {
                  // Kill specific client
                  const pid = result.value as number;
                  try {
                    execSync(`kill -TERM ${pid}`, { stdio: "ignore" });
                    killed = 1;
                  } catch (err: any) {
                    restoreRawMode();
                    throw new Error(`Failed to kill process ${pid}: ${err.message}`);
                  }
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
            label: "View Connected (with IPs)",
            action: async () => {
              try {
                // Use the API endpoint which proxies to the relay
                const data = await apiRequest("GET", "/v1/admin/relay-status") as { 
                  connectedTunnels?: number; 
                  tunnels?: Array<{ token: string; clientIp: string; targetPort: number; connectedAt: string; connectedFor: string }>;
                  timestamp?: string;
                  error?: string;
                  message?: string;
                };
                
                if (data.error) {
                  return `❌ Relay error: ${data.error}${data.message ? ` - ${data.message}` : ""}`;
                }
                
                if (!data.tunnels || data.tunnels.length === 0) {
                  return "No tunnels currently connected to the relay.";
                }
                
                const lines = data.tunnels.map((t) => 
                  `${truncate(t.token, 12).padEnd(14)} ${t.clientIp.padEnd(16)} ${String(t.targetPort).padEnd(6)} ${t.connectedFor.padEnd(10)} ${truncate(t.connectedAt, 19)}`
                );
                
                return [
                  `Connected Tunnels: ${data.connectedTunnels}`,
                  "",
                  "Token          Client IP        Port   Uptime     Connected At",
                  "-".repeat(75),
                  ...lines,
                ].join("\n");
              } catch (err: any) {
                return `❌ Failed to get relay status: ${err.message}`;
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

    // Admin-only: Manage Tokens
    if (isAdmin) {
      mainMenu.push({
        label: "Manage Tokens (admin)",
        subMenu: [
          {
            label: "List Tokens",
            action: async () => {
              const result = await apiRequest("GET", "/v1/admin/tokens");
              const tokens = result.tokens || [];
              if (!tokens.length) return "No tokens found.";
              const lines = tokens.map(
                (t: any) =>
                  `${truncate(t.id, 12)}  ${truncate(t.token_prefix || t.tokenPrefix || "-", 10).padEnd(12)}  ${truncate(
                    t.role ?? "-",
                    6
                  ).padEnd(8)}  ${truncate(t.label ?? "-", 20).padEnd(22)}  ${truncate(
                    t.created_at ?? t.createdAt ?? "",
                    19
                  )}`
              );
              return [
                "ID           Prefix        Role     Label                   Created",
                "-".repeat(90),
                ...lines,
              ].join("\n");
            },
          },
          {
            label: "Create Token",
            action: async () => {
              const roleAnswer = await promptLine("Role (admin/user, default user): ");
              const role = roleAnswer.trim().toLowerCase() === "admin" ? "admin" : "user";
              const labelAnswer = await promptLine("Label (optional): ");
              const label = labelAnswer.trim() || undefined;
              const expiresAnswer = await promptLine("Expires in days (optional): ");
              const expiresDays = expiresAnswer.trim() ? Number(expiresAnswer) : undefined;

              restoreRawMode();

              const body: Record<string, unknown> = { role };
              if (label) body.label = label;
              if (expiresDays && expiresDays > 0) body.expiresInDays = expiresDays;

              const result = await apiRequest("POST", "/v1/admin/tokens", body);
              const rawToken = result.token || "(no token returned)";
              return [
                "✓ Token created",
                "",
                `→ Token     ${rawToken}`,
                `→ ID        ${result.id}`,
                `→ Role      ${result.role}`,
                `→ Label     ${result.label || "-"}`,
                result.expiresAt ? `→ Expires   ${result.expiresAt}` : "",
              ]
                .filter(Boolean)
                .join("\n");
            },
          },
          {
            label: "Revoke Token",
            action: async () => {
              try {
                // Fetch available tokens
                const result = await apiRequest("GET", "/v1/admin/tokens");
                const tokens = result.tokens || [];
                
                if (tokens.length === 0) {
                  restoreRawMode();
                  return "No tokens found.";
                }
                
                // Build options from tokens
                const options: SelectOption[] = tokens.map((t: any) => ({
                  label: `${truncate(t.id, 12)} ${colorDim(`${t.role || "user"} - ${t.label || "no label"}`)}`,
                  value: t.id,
                }));
                
                const selected = await inlineSelect("Select token to revoke", options, true);
                
                if (selected === null) {
                  // User selected Back
                  restoreRawMode();
                  return "";
                }
                
                const tokenId = selected.value as string;
                await apiRequest("DELETE", `/v1/admin/tokens/${tokenId}`);
                restoreRawMode();
                return `✓ Token ${truncate(tokenId, 12)} revoked`;
              } catch (err: any) {
                restoreRawMode();
                throw err;
              }
            },
          },
        ],
      });

      // Admin-only: Stop ALL Tunnel Clients (kill switch)
      mainMenu.push({
        label: "⚠️  Stop ALL Tunnel Clients (kill switch)",
        action: async () => {
          const clients = findTunnelClients();
          if (clients.length === 0) {
            return "No running tunnel clients found.";
          }
          let killed = 0;
          for (const client of clients) {
            try {
              execSync(`kill -TERM ${client.pid}`, { stdio: "ignore" });
              killed++;
            } catch {
              // Process might have already exited
            }
          }
          return `✓ Stopped ${killed} tunnel client${killed !== 1 ? "s" : ""}`;
        },
      });
    }

      mainMenu.push({
        label: "Exit",
        action: async () => "Goodbye!",
      });
    }

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
        
        const tunnelLines = clients.map((client, idx) => {
          const url = `${scheme}://${client.token}.${domain}`;
          const isLast = idx === clients.length - 1;
          const branch = isLast ? "└─" : "├─";
          return colorDim(branch) + " " + colorGreen(url) + colorDim(" → ") + `localhost:${client.port}`;
        });
        
        cachedActiveTunnels = [
          colorDim("├─") + " Active   " + colorGreen(`${clients.length} tunnel${clients.length > 1 ? "s" : ""}`),
          colorDim("│"),
          ...tunnelLines,
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
      console.log();
      console.log(ASCII_UPLINK);
      console.log();
      
      // Status bar - relay and API status
      if (menuStack.length === 1 && cachedRelayStatus) {
        const statusColor = cachedRelayStatus.includes("ok") ? colorGreen : colorRed;
        console.log(colorDim("├─") + " Status  " + statusColor(cachedRelayStatus.replace("Relay: ", "")));
      }

      // Show active tunnels if we're at the main menu (use cached value, no scanning)
      if (menuStack.length === 1 && cachedActiveTunnels) {
        console.log(cachedActiveTunnels);
      }
      
      console.log();
      
      const currentMenu = getCurrentMenu();
      
      // Breadcrumb navigation
      if (menuPath.length > 0) {
        const breadcrumb = menuPath.map((p, i) => 
          i === menuPath.length - 1 ? colorCyan(p) : colorDim(p)
        ).join(colorDim(" › "));
        console.log(breadcrumb);
        console.log();
      }
      
      // Menu items with tree-style rendering
      currentMenu.forEach((choice, idx) => {
        const isLast = idx === currentMenu.length - 1;
        const isSelected = idx === selected;
        const branch = isLast ? "└─" : "├─";
        
        // Clean up labels - remove emojis for cleaner look
        let cleanLabel = choice.label
          .replace(/^🚀\s*/, "")
          .replace(/^⚠️\s*/, "")
          .replace(/^✅\s*/, "")
          .replace(/^❌\s*/, "");
        
        // Style based on selection and type
        let label: string;
        let branchColor: string;
        
        if (isSelected) {
          branchColor = colorCyan(branch);
          if (cleanLabel.toLowerCase().includes("exit")) {
            label = colorDim(cleanLabel);
          } else if (cleanLabel.toLowerCase().includes("stop all") || cleanLabel.toLowerCase().includes("kill")) {
            label = colorRed(cleanLabel);
          } else if (cleanLabel.toLowerCase().includes("get started")) {
            label = colorGreen(cleanLabel);
          } else {
            label = colorCyan(cleanLabel);
          }
        } else {
          branchColor = colorDim(branch);
          if (cleanLabel.toLowerCase().includes("exit")) {
            label = colorDim(cleanLabel);
          } else if (cleanLabel.toLowerCase().includes("stop all") || cleanLabel.toLowerCase().includes("kill")) {
            label = colorRed(cleanLabel);
          } else if (cleanLabel.toLowerCase().includes("get started")) {
            label = colorGreen(cleanLabel);
          } else {
            label = cleanLabel;
          }
        }
        
        // Submenu indicator
        const indicator = choice.subMenu ? colorDim(" ›") : "";
        
        console.log(`${branchColor} ${label}${indicator}`);
      });
      
      // Message area
      if (busy) {
        console.log();
        console.log(colorDim("│"));
        console.log(colorCyan("│ ") + colorDim("Working..."));
      } else if (message && message !== "Use ↑/↓ and Enter. ← to go back. Ctrl+C to quit.") {
        console.log();
        // Format multi-line messages nicely
        const lines = message.split("\n");
        lines.forEach((line) => {
          // Color success/error indicators
          let styledLine = line
            .replace(/^✅/, colorGreen("✓"))
            .replace(/^❌/, colorRed("✗"))
            .replace(/^⚠️/, colorYellow("!"))
            .replace(/^🔑/, colorCyan("→"))
            .replace(/^🌐/, colorCyan("→"))
            .replace(/^📡/, colorCyan("→"))
            .replace(/^💡/, colorYellow("→"));
          console.log(colorDim("│ ") + styledLine);
        });
      }
      
      // Footer hints
      console.log();
      const hints = [
        colorDim("↑↓") + " navigate",
        colorDim("↵") + " select",
      ];
      if (menuStack.length > 1) {
        hints.push(colorDim("←") + " back");
      }
      hints.push(colorDim("^C") + " exit");
      console.log(colorDim(hints.join("  ")));
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
        message = ""; // Clear any displayed output when entering submenu
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
        // If action returns undefined, it handled its own output/exit (e.g., signup flow)
        if (result === undefined) {
          return;
        }
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
          message = ""; // Clear any displayed output when going back
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
  const ctrl = process.env.TUNNEL_CTRL || "tunnel.uplink.spot:7071";
  
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

function findTunnelClients(): Array<{ pid: number; port: number; token: string }> {
  try {
    // Find processes running client-improved.js (current user, match script path to avoid false positives)
    const user = process.env.USER || "";
    const psCmd = user
      ? `ps -u ${user} -o pid=,command=`
      : "ps -eo pid=,command=";
    const output = execSync(psCmd, { encoding: "utf-8" });
    const lines = output
      .trim()
      .split("\n")
      .filter((line) => line.includes("scripts/tunnel/client-improved.js"));
    
    const clients: Array<{ pid: number; port: number; token: string }> = [];
    
    for (const line of lines) {
      // Parse process line: PID COMMAND (pid may have leading whitespace)
      // Format: "56218 node /path/to/client-improved.js --token TOKEN --port PORT --ctrl CTRL"
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

function runSmoke(script: "smoke:tunnel" | "smoke:db" | "smoke:all" | "test:comprehensive") {
  return new Promise<void>((resolve, reject) => {
    const projectRoot = join(__dirname, "../../..");
    const env = {
      ...process.env,
      AGENTCLOUD_API_BASE: process.env.AGENTCLOUD_API_BASE ?? "https://api.uplink.spot",
      AGENTCLOUD_TOKEN: process.env.AGENTCLOUD_TOKEN ?? "dev-token",
    };

    // For test:comprehensive, run inline (no subprocess)
    if (script === "test:comprehensive") {
      runComprehensiveTest(env).then(resolve).catch(reject);
      return;
    }

    // For other scripts, use npm run with shell mode from project root
    const child = spawn("npm", ["run", script], { 
      stdio: "inherit", 
      env, 
      cwd: projectRoot,
      shell: true 
    });
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

// Inline comprehensive test (no subprocess needed)
async function runComprehensiveTest(env: Record<string, string | undefined>) {
  const API_BASE = env.AGENTCLOUD_API_BASE || "https://api.uplink.spot";
  const ADMIN_TOKEN = env.AGENTCLOUD_TOKEN || "";
  
  const c = {
    reset: "\x1b[0m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    blue: "\x1b[34m",
  };
  
  let PASSED = 0;
  let FAILED = 0;
  let SKIPPED = 0;
  
  const logPass = (msg: string) => { console.log(`${c.green}✅ PASS${c.reset}: ${msg}`); PASSED++; };
  const logFail = (msg: string) => { console.log(`${c.red}❌ FAIL${c.reset}: ${msg}`); FAILED++; };
  const logSkip = (msg: string) => { console.log(`${c.yellow}⏭️  SKIP${c.reset}: ${msg}`); SKIPPED++; };
  const logInfo = (msg: string) => { console.log(`${c.blue}ℹ️  INFO${c.reset}: ${msg}`); };
  const logSection = (title: string) => {
    console.log(`\n${c.blue}═══════════════════════════════════════════════════════════${c.reset}`);
    console.log(`${c.blue}  ${title}${c.reset}`);
    console.log(`${c.blue}═══════════════════════════════════════════════════════════${c.reset}`);
  };
  
  const api = async (method: string, path: string, body?: object, token?: string) => {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      
      const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      
      let responseBody: any;
      try { responseBody = await res.json(); } catch { responseBody = {}; }
      return { status: res.status, body: responseBody };
    } catch (err: any) {
      return { status: 0, body: { error: err.message } };
    }
  };
  
  console.log("");
  console.log("╔═══════════════════════════════════════════════════════════╗");
  console.log("║       UPLINK COMPREHENSIVE TEST SUITE                     ║");
  console.log("╚═══════════════════════════════════════════════════════════╝");
  console.log(`\nAPI Base: ${API_BASE}\n`);
  
  if (!ADMIN_TOKEN) {
    console.log(`${c.red}ERROR: AGENTCLOUD_TOKEN not set.${c.reset}`);
    throw new Error("AGENTCLOUD_TOKEN not set");
  }
  
  // 1. Health
  logSection("1. HEALTH CHECKS");
  let res = await api("GET", "/health");
  if (res.status === 200 && res.body?.status === "ok") logPass("GET /health returns 200");
  else logFail(`GET /health - got ${res.status}`);
  
  res = await api("GET", "/health/live");
  if (res.status === 200) logPass("GET /health/live returns 200");
  else logFail(`GET /health/live - got ${res.status}`);
  
  // 2. Auth
  logSection("2. AUTHENTICATION");
  res = await api("GET", "/v1/me");
  if (res.status === 401) logPass("Missing token returns 401");
  else logFail(`Missing token - got ${res.status}`);
  
  res = await api("GET", "/v1/me", undefined, "invalid-token");
  if (res.status === 401) logPass("Invalid token returns 401");
  else logFail(`Invalid token - got ${res.status}`);
  
  res = await api("GET", "/v1/me", undefined, ADMIN_TOKEN);
  if (res.status === 200 && res.body?.role === "admin") logPass("Valid admin token works");
  else logFail(`Admin token - got ${res.status}`);
  
  // 3. Signup
  logSection("3. SIGNUP FLOW");
  let USER_TOKEN = "";
  let USER_TOKEN_ID = "";
  res = await api("POST", "/v1/signup", { label: `test-${Date.now()}` });
  if (res.status === 201 && res.body?.token) {
    USER_TOKEN = res.body.token;
    USER_TOKEN_ID = res.body.id;
    logPass("POST /v1/signup creates token");
    if (res.body.role === "user") logPass("Signup creates user role");
    else logFail(`Signup role: ${res.body.role}`);
  } else if (res.status === 429) {
    logSkip("Signup rate limited");
  } else {
    logFail(`Signup - got ${res.status}`);
  }
  
  // 4. Authorization
  logSection("4. AUTHORIZATION");
  if (USER_TOKEN) {
    res = await api("GET", "/v1/admin/stats", undefined, USER_TOKEN);
    if (res.status === 403) logPass("User blocked from admin endpoint");
    else logFail(`User accessed admin - got ${res.status}`);
  } else {
    logSkip("No user token for auth tests");
  }
  
  // 5. Tunnels
  logSection("5. TUNNEL API");
  res = await api("GET", "/v1/tunnels", undefined, ADMIN_TOKEN);
  if (res.status === 200) logPass("GET /v1/tunnels works");
  else logFail(`Tunnels list - got ${res.status}`);
  
  res = await api("POST", "/v1/tunnels", { port: 3000 }, ADMIN_TOKEN);
  if (res.status === 201) {
    logPass("POST /v1/tunnels creates tunnel");
    if (res.body?.id) {
      const delRes = await api("DELETE", `/v1/tunnels/${res.body.id}`, undefined, ADMIN_TOKEN);
      if (delRes.status === 200) logPass("DELETE tunnel works");
      else logFail(`Delete tunnel - got ${delRes.status}`);
    }
  } else {
    logFail(`Create tunnel - got ${res.status}`);
  }
  
  // 6. Databases
  logSection("6. DATABASE API");
  res = await api("GET", "/v1/dbs", undefined, ADMIN_TOKEN);
  if (res.status === 200) logPass("GET /v1/dbs works");
  else logFail(`Databases list - got ${res.status}`);
  logInfo("Skipping DB creation (provisions real resources)");
  
  // 7. Admin Stats
  logSection("7. ADMIN STATS");
  res = await api("GET", "/v1/admin/stats", undefined, ADMIN_TOKEN);
  if (res.status === 200) {
    logPass("GET /v1/admin/stats works");
    if (res.body?.tunnels !== undefined) logPass("Stats include tunnels");
    if (res.body?.databases !== undefined) logPass("Stats include databases");
  } else {
    logFail(`Admin stats - got ${res.status}`);
  }
  
  // Cleanup
  logSection("8. CLEANUP");
  if (USER_TOKEN_ID) {
    res = await api("DELETE", `/v1/admin/tokens/${USER_TOKEN_ID}`, undefined, ADMIN_TOKEN);
    if (res.status === 200) logPass("Cleaned up test token");
    else logInfo("Could not clean up token");
  } else {
    logInfo("No test token to clean up");
  }
  
  // Summary
  logSection("TEST SUMMARY");
  console.log(`\n  ${c.green}Passed${c.reset}:  ${PASSED}`);
  console.log(`  ${c.red}Failed${c.reset}:  ${FAILED}`);
  console.log(`  ${c.yellow}Skipped${c.reset}: ${SKIPPED}\n`);
  
  if (FAILED === 0) {
    console.log(`${c.green}═══════════════════════════════════════════════════════════${c.reset}`);
    console.log(`${c.green}  ✅ ALL TESTS PASSED (${PASSED}/${PASSED + FAILED})${c.reset}`);
    console.log(`${c.green}═══════════════════════════════════════════════════════════${c.reset}`);
  } else {
    console.log(`${c.red}═══════════════════════════════════════════════════════════${c.reset}`);
    console.log(`${c.red}  ❌ SOME TESTS FAILED (${FAILED}/${PASSED + FAILED})${c.reset}`);
    console.log(`${c.red}═══════════════════════════════════════════════════════════${c.reset}`);
    throw new Error(`${FAILED} tests failed`);
  }
}
