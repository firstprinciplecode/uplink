import { Command } from "commander";
import { spawn } from "child_process";
import { apiRequest } from "../http";
import path from "path";

export const devCommand = new Command("dev")
  .description("Run local dev with optional tunnel")
  .option("--tunnel", "Enable tunnel")
  .option("--port <port>", "Local port to expose", "3000")
  .option("--json", "Output JSON", false)
  .option("--improved", "Use improved client with auto-reconnect and better error handling", false)
  .action(async (opts) => {
    const port = Number(opts.port);
    if (opts.tunnel) {
      // Request tunnel from control plane
      const result = await apiRequest("POST", "/v1/tunnels", { port });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Tunnel URL: ${result.url}`);
        // If the control-plane returns an https URL for the dev.uplink.spot domain,
        // it may not actually be reachable unless TLS is configured on the relay.
        // Print an HTTP fallback to reduce confusion during development.
        if (
          typeof result.url === "string" &&
          result.url.startsWith("https://") &&
          result.url.includes(".dev.uplink.spot")
        ) {
          console.log(`HTTP URL (if HTTPS not enabled): ${result.url.replace(/^https:\/\//, "http://")}`);
        }
      }

      // Spawn tunnel client (use improved version if requested)
      const clientFile = opts.improved ? "client-improved.js" : "client.js";
      const clientPath = path.join(
        process.cwd(),
        "scripts",
        "tunnel",
        clientFile
      );
      const ctrlHost = process.env.TUNNEL_CTRL ?? "tunnel.uplink.spot:7071";
      const args = [
        clientPath,
        "--token",
        result.token,
        "--port",
        String(port),
        "--ctrl",
        ctrlHost,
      ];
      console.log(`Starting tunnel client: node ${args.join(" ")}`);
      const child = spawn("node", args, { stdio: "inherit" });

      // Forward Ctrl+C / termination to the child so the tunnel shuts down cleanly.
      const shutdown = () => {
        try {
          child.kill("SIGINT");
        } catch {
          /* ignore */
        }
      };
      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Keep the CLI process alive while the tunnel client is running.
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
    } else {
      console.log("Tunnel not enabled. Provide --tunnel to expose localhost.");
    }
  });


