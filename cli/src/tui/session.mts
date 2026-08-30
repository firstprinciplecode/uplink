import fetch from "node-fetch";
import { apiRequest } from "../http";
import { clearScreen, promptLine, restoreRawMode, truncate } from "../subcommands/menu/io";
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
import { buildFindDomainAction } from "../subcommands/menu/menus/domain-check";
import { ports, smoke, tunnelClients } from "../subcommands/menu/effects";
import { runInkMenu } from "./runMenu";
import { fetchMenuSnapshot } from "./snapshot";
import { isEmail, normalizeEmail, persistLogin, requestLoginCode, verifyLoginCode } from "../utils/login-flow";
import { ensureGuestAccess } from "../utils/guest-access";

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + " " + sizes[i];
}

async function continueWithEmail(): Promise<string | undefined> {
  restoreRawMode();
  clearScreen();
  try {
    process.stdout.write("\n");
    process.stdout.write(colorWhite("UPLINK") + colorDim("  Continue with email\n\n"));
    const email = normalizeEmail(await promptLine("Email: "));
    if (!isEmail(email)) return "Invalid email.";

    await requestLoginCode(email);
    process.stdout.write(`\nCode sent to ${email}.\n`);
    const code = (await promptLine("Code: ")).trim();
    if (!/^\d{6}$/.test(code)) return "Code must be 6 digits.";

    const result = await verifyLoginCode(email, code);
    if (!result?.token) return "Invalid response from server. Token not received.";
    const savedTo = persistLogin(result, email);
    process.stdout.write(`\n${colorGreen("✓")} Account verified\n`);
    process.stdout.write(colorDim(`  ${savedTo}\n\n`));
    return "Email verified. Run uplink again to see Hosting and Domains.";
  } catch (err: any) {
    const errorMsg = err?.message || String(err);
    if (errorMsg.includes("429") || errorMsg.includes("RATE_LIMIT")) {
      return "Too many attempts. Please try again later.";
    }
    return `Email verification failed: ${errorMsg}`;
  } finally {
    restoreRawMode();
  }
}

const aboutItem: MenuChoice = {
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
};

const exitItem: MenuChoice = {
  label: "Exit",
  action: async () => "Goodbye!",
};

export async function startMenuSession(): Promise<void> {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("Uplink menu needs an interactive terminal. Use `uplink --help` for commands.");
      process.exit(1);
    }

    const apiBase = process.env.AGENTCLOUD_API_BASE || "https://api.uplink.spot";

    let isAdmin = false;
    let accountType: "guest" | "verified" | "admin" | null = null;
    let connectionError: string | null = null;

    const resolveAccount = async (): Promise<void> => {
      const me = await apiRequest("GET", "/v1/me");
      isAdmin = me?.role === "admin";
      accountType = isAdmin ? "admin" : me?.accountType === "verified" ? "verified" : "guest";
    };

    try {
      await resolveAccount();
    } catch (err: any) {
      const errorMsg = err?.message || String(err);
      const authFailed =
        errorMsg.includes("UNAUTHORIZED") ||
        errorMsg.includes("401") ||
        errorMsg.includes("Missing or invalid token") ||
        errorMsg.includes("Missing AGENTCLOUD_TOKEN");
      if (authFailed) {
        // No usable token: quietly create guest access so everyone gets the same menu.
        try {
          await ensureGuestAccess({ force: true });
          await resolveAccount();
        } catch (guestErr: any) {
          connectionError = guestErr?.message || String(guestErr);
        }
      } else {
        connectionError = errorMsg;
      }
    }

    const mainMenu: MenuChoice[] = [];

    if (!accountType) {
      // API unreachable (or guest provisioning failed): minimal offline menu.
      mainMenu.push({
        label: "Connection details",
        action: async () => {
          return [
            `Could not reach ${apiBase}.`,
            "",
            connectionError ?? "Unknown error.",
            "",
            "Check your network, then run uplink again.",
          ].join("\n");
        },
      });
      mainMenu.push(aboutItem);
      mainMenu.push(exitItem);
    } else {

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

    shareMenu.subMenu = shareMenu.subMenu || [];
    if (accountType !== "guest") {
      const aliasesMenu = buildManageAliasesMenu({
        apiRequest,
        promptLine,
        restoreRawMode,
        inlineSelect,
        findTunnelClients: tunnelClients.findTunnelClients,
        truncate,
      });
      if (aliasesMenu.subMenu) {
        shareMenu.subMenu.push({
          label: "Aliases",
          subMenu: aliasesMenu.subMenu,
        });
      }
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

    if (accountType === "guest") {
      mainMenu.push({
        label: "Find a domain",
        action: buildFindDomainAction({ promptLine, restoreRawMode }),
      });
      mainMenu.push({
        label: "Continue with email  (unlock hosting + domains)",
        action: continueWithEmail,
      });
    } else {
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
    }

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

    mainMenu.push(aboutItem);
    mainMenu.push(exitItem);
    }

    await runInkMenu({ tree: mainMenu, getStatus: fetchMenuSnapshot });
}
