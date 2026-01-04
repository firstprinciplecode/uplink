import { spawn } from "child_process";

export type SmokeScript = "smoke:tunnel" | "smoke:db" | "smoke:all" | "test:comprehensive";

export function runSmoke(script: SmokeScript) {
  return new Promise<void>((resolve, reject) => {
    const env = {
      ...process.env,
      AGENTCLOUD_API_BASE: process.env.AGENTCLOUD_API_BASE ?? "https://api.uplink.spot",
      AGENTCLOUD_TOKEN: process.env.AGENTCLOUD_TOKEN ?? "dev-token",
    };
    const child = spawn("npm", ["run", script], { stdio: "inherit", env });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${script} failed with exit code ${code}`));
    });
    child.on("error", (err) => reject(err));
  });
}

