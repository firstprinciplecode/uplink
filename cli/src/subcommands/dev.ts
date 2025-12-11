import { Command } from "commander";
import { spawn } from "child_process";
import { apiRequest } from "../http";
import path from "path";

export const devCommand = new Command("dev")
  .description("Run local dev with optional tunnel")
  .option("--tunnel", "Enable tunnel")
  .option("--port <port>", "Local port to expose", "3000")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    const port = Number(opts.port);
    if (opts.tunnel) {
      // Request tunnel from control plane
      const result = await apiRequest("POST", "/v1/tunnels", { port });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(`Tunnel URL: ${result.url}`);
      }

      // Spawn tunnel client
      const clientPath = path.join(
        process.cwd(),
        "scripts",
        "tunnel",
        "client.js"
      );
      const ctrlHost = process.env.TUNNEL_CTRL ?? "127.0.0.1:7071";
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
      child.on("exit", (code) => {
        if (code !== 0) {
          console.error(`Tunnel client exited with code ${code}`);
        }
      });
    } else {
      console.log("Tunnel not enabled. Provide --tunnel to expose localhost.");
    }
  });

