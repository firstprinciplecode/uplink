import { spawn } from "child_process";
import { getResolvedApiBase, getResolvedApiToken } from "../../../utils/api-base";

export type SmokeScript = "smoke:tunnel" | "smoke:db" | "smoke:all" | "test:comprehensive";

export function runSmoke(script: SmokeScript) {
  return new Promise<void>((resolve, reject) => {
    const apiBase = getResolvedApiBase();
    const token = getResolvedApiToken(apiBase);
    const env = {
      ...process.env,
      AGENTCLOUD_API_BASE: apiBase,
      AGENTCLOUD_TOKEN: token ?? "dev-token",
    };
    const child = spawn("npm", ["run", script], { stdio: "inherit", env });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} failed with exit code ${code}`));
    });
    child.on("error", (err) => reject(err));
  });
}

