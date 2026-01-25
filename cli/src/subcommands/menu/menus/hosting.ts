import { spawnSync } from "child_process";
import { resolve } from "path";
import { isBackInput } from "../io";
import type { MenuChoice } from "../types";

type Deps = {
  promptLine: (question: string) => Promise<string>;
  restoreRawMode: () => void;
};

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

function runCli(args: string[]): void {
  try {
    process.stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
  const cliBin = process.env.UPLINK_BIN;
  const cmd = cliBin ? [cliBin, ...args] : [process.argv[1], ...args];
  const result = spawnSync(process.execPath, cmd, {
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status && result.status !== 0) {
    throw new Error(`Command failed: uplink ${args.join(" ")}`);
  }
}

function runCliCapture(args: string[]): string {
  try {
    process.stdin.setRawMode(false);
  } catch {
    /* ignore */
  }
  const cliBin = process.env.UPLINK_BIN;
  const cmd = cliBin ? [cliBin, ...args] : [process.argv[1], ...args];
  const result = spawnSync(process.execPath, cmd, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
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

export function buildHostingMenu(deps: Deps): MenuChoice {
  const { restoreRawMode, promptLine } = deps;

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
        label: "List Hosted Apps",
        action: async () => {
          const output = runCliCapture(["host", "list"]);
          restoreRawMode();
          return output || "No apps found.";
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
          const lines = output.split("\n");
          const apps = lines
            .map((line) => {
              const match = line.match(/^- (.+) \((app_[^)]+)\)$/);
              if (!match) return null;
              return { name: match[1], id: match[2] };
            })
            .filter((entry): entry is { name: string; id: string } => Boolean(entry));
          if (apps.length === 0) {
            restoreRawMode();
            return "No apps found.";
          }
          const menuLines = apps.map((app, idx) => `${idx + 1}) ${app.name} (${app.id})`);
          const choice = (await promptLine(`Select app to delete (or "back"):\n${menuLines.join("\n")}\n> `))
            .trim()
            .toLowerCase();
          if (isBackInput(choice)) {
            restoreRawMode();
            return "";
          }
          if (!choice) {
            restoreRawMode();
            return "No selection made.";
          }
          const index = Number(choice);
          const selected = Number.isFinite(index) ? apps[index - 1] : apps.find((app) => app.id === choice);
          if (!selected) {
            restoreRawMode();
            return "Invalid selection.";
          }
          runCli(["host", "delete", "--id", selected.id]);
          restoreRawMode();
          return `Deleted ${selected.name} (${selected.id})`;
        },
      },
      {
        label: "Help",
        action: async () => {
          return [
            "Hosting commands:",
            "  uplink host analyze --path <path>",
            "  uplink host init --path <path> [--yes]",
            "  uplink host setup --name <app> --path <path> [--yes] [--env-file <path>]",
            "  uplink host list",
            "  uplink host delete --id <app_id>",
            "  uplink host create --name <app>",
            "  uplink host deploy --name <app> --path <path> --wait [--env-file <path>]",
            "",
            "Tip: Setup runs analyze → init → create → deploy.",
          ].join("\n");
        },
      },
    ],
  };
}
