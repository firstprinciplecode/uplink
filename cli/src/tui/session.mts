import fetch from "node-fetch";
import { apiRequest } from "../http";
import { clearScreen, promptLine, restoreRawMode, truncate } from "../subcommands/menu/io";
import { unauthenticatedRequest } from "../subcommands/menu/requests";
import { inlineSelect } from "../subcommands/menu/inline-tree-select";
import {
  colorDim,
  colorGreen,
  colorRed,
  colorWhite,
} from "../subcommands/menu/colors";
import { type MenuChoice } from "../subcommands/menu/types";
import {
  buildManageAliasesMenu,
  buildManageTokensMenu,
  buildManageTunnelsMenu,
  buildHostingMenu,
  buildDomainsMenu,
  buildSystemStatusMenu,
  buildUsageMenu,
} from "../subcommands/menu/menus";
import { ports, smoke, tokenConfig, tunnelClients } from "../subcommands/menu/effects";
import { runInkMenu } from "./runMenu";
import { launchDomainking } from "../utils/launchDomainking";
import { fetchMenuSnapshot } from "./snapshot";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

export async function startMenuSession(): Promise<void> {
    const apiBase = process.env.AGENTCLOUD_API_BASE || "https://api.uplink.spot";
    
    // Determine role (admin or user) via /v1/me; check if auth failed
    let isAdmin = false;
    let authFailed = false;
    const meStart = Date.now();
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
    const meDurationMs = Date.now() - meStart;

    // Build menu structure dynamically by role and auth status
    const mainMenu: MenuChoice[] = [];
    
    // If authentication failed, show ONLY "Get Started", "About", and "Exit"
    if (authFailed) {
      mainMenu.push({
        label: "🚀 Get Started (Create Account)",
        action: async () => {
          restoreRawMode();
          clearScreen();
          try {
            process.stdout.write("\n");
            process.stdout.write(colorWhite("UPLINK") + colorDim("  Create Account\n"));
            process.stdout.write("\n");

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
            process.stdout.write(colorDim("├─") + " Token     " + token + "\n");
            process.stdout.write(colorDim("├─") + " ID        " + tokenId + "\n");
            process.stdout.write(colorDim("├─") + " User      " + userId + "\n");
            process.stdout.write(colorDim("├─") + " Role      " + result.role + "\n");
            if (result.expiresAt) {
              process.stdout.write(colorDim("└─") + " Expires   " + result.expiresAt + "\n");
            } else {
              process.stdout.write(colorDim("└─") + " Expires   " + colorDim("never") + "\n");
            }
            process.stdout.write("\n");
            process.stdout.write(colorDim("!") + " Save this token securely — shown only once\n");

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
                      colorRed(`\n! Token may not have been written correctly. Check ~/.${shellName}rc`)
                    );
                  }
                } catch (err: any) {
                  if (err?.message?.includes("UNSAFE_SHELL_CONFIG_PERMISSIONS")) {
                    console.log(
                      colorRed(
                        `\n! Could not write to ~/.${shellName}rc: file is group/world writable. Fix permissions first.`
                      )
                    );
                    console.log(colorDim(`  chmod 600 ~/.${shellName}rc`));
                  } else {
                    console.log(colorRed(`\n! Could not write to ~/.${shellName}rc: ${err.message}`));
                  }
                  console.log(`\n  Please add manually:`);
                  console.log(colorDim(`  echo 'export AGENTCLOUD_TOKEN=${token}' >> ~/.${shellName}rc`));
                }
              }
            } else {
              console.log(colorDim(`\n→ Could not detect your shell. Add the token manually:`));
              console.log(colorDim(`  echo 'export AGENTCLOUD_TOKEN=${token}' >> ~/.zshrc  # for zsh`));
              console.log(colorDim(`  echo 'export AGENTCLOUD_TOKEN=${token}' >> ~/.bashrc  # for bash`));
            }

            if (!tokenAdded) {
            process.stdout.write("\n");
            process.stdout.write(colorDim("!") + " Set this token as an environment variable:\n\n");
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
              process.stdout.write(`\n${colorDim("→")} Next: run in your terminal:\n`);
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
        label: "Find a domain",
        action: async () => {
          restoreRawMode();
          return launchDomainking();
        },
      });

      mainMenu.push({
        label: "About",
        action: async () => {
          return [
            "Uplink CLI",
            "Open source CLI for sharing localhost and hosting apps.",
            "Interactive menu + agent-friendly commands for automation.",
            "",
            "Website: https://uplink.spot",
            "GitHub: https://github.com/firstprinciplecode/uplink",
            "Issues: https://github.com/firstprinciplecode/uplink/issues",
          ].join("\n");
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

    const shareMenu = buildManageTunnelsMenu({
      apiRequest,
      promptLine,
      restoreRawMode,
      truncate,
      formatBytes,
      inlineSelect,
      scanCommonPorts: ports.scanCommonPorts,
      findTunnelClients: tunnelClients.findTunnelClients,
      createAndStartTunnel: (port: number) => tunnelClients.createAndStartTunnel(apiRequest, port),
      stopTunnelClients: (clients, opts) => tunnelClients.stopTunnelClients(apiRequest, clients, opts),
      colorDim,
      colorRed,
    });

    const aliasesMenu = buildManageAliasesMenu({
      apiRequest,
      promptLine,
      restoreRawMode,
      inlineSelect,
      findTunnelClients: tunnelClients.findTunnelClients,
      truncate,
    });

    shareMenu.subMenu = shareMenu.subMenu || [];
    if (aliasesMenu.subMenu) {
      shareMenu.subMenu.push({
        label: "Aliases",
        subMenu: aliasesMenu.subMenu,
      });
    }
    if (isAdmin) {
      shareMenu.subMenu.push({
        label: "⚠️  Stop ALL Tunnel Clients (kill switch)",
        action: async () => {
          const clients = tunnelClients.findTunnelClients();
          if (clients.length === 0) {
            const ghost = await tunnelClients.stopTunnelClients(apiRequest, [], {
              connectedGhosts: true,
            });
            if (ghost.deleted > 0) {
              return `✓ Removed ${ghost.deleted} relay-connected tunnel${ghost.deleted !== 1 ? "s" : ""} with no local client`;
            }
            return "No running tunnel clients found.";
          }
          const { killed, deleted } = await tunnelClients.stopTunnelClients(apiRequest, clients);
          return `✓ Stopped ${killed} local client${killed !== 1 ? "s" : ""}, removed ${deleted} tunnel record${deleted !== 1 ? "s" : ""}`;
        },
      });
    }

    mainMenu.push(shareMenu);

    mainMenu.push(
      buildHostingMenu({
        promptLine,
        restoreRawMode,
        inlineSelect,
      })
    );

    mainMenu.push(
      buildDomainsMenu({
        promptLine,
        restoreRawMode,
        inlineSelect,
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
    }

    mainMenu.push({
      label: "About",
      action: async () => {
        return [
          "Uplink CLI",
          "Open source CLI for sharing localhost and hosting apps.",
          "Interactive menu + agent-friendly commands for automation.",
          "",
          "Website: https://uplink.spot",
          "GitHub: https://github.com/firstprinciplecode/uplink",
          "Issues: https://github.com/firstprinciplecode/uplink/issues",
        ].join("\n");
      },
    });

    mainMenu.push({
      label: "Exit",
      action: async () => "Goodbye!",
    });
    }

    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("Uplink menu needs an interactive terminal. Use `uplink --help` for commands.");
      process.exit(1);
    }

    await runInkMenu({ tree: mainMenu, getStatus: fetchMenuSnapshot });
}