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

// Find tsx - prefer project-local, otherwise fall back to PATH
let tsxPath = "tsx";
try {
  // Newer tsx exposes a CLI entry at dist/cli.cjs
  tsxPath = require.resolve("tsx/dist/cli.cjs", { paths: [projectRoot] });
} catch (e) {
  try {
    tsxPath = require.resolve("tsx/cli", { paths: [projectRoot] });
  } catch (_) {
    // keep fallback to PATH
  }
}

// Run the CLI via tsx (no extra node wrapper so PATH/global tsx works)
const child = spawn(tsxPath, [cliPath, ...args], {
  stdio: "inherit",
  cwd: projectRoot,
  env: process.env,
  shell: false,
});

child.on("error", (err) => {
  console.error("Error running uplink:", err.message);
  console.error("\nMake sure tsx is installed: npm install -g tsx");
  process.exit(1);
});

child.on("exit", (code) => {
  process.exit(code || 0);
});

