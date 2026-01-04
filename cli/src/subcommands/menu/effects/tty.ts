export function trySetRawMode(enabled: boolean) {
  try {
    process.stdin.setRawMode(enabled);
    if (enabled) process.stdin.resume();
  } catch {
    /* ignore */
  }
}

