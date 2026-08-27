import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

function projectRoot(): string {
  return join(__dirname, "../..");
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

/** Domainking stays its own package; we spawn it, we do not import it. */
export function resolveDomainkingEntry(): string | null {
  if (process.env.DOMAINKING_ENTRY && existsSync(process.env.DOMAINKING_ENTRY)) {
    return process.env.DOMAINKING_ENTRY;
  }
  const candidates = [
    join(homedir(), "domainking", "src", "index.tsx"),
    join(projectRoot(), "..", "domainking", "src", "index.tsx"),
    join(projectRoot(), "..", "..", "domainking", "src", "index.tsx"),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

export function launchDomainking(): string {
  const entry = resolveDomainkingEntry();
  if (!entry) {
    return [
      "Domain search TUI is not bundled with uplink-cli.",
      "",
      "Agent-friendly commands (no TUI needed):",
      "  uplink domains list --json",
      "  uplink domains check example.com --json",
      "  uplink host domains add --id app_xxx --hostname example.com --json",
      "  uplink host domains verify --id app_xxx --hostname example.com --json",
      "",
      "Optional: set DOMAINKING_ENTRY to a Domainking src/index.tsx for the search UI.",
    ].join("\n");
  }

  const result = spawnSync(resolveTsx(), [entry], {
    stdio: "inherit",
    cwd: join(entry, "..", ".."),
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status && result.status !== 0) {
    return "Domain search exited.";
  }
  return "Back from domain search. Attach a hostname with Domains › Attach to app.";
}
