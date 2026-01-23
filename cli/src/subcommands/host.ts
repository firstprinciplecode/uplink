import { Command } from "commander";
import { apiRequest } from "../http";
import { handleError, printJson } from "../utils/machine";
import { analyzeProject, AnalysisResult, buildRequirements } from "../utils/analyze";
import { generateDockerfile, generateHostConfig } from "../templates";
import { createHash } from "crypto";
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { promptLine } from "./menu/io";
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

type SqliteMeta = {
  path?: string;
  envVar?: string;
  pathSource?: string;
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

function isInteractive(opts: { json?: boolean }): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !opts.json);
}

async function resolveProjectPath(
  optsPath: string | undefined,
  opts: { interactive: boolean }
): Promise<string> {
  const cwd = process.cwd();
  if (optsPath && String(optsPath).trim() !== "") {
    return resolve(cwd, String(optsPath));
  }
  if (!opts.interactive) return resolve(cwd, ".");

  while (true) {
    const answer = (await promptLine(`Project path (default ${cwd}): `)).trim();
    const projectPath = resolve(cwd, answer || cwd);
    const confirm = (await promptLine(`Use "${projectPath}"? (Y/n): `)).trim().toLowerCase();
    if (confirm === "" || confirm === "y" || confirm === "yes") return projectPath;
  }
}

async function resolveAppName(
  rawName: string | undefined,
  projectPath: string,
  opts: { interactive: boolean }
): Promise<string> {
  if (rawName && rawName.trim() !== "") return rawName.trim();
  if (!opts.interactive) throw new Error("Missing required option: --name <name>");

  const defaultName = basename(projectPath);
  const answer = (await promptLine(`App name (default ${defaultName}): `)).trim();
  return answer || defaultName;
}

async function resolveUseDefaults(
  rawYes: boolean | undefined,
  opts: { interactive: boolean }
): Promise<boolean> {
  if (rawYes === true) return true;
  if (!opts.interactive) return false;

  const answer = (await promptLine("Use defaults (Y/n): ")).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
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

type HostConfigFile = {
  volumes?: Record<string, string>;
  env?: Record<string, string>;
};

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== "object") return false;
  return Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

function readHostConfig(dir: string): HostConfigFile | null {
  const configPath = join(dir, "uplink.host.json");
  if (!existsSync(configPath)) return null;

  try {
    const raw = readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as HostConfigFile;
    const volumes = isStringRecord(parsed?.volumes) ? parsed.volumes : undefined;
    const env = isStringRecord(parsed?.env) ? parsed.env : undefined;
    if (!volumes && !env) return null;
    return { volumes, env };
  } catch (error) {
    console.warn(`Warning: Failed to parse uplink.host.json (${String(error)})`);
    return null;
  }
}

async function updateAppConfig(appId: string, dir: string, opts: { json: boolean }): Promise<void> {
  const config = readHostConfig(dir);
  if (!config) return;
  const { volumes, env } = config;
  if (!volumes && !env) return;

  await apiRequest("PUT", `/v1/apps/${appId}/config`, { volumes, env });
  if (!opts.json) {
    const parts = [];
    if (volumes) parts.push("volumes");
    if (env) parts.push("env");
    console.log(`  Applied app config: ${parts.join(", ")}`);
  }
}

export const hostCommand = new Command("host").description("Host persistent web services (Dockerfile required)");

async function resolveSqliteConfig(
  analysis: AnalysisResult,
  opts: { yes: boolean }
): Promise<void> {
  const sqliteDb = analysis.database as (AnalysisResult["database"] & SqliteMeta) | null;
  if (!sqliteDb || sqliteDb.type !== "sqlite") return;

  const hasPath = !!sqliteDb.path;
  const hasEnvVar = !!sqliteDb.envVar;
  const defaultPath = "/data/app.db";
  const defaultEnvVar = "DATABASE_PATH";

  if (opts.yes) {
    if (!hasPath) {
      sqliteDb.path = defaultPath;
      sqliteDb.pathSource = "default";
    }
    if (!hasEnvVar && !hasPath) {
      sqliteDb.envVar = defaultEnvVar;
    } else if (!hasEnvVar && sqliteDb.path === defaultPath) {
      sqliteDb.envVar = defaultEnvVar;
    }
    analysis.requirements = buildRequirements(analysis);
    return;
  }

  if (!hasPath) {
    const answer = (await promptLine(`SQLite file path inside container (default ${defaultPath}): `)).trim();
    sqliteDb.path = answer || defaultPath;
    sqliteDb.pathSource = "prompt";
  }

  if (!sqliteDb.envVar) {
    const envAnswer = (await promptLine("SQLite env var name (blank if hard-coded path): ")).trim();
    if (envAnswer) sqliteDb.envVar = envAnswer;
  }

  analysis.requirements = buildRequirements(analysis);
}

