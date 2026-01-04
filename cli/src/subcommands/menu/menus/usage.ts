import type { MenuChoice } from "../types";

type Deps = {
  apiRequest: (method: string, path: string, body?: unknown) => Promise<any>;
  truncate: (text: string, max: number) => string;
};

export function buildUsageMenu(deps: Deps): MenuChoice {
  const { apiRequest, truncate } = deps;

  return {
    label: "Usage",
    subMenu: [
      {
        label: "List All Tunnels",
        action: async () => {
          const result = await apiRequest("GET", "/v1/admin/tunnels?limit=20");
          const tunnels = result.tunnels || result?.items || [];
          if (!tunnels || tunnels.length === 0) {
            return "No tunnels found.";
          }

          const lines = tunnels.map((t: any) => {
            const token = t.token || "";
            const connectedFromApi = t.connected ?? false;
            const connectionStatus = connectedFromApi ? "connected" : "disconnected";

            return `${truncate(t.id, 12)}  ${truncate(token, 10).padEnd(12)}  ${String(
              t.target_port ?? t.targetPort ?? "-"
            ).padEnd(5)}  ${connectionStatus.padEnd(12)}  ${truncate(t.created_at ?? t.createdAt ?? "", 19)}`;
          });
          return ["ID           Token         Port   Connection   Created", "-".repeat(70), ...lines].join("\n");
        },
      },
      {
        label: "List All Databases",
        action: async () => {
          const result = await apiRequest("GET", "/v1/admin/databases?limit=20");
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
  };
}

