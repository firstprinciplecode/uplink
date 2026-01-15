import { Command } from "commander";
import { apiRequest } from "../http";
import { handleError, printJson } from "../utils/machine";
import { createHash } from "crypto";
import { createReadStream, readFileSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import os from "os";
import fetch from "node-fetch";
import { spawnSync } from "child_process";

type App = { id: string; name: string; url: string; createdAt?: string; updatedAt?: string };
type AppList = { apps: App[]; count: number };
type ReleaseCreateResponse = {
  release: { id: string; appId: string; sha256: string; sizeBytes: number };
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  completeUrl?: string;
};
type Deployment = { id: string; appId: string; releaseId: string; status: string };

function getApiBase(): string {
  return process.env.AGENTCLOUD_API_BASE ?? "https://api.uplink.spot";
}

function isLocalApiBase(apiBase: string): boolean {
  return (
    apiBase.includes("://localhost") ||
    apiBase.includes("://127.0.0.1") ||
    apiBase.includes("://0.0.0.0")
  );
}

function getApiToken(): string | undefined {
  const apiBase = getApiBase();
  if (!isLocalApiBase(apiBase)) return process.env.AGENTCLOUD_TOKEN || undefined;
  return process.env.AGENTCLOUD_TOKEN || process.env.AGENTCLOUD_TOKEN_DEV || undefined;
}

function sha256File(path: string): string {
  const buf = readFileSync(path);
  return createHash("sha256").update(buf).digest("hex");
}

function makeTarball(sourceDir: string): { tarPath: string; sizeBytes: number; sha256: string } {
  const tmp = join(os.tmpdir(), `uplink-host-${Date.now()}-${Math.random().toString(16).slice(2)}.tgz`);

  const result = spawnSync("tar", ["-czf", tmp, "--exclude=.git", "--exclude=node_modules", "-C", sourceDir, "."], {
    stdio: "pipe",
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Failed to create tarball: ${result.stderr || result.stdout || "unknown error"}`);
  }

  const st = statSync(tmp);
  const sha256 = sha256File(tmp);
  return { tarPath: tmp, sizeBytes: st.size, sha256 };
}

async function uploadArtifact(
  uploadUrl: string,
  tarPath: string,
  uploadHeaders?: Record<string, string>
): Promise<any> {
  const hasSignedHeaders = uploadHeaders && Object.keys(uploadHeaders).length > 0;
  const token = getApiToken();
  if (!hasSignedHeaders && !token) throw new Error("Missing AGENTCLOUD_TOKEN");

  const headers: Record<string, string> = { ...(uploadHeaders || {}) };
  if (!headers["Content-Type"]) headers["Content-Type"] = "application/octet-stream";
  if (!hasSignedHeaders && token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers,
    body: createReadStream(tarPath) as any,
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(JSON.stringify(json, null, 2));
  return json;
}

async function completeArtifactUpload(completeUrl?: string): Promise<void> {
  if (!completeUrl) return;
  const token = getApiToken();
  if (!token) throw new Error("Missing AGENTCLOUD_TOKEN");

  const res = await fetch(completeUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(JSON.stringify(json, null, 2));
  }
}

export const hostCommand = new Command("host").description("Host persistent web services (Dockerfile required)");

hostCommand
  .command("init")
  .description("Create a minimal uplink hosting config (Dockerfile required)")
  .option("--port <port>", "App port (defaults to 3000)", "3000")
  .option("--dockerfile <path>", "Dockerfile path (defaults to ./Dockerfile)", "Dockerfile")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const port = Number(opts.port);
      if (!Number.isFinite(port) || port <= 0) {
        console.error("Invalid port. Provide a positive integer.");
        process.exit(2);
      }
      const cfg = {
        version: 1,
        port,
        dockerfile: String(opts.dockerfile),
      };
      const outPath = resolve(process.cwd(), "uplink.host.json");
      writeFileSync(outPath, JSON.stringify(cfg, null, 2) + "\n", "utf8");
      if (opts.json) {
        printJson({ path: outPath, config: cfg });
      } else {
        console.log(`Wrote ${outPath}`);
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

hostCommand
  .command("create")
  .description("Create (or get) a hosted app")
  .requiredOption("--name <name>", "App name (owner-scoped unique)")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const app = (await apiRequest("POST", "/v1/apps", { name: opts.name })) as App;
      if (opts.json) printJson(app);
      else {
        console.log(`App ${app.id}`);
        console.log(`  url:  ${app.url}`);
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

hostCommand
  .command("deploy")
  .description("Deploy a Dockerfile-based app from a local folder")
  .requiredOption("--name <name>", "App name")
  .option("--path <path>", "Project folder (default: .)", ".")
  .option("--wait", "Wait for deployment (not yet implemented)", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const dir = resolve(process.cwd(), String(opts.path));
      const { tarPath, sha256, sizeBytes } = makeTarball(dir);

      const app = (await apiRequest("POST", "/v1/apps", { name: opts.name })) as App;
      const rel = (await apiRequest("POST", `/v1/apps/${app.id}/releases`, {
        sha256,
        sizeBytes,
      })) as ReleaseCreateResponse;

      await uploadArtifact(rel.uploadUrl, tarPath, rel.uploadHeaders);
      await completeArtifactUpload(rel.completeUrl);

      const dep = (await apiRequest("POST", `/v1/apps/${app.id}/deployments`, {
        releaseId: rel.release.id,
      })) as Deployment;

      const out = {
        app,
        release: rel.release,
        deployment: dep,
        url: app.url,
        note: "Deployment execution is handled by private runner; status/logs may remain queued until runner is deployed.",
      };

      if (opts.json) printJson(out);
      else {
        console.log(`Deployed ${app.name} (${app.id})`);
        console.log(`  url:        ${app.url}`);
        console.log(`  release:    ${rel.release.id}`);
        console.log(`  deployment: ${dep.id} (status=${dep.status})`);
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

hostCommand
  .command("status")
  .description("Show app status")
  .requiredOption("--id <id>", "App id (app_...)")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const status = await apiRequest("GET", `/v1/apps/${opts.id}/status`);
      if (opts.json) printJson(status);
      else console.log(JSON.stringify(status, null, 2));
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

hostCommand
  .command("logs")
  .description("Show app logs (v1 stub)")
  .requiredOption("--id <id>", "App id (app_...)")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const logs = await apiRequest("GET", `/v1/apps/${opts.id}/logs`);
      if (opts.json) printJson(logs);
      else {
        const lines = Array.isArray(logs?.lines) ? logs.lines : [];
        for (const line of lines) console.log(line);
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

