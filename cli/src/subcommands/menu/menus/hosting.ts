import { spawnSync } from "child_process";
import { resolve } from "path";
import { isBackInput } from "../io";
import type { SelectOption } from "../inline-tree-select";
import type { MenuChoice } from "../types";

type Deps = {
  promptLine: (question: string) => Promise<string>;
  restoreRawMode: () => void;
  inlineSelect: (
    title: string,
    options: SelectOption[],
    includeBack?: boolean
  ) => Promise<{ index: number; value: string | number | null } | null>;
};

export type HostedApp = { name: string; id: string; url?: string };

function appOptionLabel(app: HostedApp): string {
  return app.url ? `${app.name}  ${app.url}` : app.name;
}

export function parseHostedApps(output: string): HostedApp[] {
  const lines = output.split("\n");
  const apps: HostedApp[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    const match = line.match(/^- (.+) \((app_[^)]+)\)$/);
    if (!match) continue;
    const nextLine = lines[i + 1]?.trim();
    const url =
      nextLine && (nextLine.startsWith("http://") || nextLine.startsWith("https://"))
        ? nextLine
        : undefined;
    apps.push({ name: match[1], id: match[2], url });
  }
  return apps;
}

async function resolvePath(promptLine: Deps["promptLine"]): Promise<string | null> {
  const cwd = process.env.UPLINK_CWD || process.cwd();
  while (true) {
    const answerRaw = await promptLine(`Project path (default ${cwd}, or "back"): `);
    if (isBackInput(answerRaw)) return null;
    const answer = answerRaw.trim();
    const projectPath = resolve(cwd, answer || cwd);
    const confirmRaw = await promptLine(`Use "${projectPath}"? (Y/n, or "back"): `);
    if (isBackInput(confirmRaw)) return null;
    const confirm = confirmRaw.trim().toLowerCase();
    if (confirm === "" || confirm === "y" || confirm === "yes") return projectPath;
  }
}

