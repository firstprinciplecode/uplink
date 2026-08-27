import { Command } from "commander";
import { spawnSync } from "child_process";
import { join } from "path";

function projectRoot(): string {
  return join(__dirname, "../../..");
}

function resolveTsx(): string {
  const root = projectRoot();
  try {
    return require.resolve("tsx/dist/cli.cjs", { paths: [root] });
  } catch {
    try {
      return require.resolve("tsx/cli", { paths: [root] });
    } catch {
      return "tsx";
    }
  }
}

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
    const entry = join(__dirname, "../tui/index.mts");
    const result = spawnSync(resolveTsx(), [entry], {
      stdio: "inherit",
      cwd: projectRoot(),
      env: process.env,
    });
    if (result.error) throw result.error;
    process.exit(result.status ?? 0);
  });
