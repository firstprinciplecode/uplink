/**
 * Machine-mode helpers for CLI commands.
 * Ensures JSON-only stdout in --json mode and consistent exit codes.
 */

export type MachineOptions = { json?: boolean };

export function printJson(data: unknown) {
  process.stdout.write(JSON.stringify(data, null, 2));
  process.stdout.write("\n");
}

export function selectExitCode(message: string): number {
  const msg = message.toLowerCase();
  if (
    msg.includes("missing agentcloud_token") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("401") ||
    msg.includes("403")
  ) {
    return 10; // auth missing/invalid
  }
  if (
    msg.includes("econnrefused") ||
    msg.includes("enotfound") ||
    msg.includes("etimedout") ||
    msg.includes("econnreset") ||
    msg.includes("socket hang up") ||
    msg.includes("network")
  ) {
    return 20; // network
  }
  return 30; // server/unknown
}

export function handleError(error: unknown, opts: MachineOptions = {}) {
  const message = error instanceof Error ? error.message : String(error);
  if (opts.json) {
    printJson({ error: message });
  } else {
    console.error(message);
  }
  process.exit(selectExitCode(message));
}
