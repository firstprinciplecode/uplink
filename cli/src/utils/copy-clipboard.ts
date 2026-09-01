import { spawn } from "child_process";

/** Copy text to the system clipboard (best-effort). Returns true if a helper was spawned. */
export function copyToClipboard(text: string): boolean {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["pbcopy", []]
      : process.platform === "win32"
        ? ["clip", []]
        : ["xclip", ["-selection", "clipboard"]];
  try {
    const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(text);
    return true;
  } catch {
    return false;
  }
}
