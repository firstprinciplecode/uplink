import { existsSync, readFileSync } from "fs";
import path from "path";

function isUplinkRoot(dir: string): boolean {
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    return pkg?.name === "uplink-cli";
  } catch {
    return false;
  }
}

export function resolveProjectRoot(startDir: string): string {
  let current = path.resolve(startDir);
  for (let i = 0; i < 8; i++) {
    if (isUplinkRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  // Fallback: assume repo root is 5 levels up from menu helpers.
  return path.resolve(startDir, "../../../../..");
}