function getSqliteMeta(db: AnalysisResult["database"] | null): SqliteMeta {
  if (!db || db.type !== "sqlite") return {};
  return db as SqliteMeta;
}

hostCommand
  .command("analyze")
  .description("Analyze a project and detect framework, database, and deployment requirements")
  .option("--path <path>", "Project folder (default: .)")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const interactive = isInteractive(opts);
      const dir = await resolveProjectPath(opts.path, { interactive });
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
          const sqliteMeta = getSqliteMeta(analysis.database);
          const path = sqliteMeta.path ? ` path=${sqliteMeta.path}` : "";
          const env = sqliteMeta.envVar ? ` env=${sqliteMeta.envVar}` : "";
          console.log(`Database:        ${analysis.database.type}${file}${path}${env}`);
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
  .option("--path <path>", "Project folder (default: .)")
  .option("--port <port>", "Override detected port")
  .option("--yes", "Skip prompts and apply defaults", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const interactive = isInteractive(opts);
      const dir = await resolveProjectPath(opts.path, { interactive });
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
        const sqliteMeta = getSqliteMeta(analysis.database);
        const path = sqliteMeta.path ? ` path=${sqliteMeta.path}` : "";
        const env = sqliteMeta.envVar ? ` env=${sqliteMeta.envVar}` : "";
        console.log(`  Database:        ${analysis.database.type}${file}${path}${env}`);
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

      await resolveSqliteConfig(analysis, { yes: Boolean(opts.yes) });

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
  .command("list")
  .description("List hosted apps")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const result = (await apiRequest("GET", "/v1/apps")) as AppList;
      if (opts.json) {
        printJson(result);
        return;
      }
      if (!result.apps || result.apps.length === 0) {
        console.log("No apps found.");
        return;
      }
      console.log("Hosted apps:");
      for (const app of result.apps) {
        console.log(`- ${app.name} (${app.id})`);
        console.log(`  ${app.url}`);
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

hostCommand
  .command("delete")
  .description("Delete a hosted app")
  .requiredOption("--id <id>", "App id (app_...)")
  .option("--yes", "Skip confirmation", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const interactive = isInteractive(opts);
      if (!opts.yes && interactive) {
        const answer = (await promptLine(`Delete app ${opts.id}? This cannot be undone. (y/N): `))
          .trim()
          .toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          if (!opts.json) console.log("Cancelled.");
          return;
        }
      }
      const result = await apiRequest("DELETE", `/v1/apps/${opts.id}`);
      if (opts.json) printJson(result);
      else console.log(`Deleted app ${opts.id}`);
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
      const { tarPath, sha256, sizeBytes } = makeTarball(dir);

      const app = (await apiRequest("POST", "/v1/apps", { name: opts.name })) as App;
      await updateAppConfig(app.id, dir, { json: Boolean(opts.json) });
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
  .option("--name <name>", "App name")
  .option("--path <path>", "Project folder (default: .)")
  .option("--yes", "Skip prompts and apply defaults", false)
  .option("--wait", "Wait for deployment to be running", true)
  .option("--dry-run", "Show plan without executing", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const interactive = isInteractive(opts);
      const dir = await resolveProjectPath(opts.path, { interactive });
      const appName = await resolveAppName(opts.name, dir, { interactive });
      const useDefaults = await resolveUseDefaults(opts.yes, { interactive });

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
          appName,
          dryRun: true,
        });
        return;
      }

      if (!opts.json) {
        console.log(`    Framework: ${analysis.framework?.name || "(not detected)"}`);
        const sqliteMeta = getSqliteMeta(analysis.database);
        const dbPath = sqliteMeta.path ? ` path=${sqliteMeta.path}` : "";
        const dbEnv = sqliteMeta.envVar ? ` env=${sqliteMeta.envVar}` : "";
        console.log(`    Database: ${analysis.database?.type || "(none)"}${dbPath}${dbEnv}`);
        console.log(`    Port: ${analysis.port}`);
      }

      if (opts.dryRun) {
        console.log("\n[Dry run] Would create:");
        if (!analysis.dockerfile.exists) console.log("  - Dockerfile");
        if (!analysis.hostConfig.exists) console.log("  - uplink.host.json");
        console.log(`  - App: ${appName}`);
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

      await resolveSqliteConfig(analysis, { yes: useDefaults });

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
      const app = (await apiRequest("POST", "/v1/apps", { name: appName })) as App;
      if (!opts.json) console.log(`    App: ${app.id}`);
      await updateAppConfig(app.id, dir, { json: Boolean(opts.json) });

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
      }      if (opts.json) {
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
