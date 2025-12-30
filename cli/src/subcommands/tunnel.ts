import { Command } from "commander";
import { apiRequest } from "../http";
import { handleError, printJson } from "../utils/machine";

type TunnelResponse = {
  id: string;
  url?: string;
  host?: string;
  port?: number;
  token?: string;
  alias?: string | null;
  status?: string;
  createdAt?: string;
  updatedAt?: string;
  ingressHttpUrl?: string;
};

type TunnelListResponse = {
  tunnels: TunnelResponse[];
  count: number;
};

type TunnelStatsResponse = any;

export const tunnelCommand = new Command("tunnel")
  .description("Manage tunnels non-interactively (agent-friendly)");

// Create tunnel
tunnelCommand
  .command("create")
  .description("Create a tunnel")
  .requiredOption("--port <port>", "Local port to expose")
  .option("--alias <alias>", "Optional permanent alias (if enabled on account)")
  .option("--project <project>", "Optional project id")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const port = Number(opts.port);
    if (!Number.isFinite(port) || port <= 0) {
      console.error("Invalid port. Provide a positive integer.");
      process.exit(2);
    }

    try {
      const body: Record<string, unknown> = { port };
      if (opts.project) body.project = opts.project;

      const tunnel = await apiRequest("POST", "/v1/tunnels", body) as TunnelResponse;
      let aliasResult: TunnelResponse | null = null;
      let aliasError: string | null = null;

      if (opts.alias) {
        try {
          aliasResult = await apiRequest("POST", `/v1/tunnels/${tunnel.id}/alias`, {
            alias: opts.alias,
          }) as TunnelResponse;
        } catch (err: any) {
          aliasError = err?.message || String(err);
        }
      }

      if (opts.json) {
        printJson({
          tunnel,
          alias: aliasResult?.alias ?? null,
          aliasError,
        });
      } else {
        console.log(`Created tunnel ${tunnel.id}`);
        console.log(`  url:   ${tunnel.url ?? tunnel.ingressHttpUrl ?? "-"}`);
        console.log(`  token: ${tunnel.token ?? "-"}`);
        if (opts.alias) {
          if (aliasResult?.alias) {
            console.log(`  alias: ${aliasResult.alias}`);
          } else if (aliasError) {
            console.log(`  alias: failed - ${aliasError}`);
          }
        } else if (tunnel.alias) {
          console.log(`  alias: ${tunnel.alias}`);
        }
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
      const result = await apiRequest("GET", "/v1/tunnels") as TunnelListResponse;
      if (opts.json) {
        printJson(result);
      } else {
        if (!result.tunnels || result.tunnels.length === 0) {
          console.log("No tunnels found.");
          return;
        }
        console.log(`Tunnels (${result.count}):`);
        for (const t of result.tunnels) {
          console.log(
            `${t.id}  ${t.url ?? t.ingressHttpUrl ?? "-"}  token=${t.token ?? "-"}  alias=${t.alias ?? "-"}  status=${t.status ?? "-"}`
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
      const result = await apiRequest("POST", `/v1/tunnels/${opts.id}/alias`, {
        alias: opts.alias,
      }) as TunnelResponse;
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
      const result = await apiRequest("DELETE", `/v1/tunnels/${opts.id}/alias`) as TunnelResponse;
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
      const result = await apiRequest("GET", `/v1/tunnels/${opts.id}/stats`) as TunnelStatsResponse;
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

// Stop (delete) tunnel
tunnelCommand
  .command("stop")
  .description("Stop (delete) a tunnel")
  .requiredOption("--id <id>", "Tunnel id")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const result = await apiRequest("DELETE", `/v1/tunnels/${opts.id}`) as { id: string; status: string };
      if (opts.json) {
        printJson(result);
      } else {
        console.log(`Stopped tunnel ${result.id} (status=${result.status})`);
      }
    } catch (error: any) {
      console.error(error?.message || String(error));
      process.exit(30);
    }
  });
