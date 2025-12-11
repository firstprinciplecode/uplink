#!/usr/bin/env node
import { Command } from "commander";
import { dbCommand } from "./subcommands/db";
import { devCommand } from "./subcommands/dev";

const program = new Command();

program
  .name("agentcloud")
  .description("Agent-friendly cloud CLI")
  .version("0.1.0");

program.addCommand(dbCommand);
program.addCommand(devCommand);

program.parseAsync(process.argv).catch((err) => {
  console.error(err);
  process.exit(1);
});