export function runCli(args: string[], extraEnv?: Record<string, string>): void {
  try {
    process.stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
  const cliBin = process.env.UPLINK_BIN;
  const cmd = cliBin ? [cliBin, ...args] : [process.argv[1], ...args];
  const result = spawnSync(process.execPath, cmd, {
    stdio: "inherit",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (result.error) throw result.error;
  if (result.status && result.status !== 0) {
    throw new Error(`Command failed: uplink ${args.join(" ")}`);
  }
}

export function runCliCapture(args: string[], extraEnv?: Record<string, string>, preserveRawMode = false): string {
  if (!preserveRawMode) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
  }
  const cliBin = process.env.UPLINK_BIN;
  const cmd = cliBin ? [cliBin, ...args] : [process.argv[1], ...args];
  const result = spawnSync(process.execPath, cmd, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (result.error) throw result.error;
  if (result.status && result.status !== 0) {
    const detail = result.stderr?.trim() || "";
    throw new Error(
      `Command failed: uplink ${args.join(" ")}${detail ? `\n${detail}` : ""}`
    );
  }
  return result.stdout?.trim() || "";
}

/** Capture stdout even when the command exits non-zero (verify / quota errors). */
export function runCliResult(args: string[], extraEnv?: Record<string, string>, preserveRawMode = false): {
  status: number;
  stdout: string;
  stderr: string;
} {
  if (!preserveRawMode) {
    try {
      process.stdin.setRawMode(false);
    } catch {
      /* ignore */
    }
  }
  const cliBin = process.env.UPLINK_BIN;
  const cmd = cliBin ? [cliBin, ...args] : [process.argv[1], ...args];
  const result = spawnSync(process.execPath, cmd, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  if (result.error) throw result.error;
  return {
    status: result.status ?? 0,
    stdout: result.stdout?.trim() || "",
    stderr: result.stderr?.trim() || "",
  };
}

export function parseCliJson<T>(stdout: string): T | null {
  const start = stdout.indexOf("{");
  if (start < 0) return null;
  try {
    return JSON.parse(stdout.slice(start)) as T;
  } catch {
    return null;
  }
}

export function buildHostingMenu(deps: Deps): MenuChoice {
  const { restoreRawMode, promptLine, inlineSelect } = deps;

  return {
    label: "Hosting",
    subMenu: [
      {
        label: "Setup Wizard",
        action: async () => {
          const projectPath = await resolvePath(promptLine);
          if (!projectPath) {
            restoreRawMode();
            return "";
          }
          runCli(["host", "setup", "--path", projectPath]);
          restoreRawMode();
          return "Setup complete.";
        },
      },
      {
        label: "Deploy to Existing App",
        action: async () => {
          // First list apps to select from
          const output = runCliCapture(["host", "list"]);
          if (!output || output.includes("No apps found")) {
            restoreRawMode();
            return "No apps found. Use Setup Wizard to create one first.";
          }
          const apps = parseHostedApps(output);
          if (apps.length === 0) {
            restoreRawMode();
            return "No apps found. Use Setup Wizard to create one first.";
          }
          const options: SelectOption[] = apps.map((app) => ({
            label: appOptionLabel(app),
            value: app.id,
          }));
          const choice = await inlineSelect("Select app to deploy to", options, true);
          if (choice === null) {
            restoreRawMode();
            return "";
          }
          const selected = apps.find((app) => app.id === choice.value);
          if (!selected) {
            restoreRawMode();
            return "Invalid selection.";
          }

          // Now get the project path
          const projectPath = await resolvePath(promptLine);
          if (!projectPath) {
            restoreRawMode();
            return "";
          }

          // Deploy using the selected app name
          runCli(["host", "deploy", "--name", selected.name, "--path", projectPath, "--wait"]);
          restoreRawMode();
          return `Deployed to ${selected.name}`;
        },
      },
      {
        label: "Analyze Project",
        action: async () => {
          const projectPath = await resolvePath(promptLine);
          if (!projectPath) {
            restoreRawMode();
            return "";
          }
          runCli(["host", "analyze", "--path", projectPath]);
          restoreRawMode();
          return "Analysis complete.";
        },
      },
      {
        label: "Delete Hosted App",
        action: async () => {
          const output = runCliCapture(["host", "list"]);
          if (!output || output.includes("No apps found")) {
            restoreRawMode();
            return "No apps found.";
          }
          const apps = parseHostedApps(output);
          if (apps.length === 0) {
            restoreRawMode();
            return "No apps found.";
          }
          const options: SelectOption[] = apps.map((app) => ({
            label: appOptionLabel(app),
            value: app.id,
          }));
          const choice = await inlineSelect("Select app to delete", options, true);
          if (choice === null) {
            restoreRawMode();
            return "";
          }
          const selected = apps.find((app) => app.id === choice.value);
          if (!selected) {
            restoreRawMode();
            return "Invalid selection.";
          }
          
          // Ask about deleting volumes
          const deleteVolumesAnswer = (await promptLine(
            "Also delete persistent data (databases, files)? (y/N, or back): "
          )).trim().toLowerCase();
          if (isBackInput(deleteVolumesAnswer)) {
            restoreRawMode();
            return "";
          }
          const deleteVolumes = deleteVolumesAnswer === "y" || deleteVolumesAnswer === "yes";
          
          const args = ["host", "delete", "--id", selected.id];
          if (deleteVolumes) {
            args.push("--delete-volumes");
          }
          runCli(args);
          restoreRawMode();
          const volumeNote = deleteVolumes ? " (including persistent data)" : "";
          return `Deleted ${selected.name} (${selected.id})${volumeNote}`;
        },
      },
      {
        label: "Help",
        page: [
            "Menu options:",
            "  Setup     - First-time setup: creates Dockerfile, config, app, and deploys",
            "  Deploy    - Redeploy to an existing app (faster, skips setup)",
            "  Analyze   - Check project for deployment readiness",
            "  Apps      - Arrow through apps to inspect url, status, and size",
            "  Delete    - Remove an app and optionally its data",
            "  Domains   - attach hostnames under the top-level Domains menu",
            "",
            "CLI:",
            "  uplink host setup --name <app> --path <path> --json",
            "  uplink host deploy --name <app> --path <path> --json",
            "  uplink host status --id <app_id> --json",
            "  uplink host logs --id <app_id> --json",
          ].join("\n"),
      },
    ],
  };
}
