import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

export function cliPackageRoot(): string {
  return join(__dirname, "../../..");
}

export function resolveTsx(): string {
  const root = cliPackageRoot();
  try {
    // Prefer the package exports entry (works across tsx 4.21–4.23+)
    return require.resolve("tsx/cli", { paths: [root] });
  } catch {
    try {
      return require.resolve("tsx/dist/cli.cjs", { paths: [root] });
    } catch {
      return "tsx";
    }
  }
}

function spawnEsmEntry(entry: string): { status: number | null; error?: Error } {
  const root = cliPackageRoot();
  // Do not pass the package root tsconfig (module: commonjs). That forces
  // esbuild into CJS output and breaks Ink/yoga-layout (top-level await).
  const result = spawnSync(resolveTsx(), [entry], {
    stdio: "inherit",
    cwd: root,
    env: process.env,
  });
  if (result.error) return { status: result.status ?? 1, error: result.error };
  return { status: result.status };
}

/**
 * Ink 6 is ESM-only (yoga-layout uses top-level await). The CLI package is
 * CommonJS, so Ink screens must run as a child ESM process rather than being
 * imported from commander commands.
 */
export function runEsmEntry(entry: string): never {
  const result = spawnEsmEntry(entry);
  if (result.error) throw result.error;
  process.exit(result.status ?? 0);
}

/**
 * Same as runEsmEntry, but returns to the caller (for nesting inside the menu).
 */
export function runEsmEntryAndWait(entry: string): void {
  const result = spawnEsmEntry(entry);
  if (result.error) throw result.error;
  if (result.status && result.status !== 0) {
    throw new Error(`Interactive screen exited with code ${result.status}`);
  }
}
