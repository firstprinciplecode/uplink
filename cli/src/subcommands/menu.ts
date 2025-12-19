import { Command } from "commander";
import fetch from "node-fetch";
import { spawn, execSync } from "child_process";
import readline from "readline";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
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

function restoreRawMode() {
  try {
    process.stdin.setRawMode(true);
    process.stdin.resume();
  } catch {
    /* ignore */
  }
}

async function stopAllTunnels(): Promise<string> {
  try {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    // Kill all matching clients for current user
    execSync(`pkill -f "scripts/tunnel/client-improved.js"`, { stdio: "ignore" });
    restoreRawMode();
    return "✅ Stopped all tunnel clients (kill switch).";
  } catch (err: any) {
    restoreRawMode();
    return `Failed to stop all tunnel clients: ${err.message || err}`;
  }
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
      // Check if it's an authentication error (401) vs other errors
      const errorStr = String(err?.message || "");
      if (errorStr.includes("UNAUTHORIZED") || errorStr.includes("401") || errorStr.includes("Missing") || errorStr.includes("Invalid token")) {
        authFailed = true;
      }
      isAdmin = false;
    }

    // Build menu structure dynamically by role
    const mainMenu: MenuChoice[] = [];

    // If authentication failed, show ONLY "Get Started" and "Exit"
    if (authFailed) {
      mainMenu.push({
        label: "🚀 Get Started (Create Account)",
        action: async () => {
          // Disable menu rendering while we're doing signup flow
          // We'll handle all output ourselves
          restoreRawMode();
          // Clear screen at the start
          clearScreen();
          try {
            console.log("\n" + "=".repeat(60));
            console.log("Welcome to Uplink! Let's create your account.");
            console.log("=".repeat(60) + "\n");

            const label = (await promptLine("Label for this token (optional, e.g., 'my-laptop'): ")).trim();
            const expiresInput = (await promptLine("Expires in days (optional, press Enter for no expiration): ")).trim();
            const expiresDays = expiresInput ? Number(expiresInput) : undefined;

            if (expiresDays && (isNaN(expiresDays) || expiresDays <= 0)) {
              return "Invalid expiration days. Please enter a positive number or leave empty.";
            }

            console.log("\nCreating your token...");
            let result;
            try {
              result = await unauthenticatedRequest("POST", "/v1/signup", {
                label: label || undefined,
                expiresInDays: expiresDays || undefined,
              });
              // Debug: log if we got a result
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

            // Don't restore raw mode yet - we need it OFF for prompts
            // restoreRawMode() will be called after all prompts are done

            if (!result || !result.token) {
              restoreRawMode();
              return "❌ Error: Invalid response from server. Token not received.";
            }

            const token = result.token;
            const tokenId = result.id;
            const userId = result.userId;

            // Clear screen and show token info
            console.log("\n" + "=".repeat(60));
            console.log("✅ Account created successfully!");
            console.log("=".repeat(60) + "\n");
            console.log("🔑 YOUR TOKEN (save this securely - shown only once):");
            console.log("─".repeat(60));
            console.log(token);
            console.log("─".repeat(60) + "\n");
            console.log("📋 Token Details:");
            console.log(`   ID: ${tokenId}`);
            console.log(`   User ID: ${userId}`);
            console.log(`   Role: ${result.role}`);
            if (result.expiresAt) {
              console.log(`   Expires: ${result.expiresAt}`);
            }
            // Try to automatically add token to shell config
            const shell = process.env.SHELL || "";
            const homeDir = homedir();
            let configFile: string | null = null;
            let shellName = "";

            // Detect shell and config file
            if (shell.includes("zsh")) {
              configFile = join(homeDir, ".zshrc");
              shellName = "zsh";
            } else if (shell.includes("bash")) {
              configFile = join(homeDir, ".bashrc");
              shellName = "bash";
            } else {
              // Fallback: try common shells
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

            // Always try to prompt, even if configFile wasn't detected
            if (configFile) {
              // Check if token already exists in config file
              if (existsSync(configFile)) {
                const configContent = readFileSync(configFile, "utf-8");
                tokenExists = configContent.includes("AGENTCLOUD_TOKEN");
              }
            }

            // Always prompt to add/update token
            if (configFile) {
              const promptText = tokenExists
                ? `\n💡 AGENTCLOUD_TOKEN already exists in ~/.${shellName}rc. Update it with the new token? (Y/n): `
                : `\n💡 Add token to ~/.${shellName}rc automatically? (Y/n): `;
              
              const addToken = (await promptLine(promptText)).trim().toLowerCase();
              if (addToken !== "n" && addToken !== "no") {
                try {
                  if (tokenExists) {
                    // Update existing token: read file, replace the line, write back
                    const configContent = readFileSync(configFile, "utf-8");
                    const lines = configContent.split("\n");
                    const updatedLines = lines.map((line) => {
                      // Match export AGENTCLOUD_TOKEN=... (with or without quotes)
                      if (line.match(/^\s*export\s+AGENTCLOUD_TOKEN=/)) {
                        return `export AGENTCLOUD_TOKEN=${token}`;
                      }
                      return line;
                    });
                    // If no line was replaced, append it
                    const wasReplaced = updatedLines.some((line, idx) => line !== lines[idx]);
                    if (!wasReplaced) {
                      updatedLines.push(`export AGENTCLOUD_TOKEN=${token}`);
                    }
                    writeFileSync(configFile, updatedLines.join("\n"), { flag: "w" });
                    tokenAdded = true;
                    console.log(`\n✅ Token updated in ~/.${shellName}rc`);
                  } else {
                    // Add new token
                    const exportLine = `\n# Uplink API Token (added automatically)\nexport AGENTCLOUD_TOKEN=${token}\n`;
                    writeFileSync(configFile, exportLine, { flag: "a" });
                    tokenAdded = true;
                    console.log(`\n✅ Token added to ~/.${shellName}rc`);
                  }
                  // Don't show manual export instructions since it's already in the config file
                  // The user just needs to restart their terminal or run 'source ~/.zshrc'
                } catch (err: any) {
                  console.log(`\n⚠️  Could not write to ~/.${shellName}rc: ${err.message}`);
                  console.log(`\n   Please add manually:`);
                  console.log(`   echo 'export AGENTCLOUD_TOKEN=${token}' >> ~/.${shellName}rc`);
                }
              }
            } else {
              // If we couldn't detect shell, still offer to add manually
              console.log(`\n💡 Could not detect your shell. You can add the token manually:`);
              console.log(`   echo 'export AGENTCLOUD_TOKEN=${token}' >> ~/.zshrc  # for zsh`);
              console.log(`   echo 'export AGENTCLOUD_TOKEN=${token}' >> ~/.bashrc  # for bash`);
            }

            if (!tokenAdded) {
              console.log("\n" + "=".repeat(60));
              console.log("⚠️  IMPORTANT: Set this token as an environment variable:");
              console.log("=".repeat(60) + "\n");
              console.log("   export AGENTCLOUD_TOKEN=" + token);
              if (configFile) {
                console.log(`\n   Or add it to your ~/.${shellName}rc:`);
                console.log(`   echo 'export AGENTCLOUD_TOKEN=${token}' >> ~/.${shellName}rc`);
                console.log(`   source ~/.${shellName}rc`);
              }
              console.log("\n   Then restart this menu to use your new token.");
              console.log("=".repeat(60) + "\n");
            }

            // Restore raw mode now that all prompts are done
            restoreRawMode();

            // If token was added to shell config, set it in current process and exit
            if (tokenAdded) {
              // Set token in current process environment so it's available immediately
              process.env.AGENTCLOUD_TOKEN = token;
              console.log("\n✅ Token saved to ~/.zshrc and set in current session!");
              console.log("   Exiting menu - please run 'uplink' again to see all menu options.\n");
              
              // Give user a moment to read the message, then exit immediately
              // Use setTimeout so we can return undefined to prevent menu render
              setTimeout(() => {
                process.exit(0);
              }, 2000);
              
              // Return undefined so menu doesn't try to render
              return undefined as any;
            }

            // If token wasn't added, show instructions and wait for user
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
      
      // Only show "Exit" when auth failed - don't show other menu items
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
            label: "Test: New Features",
            action: async () => {
              try {
                process.stdin.setRawMode(false);
                process.stdin.pause();
                
                const { spawn } = require("child_process");
                const path = require("path");
                const projectRoot = path.join(__dirname, "../../..");
                const testScript = path.join(projectRoot, "scripts/test-new-features.sh");
                
                return new Promise<string>((resolve, reject) => {
                  const child = spawn("bash", [testScript], {
                    stdio: "inherit",
                    cwd: projectRoot,
                    env: {
                      ...process.env,
                      AGENTCLOUD_API_BASE: process.env.AGENTCLOUD_API_BASE || apiBase,
                      AGENTCLOUD_TOKEN: process.env.AGENTCLOUD_TOKEN || "dev-token",
                    },
                  });
                  
                  child.on("close", (code) => {
                    try {
                      process.stdin.setRawMode(true);
                      process.stdin.resume();
                    } catch {
                      /* ignore */
                    }
                    if (code === 0) {
                      resolve("✅ New features test completed successfully!");
                    } else {
                      resolve(`⚠️  Test completed with exit code ${code}. Check output above for details.`);
                    }
                  });
                  
                  child.on("error", (err) => {
                    try {
                      process.stdin.setRawMode(true);
                      process.stdin.resume();
                    } catch {
                      /* ignore */
                    }
                    reject(new Error(`Failed to run test: ${err.message}`));
                  });
                });
              } catch (err: unknown) {
                try {
                  process.stdin.setRawMode(true);
                  process.stdin.resume();
                } catch {
                  /* ignore */
                }
                const error = err instanceof Error ? err : new Error(String(err));
                throw error;
              }
            },
          },
        ],
      });

      mainMenu.push({
        label: "Manage Tokens (admin)",
        subMenu: [
          {
            label: "List Tokens",
            action: async () => {
              const result = await apiRequest("GET", "/v1/admin/tokens?limit=50");
              const tokens = result.tokens || [];
              if (!tokens.length) return "No tokens found.";

              const lines = tokens.map((t: any) => {
                const id = String(t.id || "").slice(0, 16);
                const role = String(t.role || "-").slice(0, 6);
                const prefix = String(t.token_prefix || t.tokenPrefix || "-").slice(0, 8);
                const userId = String(t.user_id || t.userId || "-").slice(0, 24);
                const status = t.revoked_at || t.revokedAt ? "revoked" : "active";
                const created = (t.created_at || t.createdAt || "").slice(0, 19);
                return `${id.padEnd(18)} ${role.padEnd(8)} ${prefix.padEnd(10)} ${userId.padEnd(
                  26
                )} ${status.padEnd(10)} ${created}`;
              });

              return [
                "ID".padEnd(18) +
                  "Role".padEnd(8) +
                  "Prefix".padEnd(10) +
                  "User ID".padEnd(26) +
                  "Status".padEnd(10) +
                  "Created",
                "-".repeat(90),
                ...lines,
              ].join("\n");
            },
          },
          {
            label: "Create Token",
            action: async () => {
              try {
                process.stdin.setRawMode(false);
                process.stdin.pause();
                
                const roleInput = (await promptLine("Role (admin/user, default admin): ")).trim();
                const role = roleInput === "user" ? "user" : "admin";
                const label = (await promptLine("Label (optional): ")).trim();
                const expiresInput = (await promptLine("Expires in days (optional): ")).trim();
                const expiresDays = expiresInput ? Number(expiresInput) : undefined;

                const result = await apiRequest("POST", "/v1/admin/tokens", {
                  role,
                  label: label || undefined,
                  expiresInDays: Number.isFinite(expiresDays as any) ? expiresDays : undefined,
                });
                
                restoreRawMode();

                return [
                  "🔑 Token created (shown once)",
                  `Role:    ${result.role}`,
                  `User ID: ${result.userId}`,
                  `Token ID:${result.id}`,
                  `Prefix:  ${result.tokenPrefix}`,
                  result.label ? `Label:  ${result.label}` : "",
                  result.expiresAt ? `Expires: ${result.expiresAt}` : "",
                  "",
                  result.token || "",
                ]
                  .filter(Boolean)
                  .join("\n");
              } catch (err: any) {
                restoreRawMode();
                throw err;
              }
            },
          },
          {
            label: "Revoke Token",
            action: async () => {
              try {
                process.stdin.setRawMode(false);
                process.stdin.pause();
                
                // Show a quick list first
                const list = await apiRequest("GET", "/v1/admin/tokens?limit=50");
                const tokens = list.tokens || [];
                if (!tokens.length) {
                  restoreRawMode();
                  return "No tokens found.";
                }

                const header =
                  "ID".padEnd(18) +
                  "Role".padEnd(8) +
                  "Prefix".padEnd(10) +
                  "User ID".padEnd(26) +
                  "Status".padEnd(10) +
                  "Created";
                console.log("\n" + header);
                console.log("-".repeat(90));
                tokens.forEach((t: any) => {
                  const id = String(t.id || "").slice(0, 16);
                  const role = String(t.role || "-").slice(0, 6);
                  const prefix = String(t.token_prefix || t.tokenPrefix || "-").slice(0, 8);
                  const userId = String(t.user_id || t.userId || "-").slice(0, 24);
                  const status = t.revoked_at || t.revokedAt ? "revoked" : "active";
                  const created = (t.created_at || t.createdAt || "").slice(0, 19);
                  console.log(
                    `${id.padEnd(18)} ${role.padEnd(8)} ${prefix.padEnd(10)} ${userId.padEnd(
                      26
                    )} ${status.padEnd(10)} ${created}`
                  );
                });

                const id = (await promptLine("Token ID to revoke: ")).trim();
                restoreRawMode();
                if (!id) return "No token id provided.";
                const result = await apiRequest("POST", "/v1/admin/tokens/revoke", { id });
                return `✅ Revoked ${id} at ${result.revokedAt || ""}`;
              } catch (err: any) {
                restoreRawMode();
                throw err;
              }
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
          {
            label: "Stop ALL Tunnel Clients (kill switch)",
            action: async () => stopAllTunnels(),
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

      // Add Exit option for authenticated users
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
      // Don't render menu for signup action - it handles its own output
      const isSignupAction = choice.label === "🚀 Get Started (Create Account)";
      if (!isSignupAction) {
        render();
      }
      let actionResult: string | undefined = undefined;
      try {
        actionResult = await choice.action();
        // If action returns undefined, it's handling its own exit (e.g., signup flow)
        if (actionResult === undefined) {
          busy = false;
          return; // Don't render menu, action is handling everything
        }
        // Only set message if action returned a string
        if (actionResult) {
          message = actionResult;
        }
        if (choice.label === "Exit") {
          exiting = true;
        }
      } catch (err: any) {
        message = `Error: ${err?.message || String(err)}`;
      } finally {
        busy = false;
        // Only render if we're not exiting (exiting actions handle their own cleanup)
        if (!exiting && actionResult !== undefined) {
          render();
        }
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
