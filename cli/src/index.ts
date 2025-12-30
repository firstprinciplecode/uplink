#!/usr/bin/env node
import { Command } from "commander";
import { dbCommand } from "./subcommands/db";
import { devCommand } from "./subcommands/dev";
import { adminCommand } from "./subcommands/admin";
import { menuCommand } from "./subcommands/menu";
import { tunnelCommand } from "./subcommands/tunnel";
import { signupCommand } from "./subcommands/signup";

const program = new Command();

program
  .name("uplink")
  .description("Agent-friendly cloud CLI")
  .version("0.1.0")
  .option("--api-base <url>", "Override API base URL (default env AGENTCLOUD_API_BASE)")
  .option("--token-stdin", "Read AGENTCLOUD_TOKEN from stdin once");

program.addCommand(dbCommand);
program.addCommand(devCommand);
program.addCommand(adminCommand);
program.addCommand(tunnelCommand);
program.addCommand(signupCommand);
program.addCommand(menuCommand);

// Global pre-action hook to apply shared options
let cachedTokenStdin: string | null = null;
program.hook("preAction", async (thisCommand) => {
  // Collect global options
  const opts =
    typeof thisCommand.optsWithGlobals === "function"
      ? thisCommand.optsWithGlobals()
      : thisCommand.opts();

  if (opts.apiBase) {
    process.env.AGENTCLOUD_API_BASE = String(opts.apiBase);
  }

  if (opts.tokenStdin) {
    if (!cachedTokenStdin) {
      cachedTokenStdin = await new Promise<string>((resolve, reject) => {
        let data = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => (data += chunk));
        process.stdin.on("end", () => resolve(data.trim()));
        process.stdin.on("error", (err) => reject(err));
      });
    }
    if (cachedTokenStdin) {
      process.env.AGENTCLOUD_TOKEN = cachedTokenStdin;
    }
  }
});

// If no command provided and not a flag, default to menu
if (process.argv.length === 2) {
  process.argv.push("menu");
} else if (process.argv.length === 3 && process.argv[2] === "--help") {
  // Show main help, not menu
  process.argv.pop();
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});

