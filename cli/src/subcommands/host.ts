import { Command } from "commander";
import { apiRequest } from "../http";
import { handleError, printJson } from "../utils/machine";
import { analyzeProject, AnalysisResult } from "../utils/analyze";
import { generateDockerfile, generateHostConfig } from "../templates";
import { createHash } from "crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "fs";
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
type AppStatus = {
  app: App;
  activeRelease: null | {
    id: string;
    appId: string;
    uploadStatus?: string;
    buildStatus?: string;
    createdAt?: string;
    updatedAt?: string;
  };
  activeDeployment: null | {
    id: string;
    appId: string;
    releaseId: string;
    status?: string;
    runnerTarget?: string | null;
    createdAt?: string;
    updatedAt?: string;
  };
};

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

function readHostConfig(dir: string): { volumes?: Record<string, string>; env?: Record<string, string> } | null {
  const hostConfigPath = join(dir, "uplink.host.json");
  if (!existsSync(hostConfigPath)) return null;
  try {
    const content = readFileSync(hostConfigPath, "utf8");
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") return null;
    return {
      volumes: parsed.volumes,
      env: parsed.env,
    };
  } catch (error: any) {
    throw new Error(`Invalid uplink.host.json: ${error?.message || "parse error"}`);
  }
}

async function updateAppConfig(
  appId: string,
  config: { volumes?: Record<string, string>; env?: Record<string, string> } | null
): Promise<void> {
  if (!config) return;
  const volumes = config.volumes && Object.keys(config.volumes).length > 0 ? config.volumes : undefined;
  const env = config.env && Object.keys(config.env).length > 0 ? config.env : undefined;
  if (!volumes && !env) return;
  await apiRequest("PUT", `/v1/apps/${appId}/config`, { volumes, env });
}

async function waitForDeployment(
  appId: string,
  releaseId: string,
  deploymentId: string,
  opts: { timeoutMs: number; intervalMs: number; json: boolean }
): Promise<AppStatus> {
  const start = Date.now();
  let lastSummary = "";
  while (Date.now() - start < opts.timeoutMs) {
    const status = (await apiRequest("GET", `/v1/apps/${appId}/status`)) as AppStatus;
    const buildStatus = status.activeRelease?.buildStatus || "unknown";
    const deployStatus = status.activeDeployment?.status || "unknown";
    const summary = `build=${buildStatus} deploy=${deployStatus}`;

    if (!opts.json && summary !== lastSummary) {
      console.log(`Status: ${summary}`);
      lastSummary = summary;
    }

    if (status.activeRelease?.id === releaseId && status.activeRelease?.buildStatus === "failed") {
      throw new Error("Build failed");
    }
    if (status.activeDeployment?.id === deploymentId && status.activeDeployment?.status === "running") {
      return status;
    }

    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error("Timed out waiting for deployment");
}

function makeTarball(sourceDir: string): { tarPath: string; sizeBytes: number; sha256: string } {
  const tmp = join(os.tmpdir(), `uplink-host-${Date.now()}-${Math.random().toString(16).slice(2)}.tgz`);
  const ignoreFiles = [".gitignore", ".uplinkignore"]
    .map((name) => join(sourceDir, name))
    .filter((path) => existsSync(path));
  const ignoreArgs = ignoreFiles.flatMap((path) => ["--exclude-from", path]);

  const result = spawnSync(
    "tar",
    ["-czf", tmp, "--exclude=.git", "--exclude=node_modules", ...ignoreArgs, "-C", sourceDir, "."],
    {
    stdio: "pipe",
    encoding: "utf8",
    }
  );
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
  if (!headers["Content-Length"]) {
    headers["Content-Length"] = String(statSync(tarPath).size);
  }
  if (!hasSignedHeaders && token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers,
    body: createReadStream(tarPath) as any,
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    const detail = bodyText?.trim() || "{}";
    throw new Error(`upload failed: ${res.status} ${res.statusText} ${detail}`);
  }

  return res.json().catch(() => ({}));
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
    const bodyText = await res.text().catch(() => "");
    const detail = bodyText?.trim() || "{}";
    throw new Error(`complete failed: ${res.status} ${res.statusText} ${detail}`);
  }
}

export const hostCommand = new Command("host").description("Host persistent web services (Dockerfile required)");

