import { Command } from "commander";
import { spawn } from "child_process";
import { apiRequest } from "../http";
import { handleError, printJson } from "../utils/machine";
import { resolveTunnelClientPath } from "./menu/effects/tunnel-clients";

export const devCommand = new Command("dev")
  .description("Run local tunnel client against a new tunnel (foreground)")
  .option("--tunnel", "Enable tunnel", false)
  .option("--port <port>", "Local port to expose", "3000")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const port = Number(opts.port);
    if (!Number.isFinite(port) || port <= 0) {
      console.error("Invalid port. Provide a positive integer.");
      process.exit(2);
    }

    if (!opts.tunnel) {
      console.log("Tunnel not enabled. Provide --tunnel to expose localhost.");
      console.log("Prefer: uplink tunnel create --port <port> --json");
      return;
    }

    try {
      const result = await apiRequest("POST", "/v1/tunnels", { port });
      if (opts.json) {
        printJson(result);
      } else {
        console.log(`Tunnel URL: ${result.url}`);
        if (
          typeof result.url === "string" &&
          result.url.startsWith("https://") &&
          result.url.includes(".dev.uplink.spot")
        ) {
          console.log(`HTTP URL (if HTTPS not enabled): ${result.url.replace(/^https:\/\//, "http://")}`);
        }
      }

      const clientPath = resolveTunnelClientPath();
      const ctrlHost = process.env.TUNNEL_CTRL ?? "tunnel.uplink.spot:7443";
      // Token goes through the environment, never argv (see tunnel-clients.ts).
      const args = [clientPath, "--port", String(port), "--ctrl", ctrlHost];
      if (!opts.json) {
        console.log(`Starting tunnel client on port ${port} via ${ctrlHost}`);
      }
      const child = spawn("node", args, {
        stdio: "inherit",
        env: { ...process.env, TUNNEL_TOKEN: result.token },
      });

      const shutdown = () => {
        try {
          child.kill("SIGINT");
        } catch {
          /* ignore */
        }
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      await new Promise<void>((resolve) => {
        child.on("exit", (code, signal) => {
          process.off("SIGINT", shutdown);
          process.off("SIGTERM", shutdown);

          if (signal) {
            console.error(`Tunnel client exited due to signal ${signal}`);
            process.exitCode = 1;
          } else if (code && code !== 0) {
            console.error(`Tunnel client exited with code ${code}`);
            process.exitCode = code;
          }
          resolve();
        });
      });
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });
