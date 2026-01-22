import { Command } from "commander";
import fetch from "node-fetch";
import { apiRequest } from "../http";
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
  buildHostingMenu,
  buildSystemStatusMenu,
  buildUsageMenu,
} from "./menu/menus";
import { health, ports, smoke, tokenConfig, tunnelClients, tty } from "./menu/effects";

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
            const detected = tokenConfig.detectShellConfigFile();
            let configFile: string | null = detected.configFile;
            let shellName = detected.shellName;

            let tokenAdded = false;
            const tokenExists = configFile ? tokenConfig.shellConfigHasToken(configFile) : false;

            if (configFile) {
              const promptText = tokenExists
                ? `\n→ Update existing token in ~/.${shellName}rc? (Y/n): `
                : `\n→ Add token to ~/.${shellName}rc? (Y/n): `;
              
              const addToken = (await promptLine(promptText)).trim().toLowerCase();
              if (addToken !== "n" && addToken !== "no") {
                try {
                  const res = tokenConfig.upsertShellToken(configFile, token);
                  tokenAdded = res.wrote;
                  if (tokenExists) {
                    console.log(colorGreen(`\n✓ Token updated in ~/.${shellName}rc`));
                  } else {
                    console.log(colorGreen(`\n✓ Token added to ~/.${shellName}rc`));
                  }
                  if (!res.verifyOk) {
                    console.log(
                      colorYellow(`\n! Warning: Token may not have been written correctly. Please check ~/.${shellName}rc`)
                    );
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
          runSmoke: smoke.runSmoke,
        })
      );
    }

    mainMenu.push(
      buildHostingMenu({
        promptLine,
        restoreRawMode,
      })
    );

    mainMenu.push(
      buildManageTunnelsMenu({
        apiRequest,
        promptLine,
        restoreRawMode,
        truncate,
        formatBytes,
        inlineSelect,
          scanCommonPorts: ports.scanCommonPorts,
          findTunnelClients: tunnelClients.findTunnelClients,
          createAndStartTunnel: (port: number) => tunnelClients.createAndStartTunnel(apiRequest, port),
          killTunnelClient: tunnelClients.killTunnelClient,
          killAllTunnelClients: tunnelClients.killAllTunnelClients,
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
        findTunnelClients: tunnelClients.findTunnelClients,
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
          const clients = tunnelClients.findTunnelClients();
          if (clients.length === 0) {
            return "No running tunnel clients found.";
          }
          const killed = tunnelClients.killAllTunnelClients(clients);
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
      const clients = tunnelClients.findTunnelClients();
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
      const res = await health.checkApiHealth({});
      if (res.ok) cachedRelayStatus = "API: ok";
      else if (typeof res.status === "number") cachedRelayStatus = `API: unreachable (HTTP ${res.status})`;
      else cachedRelayStatus = "API: unreachable";
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
        cachedActiveTunnels,
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