hostCommand
  .command("analyze")
  .description("Analyze a project and detect framework, database, and deployment requirements")
  .option("--path <path>", "Project folder (default: .)", ".")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const dir = resolve(process.cwd(), String(opts.path));
      const hostConfig = readHostConfig(dir);
      const analysis = analyzeProject(dir);

      if (opts.json) {
        printJson(analysis);
      } else {
        console.log("\nProject Analysis");
        console.log("================\n");

        // Framework
        if (analysis.framework) {
          const ver = analysis.framework.version ? ` (${analysis.framework.version})` : "";
          console.log(`Framework:       ${analysis.framework.name}${ver}`);
        } else {
          console.log("Framework:       (not detected)");
        }

        // Package manager
        if (analysis.packageManager) {
          console.log(`Package manager: ${analysis.packageManager}`);
        }

        // Database
        if (analysis.database) {
          const file = analysis.database.file ? ` (${analysis.database.file})` : "";
          console.log(`Database:        ${analysis.database.type}${file}`);
        } else {
          console.log("Database:        (none detected)");
        }

        // Port
        console.log(`Port:            ${analysis.port}`);

        // Dockerfile
        console.log(`Dockerfile:      ${analysis.dockerfile.exists ? "exists" : "missing"}`);

        // Host config
        console.log(`Host config:     ${analysis.hostConfig.exists ? "exists" : "missing"}`);

        // Storage
        if (analysis.storage.length > 0) {
          console.log(`Storage:         ${analysis.storage.map((s) => s.path).join(", ")}`);
        }

        // Requirements
        if (analysis.requirements.length > 0) {
          console.log("\nRequirements:");
          for (const req of analysis.requirements) {
            const detail = req.path || req.name || "";
            console.log(`  - ${req.reason}${detail ? ` [${detail}]` : ""}`);
          }
        }

        console.log("");
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

hostCommand
  .command("init")
  .description("Analyze project and generate Dockerfile + uplink.host.json")
  .option("--path <path>", "Project folder (default: .)", ".")
  .option("--port <port>", "Override detected port")
  .option("--yes", "Skip prompts and apply defaults", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const dir = resolve(process.cwd(), String(opts.path));
      const analysis = analyzeProject(dir);

      // Override port if provided
      if (opts.port) {
        const port = Number(opts.port);
        if (Number.isFinite(port) && port > 0) {
          analysis.port = port;
        }
      }

      const results: { dockerfile?: string; hostConfig?: string; analysis: AnalysisResult } = {
        analysis,
      };

      if (opts.json) {
        // JSON mode - just output what would be done
        const dockerfile = generateDockerfile(analysis);
        const hostConfig = generateHostConfig(analysis);
        printJson({
          analysis,
          dockerfile: dockerfile ? { name: dockerfile.name, wouldCreate: !analysis.dockerfile.exists } : null,
          hostConfig: { config: hostConfig, wouldCreate: !analysis.hostConfig.exists },
        });
        return;
      }

      // Interactive mode
      console.log("\nAnalyzing project...\n");

      // Show detected info
      console.log("Detected:");
      if (analysis.framework) {
        const ver = analysis.framework.version ? ` ${analysis.framework.version}` : "";
        console.log(`  Framework:       ${analysis.framework.name}${ver}`);
      } else {
        console.log("  Framework:       (not detected)");
      }
      if (analysis.packageManager) {
        console.log(`  Package manager: ${analysis.packageManager}`);
      }
      if (analysis.database) {
        const file = analysis.database.file ? ` (${analysis.database.file})` : "";
        console.log(`  Database:        ${analysis.database.type}${file}`);
      }
      console.log(`  Port:            ${analysis.port}`);

      // Show requirements
      const needsDockerfile = !analysis.dockerfile.exists;
      const needsHostConfig = !analysis.hostConfig.exists;
      const hasVolumeReqs = analysis.requirements.some((r) => r.type === "persistent_volume");

      if (needsDockerfile || needsHostConfig || hasVolumeReqs) {
        console.log("\nRequirements:");
        if (needsDockerfile) console.log("  - Dockerfile needed");
        if (needsHostConfig) console.log("  - uplink.host.json needed");
        if (hasVolumeReqs) console.log("  - Persistent storage recommended");
      }

      // Generate Dockerfile if needed
      if (needsDockerfile) {
        const dockerfile = generateDockerfile(analysis);
        if (dockerfile) {
          console.log(`\nCreating Dockerfile (${dockerfile.name})...`);
          const dockerfilePath = join(dir, "Dockerfile");
          writeFileSync(dockerfilePath, dockerfile.content, "utf8");
          results.dockerfile = dockerfilePath;
          console.log("  Created Dockerfile");
        } else {
          console.log("\n  Could not generate Dockerfile - framework not supported");
          console.log("  Please create a Dockerfile manually");
        }
      } else {
        console.log("\nDockerfile already exists, skipping...");
      }

      // Generate host config
      if (needsHostConfig) {
        const hostConfig = generateHostConfig(analysis);
        const hostConfigPath = join(dir, "uplink.host.json");
        writeFileSync(hostConfigPath, JSON.stringify(hostConfig, null, 2) + "\n", "utf8");
        results.hostConfig = hostConfigPath;
        console.log("  Created uplink.host.json");
      } else {
        console.log("uplink.host.json already exists, skipping...");
      }

      // Next.js specific: check for standalone output
      if (analysis.framework?.name === "nextjs" && needsDockerfile) {
        const nextConfigPath = join(dir, "next.config.ts");
        const nextConfigJsPath = join(dir, "next.config.js");
        const nextConfigMjsPath = join(dir, "next.config.mjs");

        let configPath: string | null = null;
        if (existsSync(nextConfigPath)) configPath = nextConfigPath;
        else if (existsSync(nextConfigJsPath)) configPath = nextConfigJsPath;
        else if (existsSync(nextConfigMjsPath)) configPath = nextConfigMjsPath;

        if (configPath) {
          const content = readFileSync(configPath, "utf8");
          if (!content.includes('output')) {
            console.log("\n  Note: Add `output: \"standalone\"` to your next.config for Docker builds");
          }
        }
      }

      // Show next steps
      console.log("\nNext steps:");
      console.log("  uplink host create --name <app-name>");
      console.log("  uplink host deploy --name <app-name> --path . --wait");
      console.log("");
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
  .option("--wait", "Wait for deployment to be running", false)
  .option("--wait-timeout <seconds>", "Wait timeout in seconds (default: 300)", "300")
  .option("--wait-interval <seconds>", "Wait poll interval in seconds (default: 2)", "2")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const dir = resolve(process.cwd(), String(opts.path));
      const hostConfig = readHostConfig(dir);
      const { tarPath, sha256, sizeBytes } = makeTarball(dir);

      const app = (await apiRequest("POST", "/v1/apps", { name: opts.name })) as App;
      await updateAppConfig(app.id, hostConfig);
      const rel = (await apiRequest("POST", `/v1/apps/${app.id}/releases`, {
        sha256,
        sizeBytes,
      })) as ReleaseCreateResponse;

      await uploadArtifact(rel.uploadUrl, tarPath, rel.uploadHeaders);
      await completeArtifactUpload(rel.completeUrl);

      const dep = (await apiRequest("POST", `/v1/apps/${app.id}/deployments`, {
        releaseId: rel.release.id,
      })) as Deployment;

      const out: any = {
        app,
        release: rel.release,
        deployment: dep,
        url: app.url,
        note: "Deployment execution is handled by private runner; status/logs may remain queued until runner is deployed.",
      };

      if (opts.wait) {
        const timeoutMs = Math.max(5, Number(opts.waitTimeout || 300)) * 1000;
        const intervalMs = Math.max(1, Number(opts.waitInterval || 2)) * 1000;
        const status = await waitForDeployment(app.id, rel.release.id, dep.id, {
          timeoutMs,
          intervalMs,
          json: Boolean(opts.json),
        });
        out.status = status;
        out.note = "Deployment reached running state.";
      }

      if (opts.json) printJson(out);
      else {
        const finalStatus =
          out.status?.activeDeployment?.status ||
          out.status?.activeDeployment?.status === "" ? out.status.activeDeployment.status : dep.status;
        console.log(`Deployed ${app.name} (${app.id})`);
        console.log(`  url:        ${app.url}`);
        console.log(`  release:    ${rel.release.id}`);
        console.log(`  deployment: ${dep.id} (status=${finalStatus})`);
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

hostCommand
  .command("setup")
  .description("Full setup wizard: analyze, init, create, and deploy in one command")
  .requiredOption("--name <name>", "App name")
  .option("--path <path>", "Project folder (default: .)", ".")
  .option("--yes", "Skip prompts and apply defaults", false)
  .option("--wait", "Wait for deployment to be running", true)
  .option("--dry-run", "Show plan without executing", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const dir = resolve(process.cwd(), String(opts.path));

      // Step 1: Analyze
      if (!opts.json) console.log("\n[1/5] Analyzing project...");
      const analysis = analyzeProject(dir);

      if (opts.json && opts.dryRun) {
        const dockerfile = generateDockerfile(analysis);
        const hostConfig = generateHostConfig(analysis);
        printJson({
          analysis,
          dockerfile: dockerfile ? { name: dockerfile.name, content: dockerfile.content } : null,
          hostConfig,
          appName: opts.name,
          dryRun: true,
        });
        return;
      }

      if (!opts.json) {
        console.log(`    Framework: ${analysis.framework?.name || "(not detected)"}`);
        console.log(`    Database: ${analysis.database?.type || "(none)"}`);
        console.log(`    Port: ${analysis.port}`);
      }

      if (opts.dryRun) {
        console.log("\n[Dry run] Would create:");
        if (!analysis.dockerfile.exists) console.log("  - Dockerfile");
        if (!analysis.hostConfig.exists) console.log("  - uplink.host.json");
        console.log(`  - App: ${opts.name}`);
        console.log("  - Deploy and wait for running status");
        return;
      }

      // Step 2: Generate Dockerfile
      if (!analysis.dockerfile.exists) {
        if (!opts.json) console.log("\n[2/5] Generating Dockerfile...");
        const dockerfile = generateDockerfile(analysis);
        if (dockerfile) {
          const dockerfilePath = join(dir, "Dockerfile");
          writeFileSync(dockerfilePath, dockerfile.content, "utf8");
          if (!opts.json) console.log(`    Created Dockerfile (${dockerfile.name})`);
        } else {
          if (!opts.json) {
            console.log("    Could not generate Dockerfile - framework not supported");
            console.log("    Please create a Dockerfile manually and re-run");
          }
          process.exit(1);
        }
      } else {
        if (!opts.json) console.log("\n[2/5] Dockerfile exists, skipping...");
      }

      // Step 3: Generate host config
      if (!analysis.hostConfig.exists) {
        if (!opts.json) console.log("\n[3/5] Creating uplink.host.json...");
        const hostConfig = generateHostConfig(analysis);
        const hostConfigPath = join(dir, "uplink.host.json");
        writeFileSync(hostConfigPath, JSON.stringify(hostConfig, null, 2) + "\n", "utf8");
        if (!opts.json) console.log("    Created uplink.host.json");
      } else {
        if (!opts.json) console.log("\n[3/5] uplink.host.json exists, skipping...");
      }

      const hostConfig = readHostConfig(dir);

      // Next.js: check for standalone output
      if (analysis.framework?.name === "nextjs") {
        const nextConfigPath = join(dir, "next.config.ts");
        const nextConfigJsPath = join(dir, "next.config.js");
        const nextConfigMjsPath = join(dir, "next.config.mjs");

        let configPath: string | null = null;
        if (existsSync(nextConfigPath)) configPath = nextConfigPath;
        else if (existsSync(nextConfigJsPath)) configPath = nextConfigJsPath;
        else if (existsSync(nextConfigMjsPath)) configPath = nextConfigMjsPath;

        if (configPath) {
          const content = readFileSync(configPath, "utf8");
          if (!content.includes("output")) {
            if (!opts.json) {
              console.log("\n    Note: Your next.config may need `output: \"standalone\"` for Docker builds");
            }
          }
        }
      }

      // Step 4: Create app
      if (!opts.json) console.log("\n[4/5] Creating app on Uplink...");
      const app = (await apiRequest("POST", "/v1/apps", { name: opts.name })) as App;
      await updateAppConfig(app.id, hostConfig);
      if (!opts.json) console.log(`    App: ${app.id}`);

      // Step 5: Deploy
      if (!opts.json) console.log("\n[5/5] Deploying...");
      const { tarPath, sha256, sizeBytes } = makeTarball(dir);

      const rel = (await apiRequest("POST", `/v1/apps/${app.id}/releases`, {
        sha256,
        sizeBytes,
      })) as ReleaseCreateResponse;

      await uploadArtifact(rel.uploadUrl, tarPath, rel.uploadHeaders);
      await completeArtifactUpload(rel.completeUrl);

      const dep = (await apiRequest("POST", `/v1/apps/${app.id}/deployments`, {
        releaseId: rel.release.id,
      })) as Deployment;

      if (!opts.json) console.log(`    Release: ${rel.release.id}`);

      const out: any = {
        app,
        release: rel.release,
        deployment: dep,
        url: app.url,
      };

      if (opts.wait) {
        const timeoutMs = 300 * 1000;
        const intervalMs = 2 * 1000;
        const status = await waitForDeployment(app.id, rel.release.id, dep.id, {
          timeoutMs,
          intervalMs,
          json: Boolean(opts.json),
        });
        out.status = status;
      }

      if (opts.json) {
        printJson(out);
      } else {
        console.log(`\nLive at ${app.url}`);
        console.log(`\nUseful commands:`);
        console.log(`  uplink host status --id ${app.id}`);
        console.log(`  uplink host logs --id ${app.id}`);
        console.log("");
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });