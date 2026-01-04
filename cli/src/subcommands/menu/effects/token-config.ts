import { homedir } from "os";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync } from "fs";

export type DetectedShell = { shellName: "zsh" | "bash" | ""; configFile: string | null };

export function detectShellConfigFile(): DetectedShell {
  const shell = process.env.SHELL || "";
  const homeDir = homedir();

  if (shell.includes("zsh")) return { shellName: "zsh", configFile: join(homeDir, ".zshrc") };
  if (shell.includes("bash")) return { shellName: "bash", configFile: join(homeDir, ".bashrc") };

  const zshrc = join(homeDir, ".zshrc");
  if (existsSync(zshrc)) return { shellName: "zsh", configFile: zshrc };

  const bashrc = join(homeDir, ".bashrc");
  if (existsSync(bashrc)) return { shellName: "bash", configFile: bashrc };

  return { shellName: "", configFile: null };
}

export function shellConfigHasToken(configFile: string): boolean {
  try {
    if (!existsSync(configFile)) return false;
    const configContent = readFileSync(configFile, "utf-8");
    return configContent.includes("AGENTCLOUD_TOKEN");
  } catch {
    return false;
  }
}

export function upsertShellToken(configFile: string, token: string): { wrote: boolean; verifyOk: boolean } {
  // NOTE: caller must ensure token is safe to write here (and accepts the risk).
  const configContent = existsSync(configFile) ? readFileSync(configFile, "utf-8") : "";
  const lines = configContent.split("\n");

  let replaced = false;
  const updatedLines = lines.map((line) => {
    if (line.match(/^\s*export\s+AGENTCLOUD_TOKEN=/)) {
      replaced = true;
      return `export AGENTCLOUD_TOKEN=${token}`;
    }
    return line;
  });

  if (!replaced) {
    updatedLines.push("");
    updatedLines.push("# Uplink API Token (added automatically)");
    updatedLines.push(`export AGENTCLOUD_TOKEN=${token}`);
  }

  writeFileSync(configFile, updatedLines.join("\n"), { flag: "w", mode: 0o644 });
  const verifyContent = readFileSync(configFile, "utf-8");
  return { wrote: true, verifyOk: verifyContent.includes(`export AGENTCLOUD_TOKEN=${token}`) };
}

