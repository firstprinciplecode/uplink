#!/usr/bin/env node
/**
 * Uplink CLI entry point
 * Defaults to menu if no command provided
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// Get paths
const binDir = __dirname;
const projectRoot = path.join(binDir, "../..");
const cliPath = path.join(projectRoot, "cli/src/index.ts");

// Get arguments
const args = process.argv.slice(2);

// If no command provided, default to menu
// Otherwise pass through - commander will handle help/version/unknown commands
if (args.length === 0) {
  args.push("menu");
}

// Find tsx - try local first, then global
let tsxPath;
try {
  tsxPath = require.resolve("tsx/cli");
} catch (e) {
  // Try global tsx
  tsxPath = "tsx";
}

// Run the CLI
const child = spawn("node", [tsxPath, cliPath, ...args], {
  stdio: "inherit",
  cwd: projectRoot,
  env: process.env,
});

child.on("error", (err) => {
  console.error("Error running uplink:", err.message);
  console.error("\nMake sure tsx is installed: npm install -g tsx");
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code || 0);
});

