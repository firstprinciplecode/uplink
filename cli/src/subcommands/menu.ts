import { Command } from "commander";
import fetch from "node-fetch";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { apiRequest } from "../http";
import { scanCommonPorts } from "../utils/port-scanner";
import { ASCII_UPLINK, colorCyan, colorDim, colorGreen, colorRed, colorWhite, colorYellow } from "./menu/colors";
import { clearScreen, promptLine, restoreRawMode, truncate } from "./menu/io";
import { inlineSelect, SelectOption } from "./menu/inline-select";
import { unauthenticatedRequest } from "./menu/requests";
import { createAndStartTunnel, findTunnelClients } from "./menu/tunnels";
import { runSmoke } from "./menu/tests";

type MenuChoice = {
  label: string;
  action?: () => Promise<string>;
  subMenu?: MenuChoice[];
};

const TOKEN_DOMAIN = process.env.TUNNEL_DOMAIN || "x.uplink.spot";
const ALIAS_DOMAIN = process.env.ALIAS_DOMAIN || "uplink.spot";
const URL_SCHEME = (process.env.TUNNEL_URL_SCHEME || "https").toLowerCase();

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
        label: "Get Started",
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
                return "Error: No response from server.";
              }
            } catch (err: any) {
              restoreRawMode();
              const errorMsg = err?.message || String(err);
              console.error("\nSignup error:", errorMsg);
              if (errorMsg.includes("429") || errorMsg.includes("RATE_LIMIT")) {
                return "Too many signup attempts. Please try again later.";
              }
              return `Error creating account: ${errorMsg}`;
            }

            if (!result || !result.token) {
              restoreRawMode();
              return "Error: Invalid response from server. Token not received.";
            }

            const token = result.token;
            const tokenId = result.id;
            const userId = result.userId;
            const safeToken = token.replace(/'/g, `'\"'\"'`);

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
                        return `export AGENTCLOUD_TOKEN='${safeToken}'`;
                      }
                      return line;
                    });
                    const wasReplaced = updatedLines.some((line, idx) => line !== lines[idx]);
                    if (!wasReplaced) {
                      updatedLines.push(`export AGENTCLOUD_TOKEN='${safeToken}'`);
                    }
                    writeFileSync(configFile, updatedLines.join("\n"), { flag: "w", mode: 0o644 });
                    tokenAdded = true;
                    console.log(colorGreen(`\n✓ Token updated in ~/.${shellName}rc`));
                    const verifyContent = readFileSync(configFile, "utf-8");
                    if (!verifyContent.includes(`export AGENTCLOUD_TOKEN=${token}`)) {
                      console.log(colorYellow(`\n! Warning: Token may not have been written correctly. Please check ~/.${shellName}rc`));
                    }
                  } else {
                    const exportLine = `\n# Uplink API Token (added automatically)\nexport AGENTCLOUD_TOKEN='${safeToken}'\n`;
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
              return "Too many signup attempts. Please try again later.";
            }
            return `Error creating account: ${errorMsg}`;
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
          {
            label: "View Connected Tunnels",
            action: async () => {
              try {
                const data = await apiRequest("GET", "/v1/admin/relay-status") as { 
                  connectedTunnels?: number; 
                  tunnels?: Array<{ token: string; clientIp: string; targetPort: number; connectedAt: string; connectedFor: string }>;
                  timestamp?: string;
                  error?: string;
                  message?: string;
                };
                
                if (data.error) {
                  return `Error: ${data.error}${data.message ? ` - ${data.message}` : ""}`;
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
                return `Error: Failed to get relay status - ${err.message}`;
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
                      process.kill(p.pid, "SIGTERM");
                      killed++;
                    } catch {
                      // Process might have already exited
                    }
                  }
                } else {
                  // Kill specific client
                  const pid = result.value as number;
                  try {
                    process.kill(pid, "SIGTERM");
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
            label: "Set Permanent Alias",
            action: async () => {
              const data = await apiRequest("GET", "/v1/tunnels");
              const tunnels = data.tunnels || [];
              if (!tunnels.length) return "No tunnels found.";

              const options: SelectOption[] = tunnels.map((t: any) => {
                const token = truncate(t.token || "", 10);
                const alias = t.alias ? colorGreen(t.alias) : colorDim("none");
                const port = t.target_port ?? t.targetPort ?? "-";
                return {
                  label: `${token.padEnd(12)} port ${String(port).padEnd(5)} alias ${alias}`,
                  value: t.id,
                };
              });

              const choice = await inlineSelect("Select tunnel for alias", options, true);
              if (choice === null) return "";

              try {
                process.stdin.setRawMode(false);
              } catch {
                /* ignore */
              }
              const aliasInput = await promptLine("Enter alias (e.g. thomas): ");
              restoreRawMode();
              const alias = aliasInput.trim();
              if (!alias) return "Alias not set (empty).";

              try {
                const result = await apiRequest("POST", `/v1/tunnels/${choice.value}/alias`, {
                  alias,
                });
                const aliasUrl = result.aliasUrl || `${URL_SCHEME}://${alias}.${ALIAS_DOMAIN}`;
                const tokenUrl = result.url || `${URL_SCHEME}://${result.token}.${TOKEN_DOMAIN}`;
                return [
                  "✓ Alias updated",
                  `→ Alias URL   ${aliasUrl}`,
                  `→ Token URL   ${tokenUrl}`,
                ].join("\n");
              } catch (err: any) {
                const errMsg = err?.message || String(err);
                // Check for premium feature errors
                if (errMsg.includes("ALIAS_NOT_ENABLED")) {
                  try {
                    const parsed = JSON.parse(errMsg);
                    const userId = parsed?.error?.details?.user_id || "(check your token)";
                    return [
                      "",
                      colorYellow("Permanent Aliases - Premium Feature"),
                      "",
                      "Permanent aliases give you stable URLs like:",
                      `  ${colorGreen(`https://myapp.${ALIAS_DOMAIN}`)}`,
                      "",
                      "Instead of regenerating tokens each time.",
                      "",
                      "To unlock this feature:",
                      `  → Join our Discord: ${colorCyan("https://uplink.spot")}`,
                      `  → Share your user ID: ${colorDim(userId)}`,
                      "",
                      "We'll enable it for your account!",
                      "",
                    ].join("\n");
                  } catch {
                    return colorYellow("Aliases are a premium feature. Contact us at uplink.spot to upgrade.");
                  }
                }
                if (errMsg.includes("ALIAS_LIMIT_REACHED")) {
                  return colorYellow("You've reached your alias limit. Contact us to increase it.");
                }
                throw err; // Re-throw other errors
              }
            },
          },
          {
            label: "Remove Alias",
            action: async () => {
              const data = await apiRequest("GET", "/v1/tunnels");
              const tunnels = (data.tunnels || []).filter((t: any) => !!t.alias);
              if (!tunnels.length) return "No tunnels with aliases.";

              const options: SelectOption[] = tunnels.map((t: any) => ({
                label: `${truncate(t.token || "", 10).padEnd(12)} alias ${colorGreen(t.alias)}`,
                value: t.id,
              }));

              const choice = await inlineSelect("Select tunnel to remove alias", options, true);
              if (choice === null) return "";

              await apiRequest("DELETE", `/v1/tunnels/${choice.value}/alias`);
              return "✓ Alias removed";
            },
          },
        ],
      });

    mainMenu.push({
      label: "Usage",
      subMenu: [
        {
          label: isAdmin ? "List All Tunnels" : "List My Tunnels",
          action: async () => {
            const runningClients = findTunnelClients();
            const path = isAdmin ? "/v1/admin/tunnels?limit=20" : "/v1/tunnels";
            const result = await apiRequest("GET", path);
            const tunnels = result.tunnels || result?.items || [];
            if (!tunnels || tunnels.length === 0) {
              return "No tunnels found.";
            }
            const lines = tunnels.map((t: any) => {
              const token = t.token || "";
              const alias = t.alias || "-";
              const tokenUrl = t.url || `${URL_SCHEME}://${token}.${TOKEN_DOMAIN}`;
              const aliasUrl =
                t.aliasUrl || (t.alias ? `${URL_SCHEME}://${t.alias}.${ALIAS_DOMAIN}` : "-");
              const connectedFromApi = t.connected ?? false;
              const connectedLocal = runningClients.some((c) => c.token === token);
              const connectionStatus = isAdmin
                ? connectedFromApi
                  ? "connected"
                  : "disconnected"
                : connectedLocal
                ? "connected"
                : "unknown";

              return [
                `${truncate(t.id, 12)}  ${truncate(token, 10).padEnd(12)}  ${String(
                  t.target_port ?? t.targetPort ?? "-"
                ).padEnd(5)}  ${connectionStatus.padEnd(12)}  ${truncate(
                  t.created_at ?? t.createdAt ?? "",
                  19
                )}`,
                `    url:   ${tokenUrl}`,
                `    alias: ${aliasUrl} (${alias})`,
              ].join("\n");
            });
            return [
              "ID           Token         Port   Connection   Created",
              "-".repeat(90),
              ...lines,
            ].join("\n\n");
          },
        },
        {
          label: isAdmin ? "List All Databases" : "List My Databases",
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
        label: "Manage Tokens",
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
          {
            label: "Grant Alias Access",
            action: async () => {
              try {
                // Fetch available tokens to show users
                const result = await apiRequest("GET", "/v1/admin/tokens");
                const tokens = result.tokens || [];
                
                if (tokens.length === 0) {
                  restoreRawMode();
                  return "No tokens found.";
                }
                
                // Build options from tokens (group by user_id)
                const userMap = new Map<string, any>();
                for (const t of tokens) {
                  const userId = t.user_id || t.userId;
                  if (userId && !userMap.has(userId)) {
                    userMap.set(userId, t);
                  }
                }
                
                const options: SelectOption[] = Array.from(userMap.entries()).map(([userId, t]) => ({
                  label: `${truncate(userId, 20)} ${colorDim(`${t.role || "user"} - ${t.label || "no label"}`)}`,
                  value: userId,
                }));
                
                const selected = await inlineSelect("Select user to grant alias access", options, true);
                
                if (selected === null) {
                  restoreRawMode();
                  return "";
                }
                
                const userId = selected.value as string;
                
                // Prompt for limit
                try {
                  process.stdin.setRawMode(false);
                } catch {
                  /* ignore */
                }
                const limitAnswer = await promptLine("Alias limit (1-10, or -1 for unlimited, default 1): ");
                restoreRawMode();
                
                const aliasLimit = limitAnswer.trim() ? parseInt(limitAnswer.trim(), 10) : 1;
                if (isNaN(aliasLimit) || aliasLimit < -1 || aliasLimit > 100) {
                  return "Invalid limit. Must be -1 (unlimited) or 0-100.";
                }
                
                await apiRequest("POST", "/v1/admin/grant-alias", { userId, aliasLimit });
                
                const limitDesc = aliasLimit === -1 ? "unlimited" : String(aliasLimit);
                return [
                  "✓ Alias access granted",
                  "",
                  `→ User      ${userId}`,
                  `→ Limit     ${limitDesc} alias(es)`,
                ].join("\n");
              } catch (err: any) {
                restoreRawMode();
                throw err;
              }
            },
          },
        ],
      });

      // Admin-only: Stop ALL Tunnel Clients
      mainMenu.push({
        label: "Stop All Tunnel Clients",
        action: async () => {
          const clients = findTunnelClients();
          if (clients.length === 0) {
            return "No running tunnel clients found.";
          }
          let killed = 0;
          for (const client of clients) {
            try {
              process.kill(client.pid, "SIGTERM");
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
        const tunnelLines = clients.map((client, idx) => {
          const url = `${URL_SCHEME}://${client.token}.${TOKEN_DOMAIN}`;
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
        
        // Style based on selection and type
        let label: string;
        let branchColor: string;
        const labelLower = choice.label.toLowerCase();
        
        if (isSelected) {
          // Selected: cyan highlight
          branchColor = colorCyan(branch);
          if (labelLower.includes("exit")) {
            label = colorDim(choice.label);
          } else if (labelLower.includes("stop all")) {
            label = colorRed(choice.label);
          } else if (labelLower.includes("get started")) {
            label = colorGreen(choice.label);
          } else {
            label = colorCyan(choice.label);
          }
        } else {
          // Not selected: white text
          branchColor = colorWhite(branch);
          if (labelLower.includes("exit")) {
            label = colorDim(choice.label);
          } else if (labelLower.includes("stop all")) {
            label = colorRed(choice.label);
          } else if (labelLower.includes("get started")) {
            label = colorGreen(choice.label);
          } else {
            label = colorWhite(choice.label);
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
          // Style success/error prefixes consistently
          let styledLine = line
            .replace(/^✓\s*/, colorGreen("✓ "))
            .replace(/^→\s*/, colorCyan("→ "))
            .replace(/^Error:\s*/, colorRed("✗ "));
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

