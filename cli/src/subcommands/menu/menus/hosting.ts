import { spawnSync } from "child_process";
import { resolve } from "path";
import type { MenuChoice } from "../types";

type Deps = {
  promptLine: (question: string) => Promise<string>;
  restoreRawMode: () => void;
};

async function resolvePath(promptLine: Deps["promptLine"]): Promise<string> {
  const cwd = process.env.UPLINK_CWD || process.cwd();
  while (true) {
    const answer = (await promptLine(`Project path (default ${cwd}): `)).trim();
    const projectPath = resolve(cwd, answer || cwd);
    const confirm = (await promptLine(`Use "${projectPath}"? (Y/n): `)).trim().toLowerCase();
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
          runCli(["host", "setup", "--path", projectPath]);
          restoreRawMode();
          return "Setup complete.";
        },
      },
      {
        label: "Analyze Project",
        action: async () => {
          const projectPath = await resolvePath(promptLine);
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
