import { Command } from "commander";
import { apiRequest } from "../http";
import { handleError, printJson } from "../utils/machine";
import {
  findTunnelClients,
  killTunnelClient,
  startTunnelClient,
} from "./menu/effects/tunnel-clients";
import { ensureGuestAccess } from "../utils/guest-access";

type TunnelResponse = {
  id: string;
  url?: string;
  host?: string;
  port?: number;
  token?: string;
  alias?: string | null;
  aliasUrl?: string | null;
  status?: string;
  connected?: boolean;
  createdAt?: string;
  updatedAt?: string;
  ingressHttpUrl?: string;
  targetPort?: number;
};

type TunnelListResponse = {
  tunnels: TunnelResponse[];
  count: number;
};

type TunnelStatsResponse = any;

export const tunnelCommand = new Command("tunnel").description(
  "Manage tunnels non-interactively (agent-friendly)"
);

// Create tunnel + start local client (unless --no-client)
tunnelCommand
  .command("create")
  .description("Create a tunnel and start the local client")
  .requiredOption("--port <port>", "Local port to expose")
  .option("--alias <alias>", "Optional permanent alias (if enabled on account)")
  .option("--project <project>", "Optional project id")
  .option("--api-only", "Create API record only; do not start the local client", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const port = Number(opts.port);
    if (!Number.isFinite(port) || port <= 0) {
      console.error("Invalid port. Provide a positive integer.");
      process.exit(2);
    }

    try {
      await ensureGuestAccess();
      const existing = findTunnelClients().filter((c) => c.port === port);
      if (existing.length > 0 && !opts.apiOnly) {
        const err = `Tunnel client already running on port ${port} (pid ${existing[0].pid})`;
        if (opts.json) {
          printJson({ error: err, existing: existing[0] });
        } else {
          console.error(err);
        }
        process.exit(2);
      }

      const body: Record<string, unknown> = { port };
      if (opts.project) body.project = opts.project;

      const tunnel = (await apiRequest("POST", "/v1/tunnels", body)) as TunnelResponse;
      let aliasResult: TunnelResponse | null = null;
      let aliasError: string | null = null;

      if (opts.alias) {
        try {
          aliasResult = (await apiRequest("POST", `/v1/tunnels/${tunnel.id}/alias`, {
            alias: opts.alias,
          })) as TunnelResponse;
        } catch (err: any) {
          aliasError = err?.message || String(err);
        }
      }

      let client: { pid: number; started: boolean } | null = null;
      if (!opts.apiOnly) {
        const token = tunnel.token;
        if (!token) {
          throw new Error("Tunnel created but API returned no token; cannot start client");
        }
        const started = startTunnelClient({ token, port });
        // Brief wait so list/connected is more likely accurate for agents.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        client = { pid: started.pid, started: true };
      }

      const url =
        aliasResult?.aliasUrl ||
        aliasResult?.url ||
        tunnel.url ||
        tunnel.ingressHttpUrl ||
        null;
      const alias = aliasResult?.alias ?? tunnel.alias ?? null;

      if (opts.json) {
        printJson({
          tunnel: {
            ...tunnel,
            alias,
            aliasUrl: aliasResult?.aliasUrl ?? tunnel.aliasUrl ?? null,
            url: tunnel.url ?? tunnel.ingressHttpUrl,
          },
          alias,
          aliasError,
          url,
          client,
        });
      } else {
        console.log(`Created tunnel ${tunnel.id}`);
        console.log(`  url:    ${url ?? "-"}`);
        console.log(`  token:  ${tunnel.token ?? "-"}`);
        if (alias) console.log(`  alias:  ${alias}`);
        else if (aliasError) console.log(`  alias:  failed - ${aliasError}`);
        if (client) console.log(`  client: started (pid ${client.pid})`);
        else console.log(`  client: not started (--api-only)`);
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

// List tunnels
tunnelCommand
  .command("list")
  .description("List your tunnels")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const result = (await apiRequest("GET", "/v1/tunnels")) as TunnelListResponse;
      if (opts.json) {
        printJson(result);
      } else {
        if (!result.tunnels || result.tunnels.length === 0) {
          console.log("No tunnels found.");
          return;
        }
        console.log(`Tunnels (${result.count}):`);
        for (const t of result.tunnels) {
          const connected = t.connected ? "connected" : "idle";
          const token = t.token ? `${String(t.token).slice(0, 8)}…` : "-";
          console.log(
            `${t.id}  ${t.url ?? t.ingressHttpUrl ?? "-"}  token=${token}  alias=${t.alias ?? "-"}  status=${t.status ?? "-"}  ${connected}`
          );
        }
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

// Set alias
tunnelCommand
  .command("alias-set")
  .description("Set or update an alias for a tunnel")
  .requiredOption("--id <id>", "Tunnel id")
  .requiredOption("--alias <alias>", "Alias to set")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const result = (await apiRequest("POST", `/v1/tunnels/${opts.id}/alias`, {
        alias: opts.alias,
      })) as TunnelResponse;
      if (opts.json) {
        printJson(result);
      } else {
        console.log(`Alias set: ${result.alias ?? opts.alias} -> ${result.url ?? "-"}`);
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

// Delete alias
tunnelCommand
  .command("alias-delete")
  .description("Remove alias from a tunnel")
  .requiredOption("--id <id>", "Tunnel id")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const result = (await apiRequest(
        "DELETE",
        `/v1/tunnels/${opts.id}/alias`
      )) as TunnelResponse;
      if (opts.json) {
        printJson(result);
      } else {
        console.log(`Alias removed for tunnel ${result.id}`);
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

// Stats
tunnelCommand
  .command("stats")
  .description("Get tunnel stats (in-memory or alias totals)")
  .requiredOption("--id <id>", "Tunnel id")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const result = (await apiRequest(
        "GET",
        `/v1/tunnels/${opts.id}/stats`
      )) as TunnelStatsResponse;
      if (opts.json) {
        printJson(result);
      } else {
        console.log(`Stats for tunnel ${opts.id}`);
        console.log(JSON.stringify(result, null, 2));
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

// Stop (delete) tunnel and kill any matching local client
tunnelCommand
  .command("stop")
  .description("Stop a tunnel: kill the local client and delete the record")
  .option("--id <id>", "Tunnel id")
  .option("--all", "Stop every tunnel for this account", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    if (!opts.all && !opts.id) {
      console.error("Provide --id or --all");
      process.exit(2);
    }

    try {
      if (opts.all) {
        const listed = (await apiRequest("GET", "/v1/tunnels")) as TunnelListResponse;
        let killed = 0;
        for (const client of findTunnelClients()) {
          if (killTunnelClient(client.pid)) killed++;
        }
        let deleted = 0;
        for (const t of listed.tunnels || []) {
          if (!t.id) continue;
          try {
            await apiRequest("DELETE", `/v1/tunnels/${t.id}`);
            deleted++;
          } catch {
            /* already gone */
          }
        }
        if (opts.json) {
          printJson({ ok: true, killed, deleted });
        } else {
          console.log(`Stopped ${killed} local client(s), removed ${deleted} tunnel record(s)`);
        }
        return;
      }

      const listed = (await apiRequest("GET", "/v1/tunnels")) as TunnelListResponse;
      const target = (listed.tunnels || []).find((t) => t.id === opts.id);
      if (target?.token) {
        for (const client of findTunnelClients().filter((c) => c.token === target.token)) {
          killTunnelClient(client.pid);
        }
      }

      const result = (await apiRequest("DELETE", `/v1/tunnels/${opts.id}`)) as {
        id: string;
        status: string;
      };
      if (opts.json) {
        printJson(result);
      } else {
        console.log(`Stopped tunnel ${result.id} (status=${result.status})`);
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });
