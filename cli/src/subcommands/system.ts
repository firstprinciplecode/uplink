import { Command } from "commander";
import { apiRequest } from "../http";

type SystemStatus = {
  hasInternalSecret: boolean;
  relayReachable: boolean;
  relayConnectedCount: number;
  tlsMode: string;
  wildcardDomains: string[];
  askEndpoint: { path: string; protected: boolean; note?: string };
};

function formatBoolean(value: boolean) {
  return value ? "yes" : "no";
}

async function fetchStatus(): Promise<SystemStatus> {
  return (await apiRequest("GET", "/v1/admin/system/status")) as SystemStatus;
}

export const systemCommand = new Command("system")
  .description("System diagnostics (admin)")
  .addCommand(
    new Command("status")
      .description("Show system status for relay/TLS wiring")
      .option("--json", "Output raw JSON")
      .action(async (opts) => {
        const status = await fetchStatus();
        if (opts.json) {
          console.log(JSON.stringify(status, null, 2));
          return;
        }

        console.log([
          "System Status",
          "-------------",
          `Internal secret configured: ${formatBoolean(status.hasInternalSecret)}`,
          `Relay reachable:            ${formatBoolean(status.relayReachable)}`,
          `Relay connected tunnels:    ${status.relayConnectedCount}`,
          `TLS mode:                   ${status.tlsMode}`,
          `Wildcard domains:           ${status.wildcardDomains.join(", ")}`,
          `Ask endpoint:               ${status.askEndpoint.path} (${status.askEndpoint.protected ? "protected" : "unprotected"})`,
          status.askEndpoint.note ? `Note: ${status.askEndpoint.note}` : "",
        ].filter(Boolean).join("\n"));
      })
  )
  .addCommand(
    new Command("explain")
      .description("Explain missing/unsafe settings")
      .action(async () => {
        const status = await fetchStatus();
        const issues: string[] = [];

        if (!status.hasInternalSecret) {
          issues.push("- RELAY_INTERNAL_SECRET is missing. Set it for backend + relay to protect internal endpoints.");
        }
        if (!status.relayReachable) {
          issues.push("- Relay unreachable via /internal/connected-tokens. Check relay service and secret header.");
        }
        if (status.askEndpoint && !status.askEndpoint.protected) {
          issues.push("- Ask endpoint is not protected; ensure RELAY_INTERNAL_SECRET is set.");
        }

        console.log("System Explain");
        console.log("--------------");
        if (issues.length === 0) {
          console.log("No critical issues detected. TLS mode:", status.tlsMode);
          return;
        }
        console.log("Issues:");
        issues.forEach((i) => console.log(i));
      })
  );

