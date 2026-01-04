import type { MenuChoice } from "../types";
import type { SelectOption } from "../inline-tree-select";

type Deps = {
  apiRequest: (method: string, path: string, body?: unknown) => Promise<any>;
  promptLine: (question: string) => Promise<string>;
  restoreRawMode: () => void;
  inlineSelect: (
    title: string,
    options: SelectOption[],
    includeBack?: boolean
  ) => Promise<{ index: number; value: string | number | null } | null>;
  findTunnelClients: () => Array<{ pid: number; port: number; token: string }>;
  truncate: (text: string, max: number) => string;
};

export function buildManageAliasesMenu(deps: Deps): MenuChoice {
  const { apiRequest, promptLine, restoreRawMode, inlineSelect, findTunnelClients, truncate } = deps;

  return {
    label: "Manage Aliases",
    subMenu: [
      {
        label: "My Aliases",
        action: async () => {
          try {
            const result = await apiRequest("GET", "/v1/tunnels/aliases");
            const aliases = result.aliases || [];

            if (aliases.length === 0) {
              return ["No aliases configured.", "", "Use 'Create Alias' to set up a permanent URL for a port."].join("\n");
            }

            const runningClients = findTunnelClients();
            const runningPorts = new Set(runningClients.map((c) => c.port));

            const lines = aliases.map((a: any) => {
              const alias = a.alias.padEnd(15);
              const port = String(a.targetPort || a.target_port).padEnd(6);
              const status = runningPorts.has(a.targetPort || a.target_port) ? "active" : "inactive";
              return `${alias}  ${port}  ${status}`;
            });

            return ["Alias            Port    Status", "-".repeat(40), ...lines, "", "Active = tunnel running on that port"].join(
              "\n"
            );
          } catch (err: any) {
            const msg = err?.message || String(err);
            if (msg.includes("ALIAS_NOT_ENABLED") || msg.includes("403")) {
              return ["❌ Aliases are a premium feature", "", "Contact us on Discord at uplink.spot to upgrade."].join("\n");
            }
            throw err;
          }
        },
      },
      {
        label: "Create Alias",
        action: async () => {
          let aliasName = "";
          let port = 0;
          try {
            // Step 1: Select port - show running tunnels + custom option
            const runningClients = findTunnelClients();
            const portOptions: SelectOption[] = [];

            // Add running tunnel ports
            for (const client of runningClients) {
              portOptions.push({ label: `Port ${client.port} (tunnel running)`, value: client.port });
            }

            // Add custom option
            portOptions.push({ label: "Enter custom port", value: "custom" });

            const portChoice = await inlineSelect("Select port to create alias for", portOptions, true);
            if (portChoice === null) {
              restoreRawMode();
              return "";
            }

            if (portChoice.value === "custom") {
              try {
                process.stdin.setRawMode(false);
              } catch {
                /* ignore */
              }
              const portStr = await promptLine("Enter port number (e.g. 3000): ");
              port = Number(portStr);
              if (!port || port < 1 || port > 65535) {
                restoreRawMode();
                return "Invalid port number.";
              }
            } else {
              port = portChoice.value as number;
            }

            // Step 2: Enter alias name
            try {
              process.stdin.setRawMode(false);
            } catch {
              /* ignore */
            }
            aliasName = await promptLine("Enter alias name (e.g. my-app): ");
            restoreRawMode();

            if (!aliasName.trim()) {
              return "No alias provided.";
            }

            const result = await apiRequest("POST", "/v1/tunnels/aliases", { alias: aliasName.trim(), port });

            const tunnelRunning = runningClients.some((c) => c.port === port);
            const statusMsg = tunnelRunning ? "Alias is now active!" : "Start a tunnel on this port to make it accessible.";

            return [
              "✓ Alias created",
              "",
              `→ Alias     ${result.alias}`,
              `→ Port      ${result.targetPort}`,
              `→ URL       ${result.url}`,
              "",
              statusMsg,
            ].join("\n");
          } catch (err: any) {
            restoreRawMode();
            const msg = err?.message || String(err);
            if (msg.includes("ALIAS_NOT_ENABLED")) {
              return ["❌ Aliases are a premium feature", "", "Contact us on Discord at uplink.spot to upgrade."].join("\n");
            }
            if (msg.includes("ALIAS_LIMIT_REACHED")) {
              return ["❌ Alias limit reached", "", "You've reached your alias limit. Contact us to increase it."].join("\n");
            }
            if (msg.includes("ALIAS_TAKEN")) {
              return `❌ Alias "${aliasName.trim()}" is already taken. Try a different name.`;
            }
            if (msg.includes("PORT_HAS_ALIAS")) {
              return `❌ Port ${port} already has an alias. Use 'Reassign Alias' to change it.`;
            }
            throw err;
          }
        },
      },
      {
        label: "Reassign Alias",
        action: async () => {
          try {
            const result = await apiRequest("GET", "/v1/tunnels/aliases");
            const aliases = result.aliases || [];

            if (aliases.length === 0) {
              restoreRawMode();
              return "No aliases to reassign. Create one first.";
            }

            // Step 1: Select which alias to reassign
            const aliasOptions: SelectOption[] = aliases.map((a: any) => ({
              label: `${a.alias} → port ${a.targetPort || a.target_port}`,
              value: a.alias,
            }));

            const aliasChoice = await inlineSelect("Select alias to reassign", aliasOptions, true);
            if (aliasChoice === null) {
              restoreRawMode();
              return "";
            }

            const selectedAlias = aliases.find((a: any) => a.alias === aliasChoice.value);
            const currentPort = selectedAlias?.targetPort || selectedAlias?.target_port;

            // Step 2: Show available ports (running tunnels + custom option)
            const runningClients = findTunnelClients();
            const portOptions: SelectOption[] = [];

            // Add running tunnel ports (excluding current port)
            for (const client of runningClients) {
              if (client.port !== currentPort) {
                portOptions.push({ label: `Port ${client.port} (tunnel running)`, value: client.port });
              }
            }

            // Add current port indicator if tunnel is running
            const currentRunning = runningClients.find((c) => c.port === currentPort);
            if (currentRunning) {
              portOptions.unshift({ label: `Port ${currentPort} (current, tunnel running)`, value: `current-${currentPort}` });
            }

            // Add custom option
            portOptions.push({ label: "Enter custom port", value: "custom" });

            const portChoice = await inlineSelect("Select new port for alias", portOptions, true);
            if (portChoice === null) {
              restoreRawMode();
              return "";
            }

            let port: number;
            if (portChoice.value === "custom") {
              try {
                process.stdin.setRawMode(false);
              } catch {
                /* ignore */
              }
              const portStr = await promptLine("Enter new port number: ");
              restoreRawMode();
              port = Number(portStr);
              if (!port || port < 1 || port > 65535) {
                return "Invalid port number.";
              }
            } else if (typeof portChoice.value === "string" && portChoice.value.startsWith("current-")) {
              restoreRawMode();
              return "Alias is already assigned to this port.";
            } else {
              port = portChoice.value as number;
            }

            restoreRawMode();

            const updateResult = await apiRequest("PUT", `/v1/tunnels/aliases/${aliasChoice.value}`, { port });

            return ["✓ Alias reassigned", "", `→ Alias     ${updateResult.alias}`, `→ Port      ${updateResult.targetPort}`, `→ URL       ${updateResult.url}`].join(
              "\n"
            );
          } catch (err: any) {
            restoreRawMode();
            const msg = err?.message || String(err);
            if (msg.includes("PORT_HAS_ALIAS")) {
              return "❌ That port already has an alias assigned.";
            }
            throw err;
          }
        },
      },
      {
        label: "Delete Alias",
        action: async () => {
          try {
            const result = await apiRequest("GET", "/v1/tunnels/aliases");
            const aliases = result.aliases || [];

            if (aliases.length === 0) {
              restoreRawMode();
              return "No aliases to delete.";
            }

            const options: SelectOption[] = aliases.map((a: any) => ({
              label: `${a.alias} → port ${a.targetPort || a.target_port}`,
              value: a.alias,
            }));

            const choice = await inlineSelect("Select alias to delete", options, true);
            if (choice === null) {
              restoreRawMode();
              return "";
            }

            await apiRequest("DELETE", `/v1/tunnels/aliases/${choice.value}`);

            return `✓ Alias "${choice.value}" deleted.`;
          } catch (err: any) {
            restoreRawMode();
            throw err;
          }
        },
      },
    ],
  };
}

