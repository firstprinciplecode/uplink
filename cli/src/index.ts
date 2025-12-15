#!/usr/bin/env node
import { Command } from "commander";
import { dbCommand } from "./subcommands/db";
import { devCommand } from "./subcommands/dev";
import { adminCommand } from "./subcommands/admin";
import { menuCommand } from "./subcommands/menu";

const program = new Command();

program
  .name("agentcloud")
  .description("Agent-friendly cloud CLI")
  .version("0.1.0");

program.addCommand(dbCommand);
program.addCommand(devCommand);
program.addCommand(adminCommand);
program.addCommand(menuCommand);

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

