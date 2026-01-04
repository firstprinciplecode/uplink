import type { MenuChoice } from "../types";

type Deps = {
  apiBase: string;
  apiRequest: (method: string, path: string, body?: unknown) => Promise<any>;
  fetch: (url: string) => Promise<{ ok: boolean; statusText: string; json: () => Promise<any> }>;
  truncate: (text: string, max: number) => string;
  formatBytes: (bytes: number) => string;
  runSmoke: (script: "smoke:tunnel" | "smoke:db" | "smoke:all" | "test:comprehensive") => Promise<void>;
};

export function buildSystemStatusMenu(deps: Deps): MenuChoice {
  const { apiBase, apiRequest, fetch, truncate, formatBytes, runSmoke } = deps;

  return {
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
        label: "View Connected Tunnels",
        action: async () => {
          try {
            const data = (await apiRequest("GET", "/v1/admin/relay-status")) as {
              connectedTunnels?: number;
              tunnels?: Array<{
                token: string;
                clientIp: string;
                targetPort: number;
                connectedAt: string;
                connectedFor: string;
              }>;
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

            const lines = data.tunnels.map(
              (t) =>
                `${truncate(t.token, 12).padEnd(14)} ${t.clientIp.padEnd(16)} ${String(t.targetPort).padEnd(
                  6
                )} ${t.connectedFor.padEnd(10)} ${truncate(t.connectedAt, 19)}`
            );

            return [
              `Connected Tunnels: ${data.connectedTunnels}`,
              "",
              "Token          Client IP        Port   Uptime     Connected At",
              "-".repeat(75),
              ...lines,
            ].join("\n");
          } catch (err: any) {
            return `Error fetching relay status: ${err.message || err}`;
          }
        },
      },
      {
        label: "View Traffic Stats",
        action: async () => {
          try {
            const data = (await apiRequest("GET", "/v1/admin/traffic-stats")) as {
              stats?: Array<{
                alias: string;
                requests: number;
                bytesIn: number;
                bytesOut: number;
                lastStatus: number;
                lastSeen: string;
              }>;
              error?: string;
              message?: string;
            };

            if (data.error) {
              return `Error: ${data.error}${data.message ? ` - ${data.message}` : ""}`;
            }
            if (!data.stats || data.stats.length === 0) {
              return "No traffic stats available.";
            }

            const lines = data.stats.map(
              (s) =>
                `${truncate(s.alias || "-", 24).padEnd(26)} ${String(s.requests).padEnd(10)} ${formatBytes(
                  s.bytesIn
                ).padEnd(10)} ${formatBytes(s.bytesOut).padEnd(10)} ${String(s.lastStatus).padEnd(4)} ${truncate(
                  s.lastSeen,
                  19
                )}`
            );

            return [
              "Alias                      Requests   In         Out        Sts  Last Seen",
              "-".repeat(85),
              ...lines,
            ].join("\n");
          } catch (err: any) {
            return `Error fetching traffic stats: ${err.message || err}`;
          }
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
  };
}

