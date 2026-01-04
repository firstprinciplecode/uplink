import { Command } from "commander";
import fetch from "node-fetch";
import { spawn, execSync } from "child_process";
import { apiRequest } from "../http";
import { scanCommonPorts, testHttpPort } from "../utils/port-scanner";
import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { clearScreen, promptLine, restoreRawMode, truncate } from "./menu/io";
import { unauthenticatedRequest } from "./menu/requests";
import { inlineSelect, type SelectOption } from "./menu/inline-tree-select";
import {
  colorBold,
  colorCyan,
  colorDim,
  colorGreen,
  colorMagenta,
  colorRed,
  colorYellow,
} from "./menu/colors";
import { DEFAULT_MENU_MESSAGE, type MenuChoice } from "./menu/types";
import { getCurrentMenu, initNav, moveSelection, popMenu, pushSubMenu, type MenuNavState } from "./menu/nav";
import { renderMenu } from "./menu/render";
import {
  buildManageAliasesMenu,
  buildManageTokensMenu,
  buildManageTunnelsMenu,
  buildSystemStatusMenu,
  buildUsageMenu,
} from "./menu/menus";

// ASCII banner with color styling
const ASCII_UPLINK = colorCyan([
  "██╗   ██╗██████╗ ██╗     ██╗███╗   ██╗██╗  ██╗",
  "██║   ██║██╔══██╗██║     ██║████╗  ██║██║ ██╔╝",
  "██║   ██║██████╔╝██║     ██║██╔██╗ ██║█████╔╝ ",
  "██║   ██║██╔═══╝ ██║     ██║██║╚██╗██║██╔═██╗ ",
  "╚██████╔╝██║     ███████╗██║██║ ╚████║██║  ██╗",
  " ╚═════╝ ╚═╝     ╚══════╝╚═╝╚═╝  ╚═══╝╚═╝  ╚═╝",
].join("\n"));

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
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
      mainMenu.push(
        buildSystemStatusMenu({
          apiBase,
          apiRequest,
          fetch: (url: string) => fetch(url) as any,
          truncate,
          formatBytes,
          runSmoke,
        })
      );
    }

    mainMenu.push(
      buildManageTunnelsMenu({
        apiRequest,
        promptLine,
        restoreRawMode,
        truncate,
        formatBytes,
        inlineSelect,
        scanCommonPorts,
        findTunnelClients,
        createAndStartTunnel,
        execSync: (cmd, opts) => execSync(cmd, opts),
        colorDim,
        colorRed,
      })
    );

    // Manage Aliases (Premium feature)
    mainMenu.push(
      buildManageAliasesMenu({
        apiRequest,
        promptLine,
        restoreRawMode,
        inlineSelect,
        findTunnelClients,
        truncate,
      })
    );

    // Admin-only: Usage section
    if (isAdmin) {
      mainMenu.push(
        buildUsageMenu({
          apiRequest,
          truncate,
        })
      );
    }

    // Admin-only: Manage Tokens
    if (isAdmin) {
      mainMenu.push(
        buildManageTokensMenu({
          apiRequest,
          promptLine,
          restoreRawMode,
          truncate,
        })
      );

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
    let nav: MenuNavState = initNav(mainMenu);
    let message = DEFAULT_MENU_MESSAGE;
    let exiting = false;
    let busy = false;
    
    // Cache active tunnels info - only update at start or when returning to main menu
    let cachedActiveTunnels = "";
    let cachedRelayStatus = "";

    const updateActiveTunnelsCache = () => {
      const clients = findTunnelClients();
      if (clients.length === 0) {
        cachedActiveTunnels = "";
      } else {
        // Default domain should be the current production domain; allow override via env.
        const domain = process.env.TUNNEL_DOMAIN || "x.uplink.spot";
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
      const apiBase = process.env.AGENTCLOUD_API_BASE || "https://api.uplink.spot";
      const healthUrl = process.env.RELAY_HEALTH_URL || `${apiBase}/health`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      try {
        const headers: Record<string, string> = {};
        if (process.env.RELAY_INTERNAL_SECRET) {
          headers["x-relay-internal-secret"] = process.env.RELAY_INTERNAL_SECRET;
        }
        const res = await fetch(healthUrl, { signal: controller.signal, headers });
        if (res.ok) {
          cachedRelayStatus = "API: ok";
        } else {
          cachedRelayStatus = `API: unreachable (HTTP ${res.status})`;
        }
      } catch {
        cachedRelayStatus = "API: unreachable";
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
      renderMenu({
        banner: ASCII_UPLINK,
        cachedRelayStatus,
        menuPath: nav.menuPath,
        currentMenu: getCurrentMenu(nav),
        selected: nav.selected,
        message,
        busy,
        showStatusIndicator: nav.menuStack.length === 1,
      });
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
      const currentMenu = getCurrentMenu(nav);
      const choice = currentMenu[nav.selected];
      
      if (choice.subMenu) {
        // Navigate into sub-menu
        nav = pushSubMenu(nav, choice);
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
      const currentMenu = getCurrentMenu(nav);
      
      if (str === "\u0003") {
        cleanup();
        process.exit(0);
      } else if (str === "\u001b[D") {
        // Left arrow - go back
        if (nav.menuStack.length > 1) {
          nav = popMenu(nav);
          // Refresh caches when returning to main menu
          if (nav.menuStack.length === 1) {
            await refreshMainMenuCaches();
            return;
          }
          render();
        }
      } else if (str === "\u001b[A") {
        // Up
        nav = moveSelection(nav, -1);
        render();
      } else if (str === "\u001b[B") {
        // Down
        nav = moveSelection(nav, 1);
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

  // Create tunnel
  const result = await apiRequest("POST", "/v1/tunnels", { port });
  const url = result.url || "(no url)";
  const token = result.token || "(no token)";
  const alias = result.alias || null;
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

function runSmoke(script: "smoke:tunnel" | "smoke:db" | "smoke:all" | "test:comprehensive") {
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