import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

export function cliPackageRoot(): string {
  return join(__dirname, "../../..");
}

export function resolveTsx(): string {
  const root = cliPackageRoot();
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
 * CommonJS, so Ink screens must run as a child ESM process rather than being
 * imported from commander commands.
 */
export function runEsmEntry(entry: string): never {
  const root = cliPackageRoot();
  const tsconfigPath = join(root, "tsconfig.json");
  const tsxArgs = existsSync(tsconfigPath) ? ["--tsconfig", tsconfigPath, entry] : [entry];
  const result = spawnSync(resolveTsx(), tsxArgs, {
    stdio: "inherit",
    cwd: root,
    env: process.env,
  });
  if (result.error) throw result.error;
  process.exit(result.status ?? 0);
}
