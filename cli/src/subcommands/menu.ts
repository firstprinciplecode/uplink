import { Command } from "commander";
import { join } from "path";
import { runEsmEntry } from "../utils/run-esm";

/**
 * Ink 6 is ESM-only (yoga-layout uses top-level await). The CLI package is
 * CommonJS, so the menu runs as a child ESM process rather than importing Ink here.
 */
export const menuCommand = new Command("menu")
  .description("Interactive terminal menu (arrow keys + enter)")
  .action(() => {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      console.error("Uplink menu needs an interactive terminal. Use `uplink --help` for commands.");
      process.exit(1);
    }
    runEsmEntry(join(__dirname, "../tui/index.mts"));
  });
