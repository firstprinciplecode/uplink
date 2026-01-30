import { Command } from "commander";
import { apiRequest } from "../http";
import { handleError, printJson } from "../utils/machine";
import { analyzeProject, AnalysisResult, buildRequirements } from "../utils/analyze";
import { generateDockerfile, generateHostConfig } from "../templates";
import { createHash } from "crypto";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "fs";
import { basename, join, resolve } from "path";
import { promptLine } from "./menu/io";
import { colorRed } from "./menu/colors";
import os from "os";
import fetch from "node-fetch";
import { spawnSync } from "child_process";
import { getResolvedApiBase, getResolvedApiToken } from "../utils/api-base";

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

type PreflightItem = {
  level: "required" | "recommended";
  title: string;
  detail?: string;
  action?: string;
};

function getApiBase(): string {
  return getResolvedApiBase();
}

function getApiToken(): string | undefined {
  const apiBase = getApiBase();
  return getResolvedApiToken(apiBase);
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
  let pollCount = 0;
  let intervalMs = opts.intervalMs;
  let sameSummaryCount = 0;
  let lastHeartbeatAt = start;
  const heartbeatIntervalMs = 30_000;
  while (Date.now() - start < opts.timeoutMs) {
    pollCount += 1;
    let status: AppStatus;
    try {
      status = (await apiRequest("GET", `/v1/apps/${appId}/status`)) as AppStatus;
    } catch (error) {
      const errorCode = (() => {
        if (!(error instanceof Error)) return null;
        try {
          const parsed = JSON.parse(error.message) as { error?: { code?: string }; code?: string };
          return parsed?.error?.code || parsed?.code || null;
        } catch {
          return null;
        }
      })();
      if (errorCode === "RATE_LIMIT_EXCEEDED") {
        const nextIntervalMs = Math.min(Math.max(intervalMs * 2, 5000), 30000);
        intervalMs = nextIntervalMs;
        await new Promise((r) => setTimeout(r, intervalMs));
        continue;
      }
      throw error;
    }
    const buildStatus = status.activeRelease?.buildStatus || "unknown";
    const deployStatus = status.activeDeployment?.status || "unknown";
    const summary = `build=${buildStatus} deploy=${deployStatus}`;
    if (summary === lastSummary) {
      sameSummaryCount += 1;
    } else {
      sameSummaryCount = 0;
    }
    if (summary === lastSummary && summary.includes("queued") && sameSummaryCount >= 5) {
      const nextIntervalMs = Math.min(Math.max(intervalMs, 5000), 15000);
      if (nextIntervalMs !== intervalMs) {
        intervalMs = nextIntervalMs;
      }
    }

    if (!opts.json && summary !== lastSummary) {
      console.log(`Status: ${summary}`);
      lastSummary = summary;
    }

    if (!opts.json && Date.now() - lastHeartbeatAt >= heartbeatIntervalMs) {
      const elapsedMs = Date.now() - start;
      const elapsedSec = Math.floor(elapsedMs / 1000);
      const minutes = Math.floor(elapsedSec / 60);
      const seconds = elapsedSec % 60;
      const elapsedLabel = minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
      console.log(`Waiting... (${elapsedLabel} elapsed)`);
      lastHeartbeatAt = Date.now();
    }

    if (status.activeRelease?.id === releaseId && status.activeRelease?.buildStatus === "failed") {
      throw new Error("Build failed");
    }
    if (status.activeDeployment?.id === deploymentId && status.activeDeployment?.status === "running") {
      return status;
    }

    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("Timed out waiting for deployment");
}

// Default patterns to always exclude from deployment artifacts
const DEFAULT_TARBALL_EXCLUDES = [
  // Version control
  ".git",
  ".gitignore",
  ".gitattributes",
  // macOS metadata (AppleDouble files)
  "._*",
  ".DS_Store",
  ".AppleDouble",
  ".LSOverride",
  // Node.js
  "node_modules",
  ".npm",
  ".yarn",
  ".pnpm-store",
  // Build artifacts (should be rebuilt in Docker)
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  ".vercel",
  ".netlify",
  // Test/coverage
  "coverage",
  ".nyc_output",
  // IDE/Editor
  ".idea",
  ".vscode",
  "*.swp",
  "*.swo",
  // Logs
  "*.log",
  "npm-debug.log*",
  "yarn-debug.log*",
  "yarn-error.log*",
  // Environment files (should use --env-file or uplink.host.json)
  ".env",
  ".env.local",
  ".env.development",
  ".env.development.local",
  // Misc
  "*.pid",
  "*.seed",
  "Thumbs.db",
];

// Patterns that indicate a problematic artifact if found in tarball
const FORBIDDEN_TARBALL_PATTERNS = [
  /^\._/, // AppleDouble files at root
  /\/\._/, // AppleDouble files in subdirectories
  /^\.DS_Store$/,
  /\/\.DS_Store$/,
];

function validateTarballContents(tarPath: string): { valid: boolean; forbidden: string[] } {
  const result = spawnSync("tar", ["-tzf", tarPath], {
    stdio: "pipe",
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024, // 50MB buffer for large file lists
  });

  if (result.status !== 0) {
    // If we can't list contents, skip validation but warn
    console.warn("Warning: Could not validate tarball contents");
    return { valid: true, forbidden: [] };
  }

  const files = (result.stdout || "").split("\n").filter(Boolean);
  const forbidden: string[] = [];

  for (const file of files) {
    for (const pattern of FORBIDDEN_TARBALL_PATTERNS) {
      if (pattern.test(file)) {
        forbidden.push(file);
        break;
      }
    }
  }

  return { valid: forbidden.length === 0, forbidden };
}

function makeTarball(sourceDir: string): { tarPath: string; sizeBytes: number; sha256: string } {
  const tmp = join(os.tmpdir(), `uplink-host-${Date.now()}-${Math.random().toString(16).slice(2)}.tgz`);
  
  // Read user-defined ignore files
  const ignoreFiles = [".gitignore", ".uplinkignore"]
    .map((name) => join(sourceDir, name))
    .filter((path) => existsSync(path));
  const ignoreArgs = ignoreFiles.flatMap((path) => ["--exclude-from", path]);

  // Build default exclude arguments
  const defaultExcludeArgs = DEFAULT_TARBALL_EXCLUDES.flatMap((pattern) => ["--exclude", pattern]);

  // Set COPYFILE_DISABLE=1 to prevent macOS from adding AppleDouble (._*) files
  // This is critical for macOS users - without it, tar automatically creates ._* metadata files
  const tarEnv = {
    ...process.env,
    COPYFILE_DISABLE: "1",
  };

  const result = spawnSync(
    "tar",
    ["-czf", tmp, ...defaultExcludeArgs, ...ignoreArgs, "-C", sourceDir, "."],
    {
      stdio: "pipe",
      encoding: "utf8",
      env: tarEnv,
    }
  );
  
  if (result.status !== 0) {
    throw new Error(`Failed to create tarball: ${result.stderr || result.stdout || "unknown error"}`);
  }

  // Validate that no forbidden files made it into the tarball
  const validation = validateTarballContents(tmp);
  if (!validation.valid) {
    const examples = validation.forbidden.slice(0, 5);
    const moreCount = validation.forbidden.length - examples.length;
    const moreText = moreCount > 0 ? ` (and ${moreCount} more)` : "";
    throw new Error(
      `Tarball contains forbidden files that will cause build failures:\n` +
      `  ${examples.join("\n  ")}${moreText}\n\n` +
      `These are typically macOS metadata files. To fix:\n` +
      `  1. Run: find . -type f -name '._*' -delete\n` +
      `  2. Run: dot_clean -m .\n` +
      `  3. Re-run the deploy command`
    );
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

function mergeEnv(
  base: Record<string, string> | undefined,
  extra: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!base && !extra) return undefined;
  return { ...(base || {}), ...(extra || {}) };
}

async function updateAppConfig(
  appId: string,
  dir: string,
  opts: { json: boolean; extraEnv?: Record<string, string> }
): Promise<void> {
  const config = readHostConfig(dir);
  const volumes = config?.volumes;
  const env = mergeEnv(config?.env, opts.extraEnv);
  if (!volumes && !env) return;

  await apiRequest("PUT", `/v1/apps/${appId}/config`, { volumes, env });
  if (!opts.json) {
    const parts = [];
    if (volumes) parts.push("volumes");
    if (env) parts.push("env");
    console.log(`  Applied app config: ${parts.join(", ")}`);
  }
}

function parseEnvFile(filePath: string): Record<string, string> {
  const raw = readFileSync(filePath, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const cleaned = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
    const idx = cleaned.indexOf("=");
    if (idx === -1) continue;
    const key = cleaned.slice(0, idx).trim();
    if (!key) continue;
    let value = cleaned.slice(idx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function resolveEnvFile(
  envFile: string | undefined,
  dir: string,
  opts: { interactive: boolean }
): Promise<string | null> {
  if (envFile && envFile.trim() !== "") {
    const resolved = resolve(dir, envFile);
    if (!existsSync(resolved)) {
      throw new Error(`Env file not found: ${resolved}`);
    }
    return resolved;
  }

  const defaultPath = join(dir, ".env");
  const prodPath = join(dir, ".env.production");
  if (!opts.interactive) return null;

  if (existsSync(defaultPath) && !existsSync(prodPath)) {
    const hostEnv = readHostConfig(dir)?.env;
    if (hostEnv && Object.keys(hostEnv).length > 0) {
      const answer = (await promptLine(
        "Create .env.production from uplink.host.json env? (y/N): "
      ))
        .trim()
        .toLowerCase();
      if (answer === "y" || answer === "yes") {
        writeEnvFile(prodPath, hostEnv);
        console.log("  Created .env.production");
      }
    } else {
      const answer = (await promptLine("Create .env.production by copying .env? (y/N): "))
        .trim()
        .toLowerCase();
      if (answer === "y" || answer === "yes") {
        const envFromFile = readEnvFileSafe(defaultPath);
        if (envFromFile) {
          const filtered = filterEnvForProduction(envFromFile);
          if (Object.keys(filtered.env).length === 0) {
            console.log("  Skipped .env.production (no production-safe entries found)");
          } else {
            writeEnvFile(prodPath, filtered.env);
            console.log("  Created .env.production");
          }
          if (filtered.skipped.length > 0) {
            console.log(`  Skipped localhost entries: ${filtered.skipped.join(", ")}`);
          }
        } else {
          writeFileSync(prodPath, readFileSync(defaultPath, "utf8"), "utf8");
          console.log("  Created .env.production");
        }
      }
    }
  }

  if (existsSync(prodPath)) {
    const answer = (await promptLine("Load .env.production into app config? (y/N): "))
      .trim()
      .toLowerCase();
    if (answer === "y" || answer === "yes") return prodPath;
  }

  if (!existsSync(defaultPath)) return null;
  const answer = (await promptLine("Load .env into app config? (y/N): ")).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") return null;
  return defaultPath;
}

function detectUplinkIgnoreSuggestions(dir: string, analysis: AnalysisResult): string[] {
  const suggestions = new Set<string>();

  const suggestIfDir = (name: string) => {
    if (existsSync(join(dir, name))) suggestions.add(name);
  };

  // Always suggest macOS metadata patterns (they cause build failures)
  suggestions.add("._*");
  suggestions.add("**/._*");
  suggestions.add(".DS_Store");

  // Node.js/JavaScript
  suggestIfDir("node_modules");
  suggestIfDir(".next");
  suggestIfDir("dist");
  suggestIfDir("build");
  suggestIfDir(".turbo");
  suggestIfDir(".cache");
  suggestIfDir(".vercel");
  suggestIfDir("coverage");
  suggestIfDir(".npm");
  suggestIfDir(".yarn");
  suggestIfDir(".pnpm-store");

  try {
    const rootFiles = readdirSync(dir);
    if (rootFiles.some((file) => file.endsWith(".log"))) {
      suggestions.add("*.log");
    }
  } catch {
    // ignore
  }

  // Environment files
  suggestions.add(".env");
  suggestions.add(".env.*");

  // Misc
  suggestions.add("*.pid");

  if (analysis.database?.type === "sqlite" && analysis.database.file) {
    suggestions.add(analysis.database.file);
  }
  if (existsSync(join(dir, "prisma", "dev.db"))) {
    suggestions.add("prisma/dev.db");
  }
  if (existsSync(join(dir, "prisma", "migrations"))) {
    suggestions.add("prisma/migrations");
  }

  return Array.from(suggestions);
}

function writeUplinkIgnore(dir: string, entries: string[]): void {
  const target = join(dir, ".uplinkignore");
  if (entries.length === 0) return;
  if (existsSync(target)) return;
  writeFileSync(target, entries.join("\n") + "\n", "utf8");
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
  const usesPrisma = analysis.usesPrisma;
  const defaultPath = "/data/app.db";
  const defaultEnvVar = usesPrisma ? "DATABASE_URL" : "DATABASE_PATH";
  const defaultEnvValue = usesPrisma ? "file:/data/app.db" : "/data/app.db";

  if (opts.yes) {
    if (!hasPath && !usesPrisma) {
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

  if (!hasPath && !usesPrisma) {
    const answer = (await promptLine(`SQLite file path inside container (default ${defaultPath}): `)).trim();
    sqliteDb.path = answer || defaultPath;
    sqliteDb.pathSource = "prompt";
  }

  if (!sqliteDb.envVar) {
    const promptText = usesPrisma
      ? `SQLite database URL env var (default ${defaultEnvVar}=${defaultEnvValue}): `
      : "SQLite env var name (blank if hard-coded path): ";
    const envAnswer = (await promptLine(promptText)).trim();
    if (envAnswer) sqliteDb.envVar = envAnswer;
    else if (usesPrisma) sqliteDb.envVar = defaultEnvVar;
  }

  analysis.requirements = buildRequirements(analysis);
}

function getSqliteMeta(db: AnalysisResult["database"] | null): SqliteMeta {
  if (!db || db.type !== "sqlite") return {};
  return db as SqliteMeta;
}

function findNextConfigPath(dir: string): string | null {
  const nextConfigPath = join(dir, "next.config.ts");
  const nextConfigJsPath = join(dir, "next.config.js");
  const nextConfigMjsPath = join(dir, "next.config.mjs");
  if (existsSync(nextConfigPath)) return nextConfigPath;
  if (existsSync(nextConfigJsPath)) return nextConfigJsPath;
  if (existsSync(nextConfigMjsPath)) return nextConfigMjsPath;
  return null;
}

function hasStandaloneOutputConfig(content: string): boolean {
  return /output\s*:\s*["']standalone["']/.test(content);
}

function applyStandaloneOutputConfig(configPath: string): boolean {
  const content = readFileSync(configPath, "utf8");
  if (hasStandaloneOutputConfig(content)) return false;
  const nextConfigAssign = /(const\s+nextConfig[^=]*=\s*\{)/;
  const moduleExportsAssign = /(module\.exports\s*=\s*\{)/;
  const exportDefaultAssign = /(export\s+default\s*\{)/;
  const updated =
    content.replace(nextConfigAssign, `$1\n  output: "standalone",`) !== content
      ? content.replace(nextConfigAssign, `$1\n  output: "standalone",`)
      : content.replace(moduleExportsAssign, `$1\n  output: "standalone",`) !== content
        ? content.replace(moduleExportsAssign, `$1\n  output: "standalone",`)
        : content.replace(exportDefaultAssign, `$1\n  output: "standalone",`);
  if (updated === content) return false;
  writeFileSync(configPath, updated, "utf8");
  return true;
}

function dockerfileHasPrismaGenerate(dockerfilePath: string): boolean {
  if (!existsSync(dockerfilePath)) return false;
  const content = readFileSync(dockerfilePath, "utf8");
  return content.includes("prisma generate");
}

function applyPrismaDockerfileUpdates(dockerfilePath: string): boolean {
  if (!existsSync(dockerfilePath)) return false;
  const content = readFileSync(dockerfilePath, "utf8");
  if (content.includes("prisma generate")) return false;
  let updated = content;
  if (!/COPY\s+prisma\b/.test(updated)) {
    updated = updated.replace(
      /(COPY\s+package\.json[^\n]*\n)/,
      `$1COPY prisma ./prisma\n`
    );
  }
  if (!updated.includes("npx prisma generate")) {
    if (/RUN\s+.*npm\s+ci/.test(updated) || /RUN\s+.*yarn\s+install/.test(updated) || /RUN\s+.*pnpm\s+install/.test(updated)) {
      updated = updated.replace(
        /(RUN[^\n]*((npm\s+ci)|(yarn\s+install)|(pnpm\s+install))[^\n]*)/i,
        `$1\nRUN npx prisma generate`
      );
    } else {
      updated = `${updated}\nRUN npx prisma generate\n`;
    }
  }
  if (updated === content) return false;
  writeFileSync(dockerfilePath, updated, "utf8");
  return true;
}

function isLocalhostUrl(value: string): boolean {
  return (
    value.includes("://localhost") ||
    value.includes("://127.0.0.1") ||
    value.includes("://0.0.0.0")
  );
}

function resolveNextAuthEnvStatus(
  analysis: AnalysisResult,
  extraEnv: Record<string, string> | undefined,
  hostEnv: Record<string, string> | undefined
): { url?: string; secret?: string; needsUrl: boolean; needsSecret: boolean; urlIsLocal: boolean } {
  if (!analysis.usesNextAuth) {
    return { needsUrl: false, needsSecret: false, urlIsLocal: false };
  }
  const merged = { ...(hostEnv || {}), ...(extraEnv || {}) };
  const url = merged.NEXTAUTH_URL;
  const secret = merged.NEXTAUTH_SECRET;
  const urlIsLocal = url ? isLocalhostUrl(url) : false;
  return {
    url,
    secret,
    needsUrl: !url || url.trim() === "",
    needsSecret: !secret || secret.trim() === "",
    urlIsLocal,
  };
}

function readEnvFileSafe(filePath: string): Record<string, string> | null {
  if (!existsSync(filePath)) return null;
  try {
    return parseEnvFile(filePath);
  } catch {
    return null;
  }
}

function writeEnvFile(filePath: string, env: Record<string, string>): void {
  const lines = Object.entries(env)
    .filter(([key]) => key && !key.startsWith("#"))
    .map(([key, value]) => `${key}=${JSON.stringify(String(value))}`);
  writeFileSync(filePath, lines.join("\n") + "\n", "utf8");
}

function filterEnvForProduction(env: Record<string, string>): {
  env: Record<string, string>;
  skipped: string[];
} {
  const out: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (isLocalhostUrl(value)) {
      skipped.push(key);
      continue;
    }
    out[key] = value;
  }
  return { env: out, skipped };
}

function usesRuntimePrisma(dir: string): boolean {
  const entrypoint = join(dir, "docker-entrypoint.sh");
  if (!existsSync(entrypoint)) return false;
  try {
    const content = readFileSync(entrypoint, "utf8");
    return /prisma\s+(migrate|db|generate)/.test(content);
  } catch {
    return false;
  }
}

function dockerfileExpectsStandalone(dockerfilePath: string): boolean {
  if (!existsSync(dockerfilePath)) return false;
  const content = readFileSync(dockerfilePath, "utf8");
  return content.includes(".next/standalone");
}

function dockerfileRunnerHasNodeModules(dockerfilePath: string): boolean {
  if (!existsSync(dockerfilePath)) return false;
  const content = readFileSync(dockerfilePath, "utf8");
  const lines = content.split(/\r?\n/);
  let inRunner = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^FROM\s+/i.test(trimmed)) {
      inRunner = /AS\s+runner$/i.test(trimmed);
      continue;
    }
    if (!inRunner) continue;
    if (/^FROM\s+/i.test(trimmed)) break;
    if (/COPY\s+--from=deps\s+\/app\/node_modules\/?\s+\.\/node_modules\/?/i.test(trimmed)) {
      return true;
    }
  }
  return false;
}

function addRunnerNodeModulesCopy(dockerfilePath: string): boolean {
  if (!existsSync(dockerfilePath)) return false;
  const content = readFileSync(dockerfilePath, "utf8");
  if (dockerfileRunnerHasNodeModules(dockerfilePath)) return false;
  const lines = content.split(/\r?\n/);
  let inRunner = false;
  let insertIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (/^FROM\s+/i.test(trimmed)) {
      inRunner = /AS\s+runner$/i.test(trimmed);
      continue;
    }
    if (!inRunner) continue;
    if (/^WORKDIR\s+/i.test(trimmed)) {
      insertIdx = i + 1;
      break;
    }
  }
  if (insertIdx === -1) return false;
  lines.splice(insertIdx, 0, "COPY --from=deps /app/node_modules ./node_modules");
  writeFileSync(dockerfilePath, lines.join("\n"), "utf8");
  return true;
}

function findSeedFiles(dir: string): string[] {
  const candidates = [
    join(dir, "prisma", "seed.mjs"),
    join(dir, "prisma", "seed.js"),
    join(dir, "prisma", "seed.ts"),
    join(dir, "prisma", "seed.cjs"),
  ];
  return candidates.filter((path) => existsSync(path));
}

function seedReferencesEnvVar(dir: string, envVar: string): boolean {
  const seedFiles = findSeedFiles(dir);
  for (const filePath of seedFiles) {
    try {
      const content = readFileSync(filePath, "utf8");
      if (content.includes(envVar)) return true;
    } catch {
      // ignore
    }
  }
  return false;
}

function buildPreflightChecklist(
  dir: string,
  analysis: AnalysisResult,
  extraEnv: Record<string, string> | undefined
): PreflightItem[] {
  const items: PreflightItem[] = [];
  const hostEnv = readHostConfig(dir)?.env;
  const mergedEnv = { ...(hostEnv || {}), ...(extraEnv || {}) };
  const envFile = readEnvFileSafe(join(dir, ".env"));
  const envProdPath = join(dir, ".env.production");
  const hasEnvProd = existsSync(envProdPath);
  const runtimePrisma = usesRuntimePrisma(dir);

  if (analysis.usesNextAuth) {
    const nextAuthStatus = resolveNextAuthEnvStatus(analysis, extraEnv, hostEnv);
    if (nextAuthStatus.needsUrl) {
      items.push({
        level: "required",
        title: "NEXTAUTH_URL is missing",
        detail: "NextAuth requires a public URL for callbacks.",
        action: "Set it to your app URL after create (https://<app-id>.host.uplink.spot).",
      });
    } else if (nextAuthStatus.urlIsLocal) {
      items.push({
        level: "required",
        title: "NEXTAUTH_URL points to localhost",
        detail: "This causes callback 401s in production.",
        action: "Update NEXTAUTH_URL to your public app URL.",
      });
    }
    if (nextAuthStatus.needsSecret) {
      items.push({
        level: "required",
        title: "NEXTAUTH_SECRET is missing",
        detail: "Required to sign sessions securely.",
        action: "Generate a random secret and store it in env.",
      });
    }
    if (envFile?.NEXTAUTH_URL && isLocalhostUrl(envFile.NEXTAUTH_URL)) {
      items.push({
        level: "recommended",
        title: ".env contains a localhost NEXTAUTH_URL",
        detail: "Loading .env in production will break auth callbacks.",
        action: "Avoid loading .env; set NEXTAUTH_URL in uplink.host.json.",
      });
    }
  }
  if (envFile && !hasEnvProd) {
    items.push({
      level: "recommended",
      title: ".env.production not found",
      detail: "Use a production-specific env file to avoid dev settings.",
      action: "Create .env.production and use --env-file to apply it.",
    });
  }

  if (analysis.framework?.name === "nextjs") {
    const configPath = findNextConfigPath(dir);
    const hasStandalone = configPath ? hasStandaloneOutputConfig(readFileSync(configPath, "utf8")) : false;
    const dockerfilePath = join(dir, "Dockerfile");
    if (analysis.dockerfile.exists && dockerfileExpectsStandalone(dockerfilePath) && !hasStandalone) {
      items.push({
        level: "required",
        title: "Next.js output is missing `standalone`",
        detail: "Dockerfile expects .next/standalone.",
        action: "Add `output: \"standalone\"` to your Next.js config.",
      });
    } else if (!analysis.dockerfile.exists && configPath && !hasStandalone) {
      items.push({
        level: "recommended",
        title: "Next.js output is not set to `standalone`",
        detail: "Standalone builds reduce image size and simplify runtime.",
        action: "Consider adding `output: \"standalone\"`.",
      });
    }
  }

  if (analysis.usesPrisma) {
    const dockerfilePath = join(dir, "Dockerfile");
    if (analysis.dockerfile.exists && !dockerfileHasPrismaGenerate(dockerfilePath)) {
      items.push({
        level: "required",
        title: "Dockerfile missing `prisma generate`",
        detail: "Prisma Client must be generated during build.",
        action: "Add `npx prisma generate` after dependency install.",
      });
    }
  }

  if (analysis.usesPrisma && runtimePrisma) {
    const dockerfilePath = join(dir, "Dockerfile");
    if (analysis.dockerfile.exists && !dockerfileRunnerHasNodeModules(dockerfilePath)) {
      items.push({
        level: "required",
        title: "Runtime Prisma detected but runner lacks node_modules",
        detail: "Prisma CLI needs full node_modules at runtime (migrate/seed).",
        action: "Copy full node_modules into the runner stage.",
      });
    }
  }

  if (analysis.database?.type === "sqlite") {
    const usesPrisma = analysis.usesPrisma;
    const defaultEnvVar = usesPrisma ? "DATABASE_URL" : "DATABASE_PATH";
    const defaultValue = usesPrisma ? "file:/data/app.db" : "/data/app.db";
    const hasEnv = Boolean(mergedEnv[defaultEnvVar]);
    if (!hasEnv) {
      items.push({
        level: "recommended",
        title: `${defaultEnvVar} is not set`,
        detail: "SQLite needs a persistent path for data.",
        action: `Set ${defaultEnvVar}=${defaultValue} and mount /data as persistent.`,
      });
    }
  }

  if (analysis.usesPrisma) {
    const needsAdminEmail = seedReferencesEnvVar(dir, "ADMIN_EMAIL");
    const needsAdminPassword = seedReferencesEnvVar(dir, "ADMIN_PASSWORD");
    if (needsAdminEmail && !mergedEnv.ADMIN_EMAIL) {
      items.push({
        level: "required",
        title: "ADMIN_EMAIL is missing",
        detail: "Seed script references ADMIN_EMAIL.",
        action: "Provide ADMIN_EMAIL in env to allow seeding.",
      });
    }
    if (needsAdminPassword && !mergedEnv.ADMIN_PASSWORD) {
      items.push({
        level: "required",
        title: "ADMIN_PASSWORD is missing",
        detail: "Seed script references ADMIN_PASSWORD.",
        action: "Provide ADMIN_PASSWORD in env to allow seeding.",
      });
    }
  }

  return items;
}

function printPreflightChecklist(items: PreflightItem[], opts?: { showOkSummary?: boolean }): void {
  const showOkSummary = Boolean(opts?.showOkSummary);
  if (items.length === 0 && !showOkSummary) return;
  console.log("\nPreflight checklist:");
  if (items.length === 0) {
    console.log("  - [OK] No blocking issues detected");
    return;
  }
  for (const item of items) {
    const label = item.level === "required" ? "REQUIRED" : "RECOMMENDED";
    const detail = item.detail ? ` — ${item.detail}` : "";
    const action = item.action ? `\n      Action: ${item.action}` : "";
    console.log(`  - [${label}] ${item.title}${detail}${action}`);
  }
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
        const preflight = buildPreflightChecklist(dir, analysis, undefined);
        printJson({ ...analysis, preflight });
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
      if (analysis.framework && ["nextjs", "express", "fastify", "hono", "nestjs", "nodejs"].includes(analysis.framework.name)) {
        console.log(`Node base image: ${analysis.nodeBaseImage}`);
        if (analysis.nativeNodeDeps.length > 0) {
          console.log(`Native deps:     ${analysis.nativeNodeDeps.join(", ")}`);
        }
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

        // Env file
        const envPath = join(dir, ".env");
        console.log(`Env file:        ${existsSync(envPath) ? ".env (use --env-file to apply)" : "not found"}`);

        // .uplinkignore
        const uplinkIgnorePath = join(dir, ".uplinkignore");
        const ignoreSuggestions = detectUplinkIgnoreSuggestions(dir, analysis);
        console.log(`Uplinkignore:    ${existsSync(uplinkIgnorePath) ? "exists" : "missing"}`);
        if (!existsSync(uplinkIgnorePath) && ignoreSuggestions.length > 0) {
          console.log(`  Suggested:     ${ignoreSuggestions.join(", ")}`);
        }

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

        if (analysis.healthChecks.length > 0) {
          console.log("\nProject health:");
          for (const check of analysis.healthChecks) {
            const label = check.level === "warning" ? "WARN" : "INFO";
            const detail = check.detail ? ` — ${check.detail}` : "";
            console.log(`  - [${label}] ${check.message}${detail}`);
          }
        }
        const preflight = buildPreflightChecklist(dir, analysis, undefined);
        printPreflightChecklist(preflight, { showOkSummary: true });

        console.log("");
      }
    } catch (error) {
      handleError(error, { json: opts.json });
    }
  });

hostCommand
  .command("preflight")
  .description("Run preflight checks and report required setup items")
  .option("--path <path>", "Project folder (default: .)")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const interactive = isInteractive(opts);
      const dir = await resolveProjectPath(opts.path, { interactive });
      const analysis = analyzeProject(dir);
      const preflight = buildPreflightChecklist(dir, analysis, undefined);

      if (opts.json) {
        printJson({ analysis, preflight });
        return;
      }

      console.log("\nPreflight Report");
      console.log("================\n");
      console.log(`Path:            ${dir}`);
      if (analysis.framework) {
        const ver = analysis.framework.version ? ` (${analysis.framework.version})` : "";
        console.log(`Framework:       ${analysis.framework.name}${ver}`);
      } else {
        console.log("Framework:       (not detected)");
      }
      printPreflightChecklist(preflight, { showOkSummary: true });
      console.log("");
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
        const preflight = buildPreflightChecklist(dir, analysis, undefined);
        printJson({
          analysis,
          dockerfile: dockerfile ? { name: dockerfile.name, wouldCreate: !analysis.dockerfile.exists } : null,
          hostConfig: { config: hostConfig, wouldCreate: !analysis.hostConfig.exists },
          preflight,
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
      if (analysis.framework && ["nextjs", "express", "fastify", "hono", "nestjs", "nodejs"].includes(analysis.framework.name)) {
        console.log(`  Node base image: ${analysis.nodeBaseImage}`);
        if (analysis.nativeNodeDeps.length > 0) {
          console.log(`  Native deps:     ${analysis.nativeNodeDeps.join(", ")}`);
        }
      }

      if (analysis.healthChecks.length > 0) {
        console.log("\nProject health:");
        for (const check of analysis.healthChecks) {
          const label = check.level === "warning" ? "WARN" : "INFO";
          const detail = check.detail ? ` — ${check.detail}` : "";
          console.log(`  - [${label}] ${check.message}${detail}`);
        }
      }
      const preflight = buildPreflightChecklist(dir, analysis, undefined);
      printPreflightChecklist(preflight, { showOkSummary: true });

      if (interactive && analysis.usesPrisma && usesRuntimePrisma(dir) && analysis.dockerfile.exists) {
        const dockerfilePath = join(dir, "Dockerfile");
        if (!dockerfileRunnerHasNodeModules(dockerfilePath)) {
          const answer = (await promptLine(
            "\nRuntime Prisma detected. Copy full node_modules into runner stage? (Y/n): "
          ))
            .trim()
            .toLowerCase();
          if (answer === "" || answer === "y" || answer === "yes") {
            const updated = addRunnerNodeModulesCopy(dockerfilePath);
            if (updated) console.log("  Updated Dockerfile to copy node_modules into runner");
          }
        }
      }

      if (interactive && analysis.framework?.name === "nextjs") {
        const configPath = findNextConfigPath(dir);
        if (configPath) {
          const content = readFileSync(configPath, "utf8");
          if (!hasStandaloneOutputConfig(content)) {
            const answer = (await promptLine(
              `\nAdd output: "standalone" to ${basename(configPath)}? (Y/n): `
            ))
              .trim()
              .toLowerCase();
            if (answer === "" || answer === "y" || answer === "yes") {
              const updated = applyStandaloneOutputConfig(configPath);
              if (updated) console.log("  Updated Next.js config for standalone output");
            }
          }
        }
      }

      if (interactive && analysis.usesPrisma && analysis.dockerfile.exists) {
        const dockerfilePath = join(dir, "Dockerfile");
        if (!dockerfileHasPrismaGenerate(dockerfilePath)) {
          const answer = (await promptLine(
            `\nAdd prisma generate steps to Dockerfile? (Y/n): `
          ))
            .trim()
            .toLowerCase();
          if (answer === "" || answer === "y" || answer === "yes") {
            const updated = applyPrismaDockerfileUpdates(dockerfilePath);
            if (updated) console.log("  Updated Dockerfile with prisma generate");
          }
        }
      }

      const ignoreSuggestions = detectUplinkIgnoreSuggestions(dir, analysis);
      const uplinkIgnorePath = join(dir, ".uplinkignore");
      if (!existsSync(uplinkIgnorePath) && ignoreSuggestions.length > 0) {
        const shouldCreate = opts.yes
          ? "y"
          : (await promptLine(`\nCreate .uplinkignore with suggested entries? (Y/n): `)).trim().toLowerCase();
        if (shouldCreate === "" || shouldCreate === "y" || shouldCreate === "yes") {
          writeUplinkIgnore(dir, ignoreSuggestions);
          console.log("  Created .uplinkignore");
        }
      }

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
        if (analysis.nativeNodeDeps.length > 0) {
          const choice = opts.yes
            ? "y"
            : (await promptLine(
                `Detected native deps (${analysis.nativeNodeDeps.join(", ")}). Use Debian base image? (Y/n): `
              ))
                .trim()
                .toLowerCase();
          if (choice === "" || choice === "y" || choice === "yes") {
            analysis.nodeBaseImage = "debian";
          } else {
            analysis.nodeBaseImage = "alpine";
          }
        }
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
        const configPath = findNextConfigPath(dir);
        if (configPath) {
          const content = readFileSync(configPath, "utf8");
          if (!hasStandaloneOutputConfig(content)) {
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
  .option("--delete-volumes", "Also delete persistent volume data", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const interactive = isInteractive(opts);
      if (!opts.yes && interactive) {
        const volumeWarning = opts.deleteVolumes
          ? " INCLUDING ALL PERSISTENT DATA (databases, files, etc.)"
          : "";
        const confirmPrompt =
          `Delete app ${opts.id}${volumeWarning}? This cannot be undone.\n` +
          colorRed("Type DELETE to confirm: ");
        const answer = (await promptLine(confirmPrompt)).trim();
        if (answer !== "DELETE") {
          if (!opts.json) console.log("Cancelled.");
          return;
        }
      }
      const queryParams = opts.deleteVolumes ? "?deleteVolumes=true" : "";
      const result = await apiRequest("DELETE", `/v1/apps/${opts.id}${queryParams}`);
      if (opts.json) printJson(result);
      else {
        console.log(`Deleted app ${opts.id}`);
        if (result.cleanupId) {
          console.log(`  Cleanup queued: ${result.cleanupId}`);
          console.log(`  - Containers and images will be removed`);
          if (opts.deleteVolumes) {
            console.log(`  - Persistent volume data will be deleted`);
          } else {
            console.log(`  - Persistent volume data preserved (use --delete-volumes to remove)`);
          }
        }
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
  .option("--env-file <path>", "Load environment variables from a .env file")
  .option("--wait", "Wait for deployment to be running", false)
  .option("--wait-timeout <seconds>", "Wait timeout in seconds (default: 300)", "300")
  .option("--wait-interval <seconds>", "Wait poll interval in seconds (default: 2)", "2")
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const dir = resolve(process.cwd(), String(opts.path));
      const envFilePath = await resolveEnvFile(opts.envFile, dir, { interactive: isInteractive(opts) });
      const extraEnv = envFilePath ? parseEnvFile(envFilePath) : undefined;
      const { tarPath, sha256, sizeBytes } = makeTarball(dir);

      const app = (await apiRequest("POST", "/v1/apps", { name: opts.name })) as App;
      await updateAppConfig(app.id, dir, { json: Boolean(opts.json), extraEnv });
      if (envFilePath && !opts.json) {
        console.log(`  Applied env from ${envFilePath} (${Object.keys(extraEnv || {}).length} vars)`);
      }
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
  .option("--env-file <path>", "Load environment variables from a .env file")
  .option("--yes", "Skip prompts and apply defaults", false)
  .option("--force", "Continue even if preflight has required items", false)
  .option("--wait", "Wait for deployment to be running", true)
  .option("--wait-timeout <seconds>", "Wait timeout in seconds (default: 300)", "300")
  .option("--wait-interval <seconds>", "Wait poll interval in seconds (default: 2)", "2")
  .option("--dry-run", "Show plan without executing", false)
  .option("--json", "Output JSON", false)
  .action(async (opts) => {
    try {
      const interactive = isInteractive(opts);
      const dir = await resolveProjectPath(opts.path, { interactive });
      const appName = await resolveAppName(opts.name, dir, { interactive });
      const useDefaults = await resolveUseDefaults(opts.yes, { interactive });
      const envFilePath = await resolveEnvFile(opts.envFile, dir, { interactive });
      const extraEnv = envFilePath ? parseEnvFile(envFilePath) : undefined;

      // Step 1: Analyze
      if (!opts.json) console.log("\n[1/5] Analyzing project...");
      const analysis = analyzeProject(dir);

      if (opts.json && opts.dryRun) {
        const dockerfile = generateDockerfile(analysis);
        const hostConfig = generateHostConfig(analysis);
        const preflight = buildPreflightChecklist(dir, analysis, extraEnv);
        printJson({
          analysis,
          dockerfile: dockerfile ? { name: dockerfile.name, content: dockerfile.content } : null,
          hostConfig,
          appName,
          preflight,
          dryRun: true,
        });
        return;
      }

      const preflight = buildPreflightChecklist(dir, analysis, extraEnv);
      if (!opts.json) {
        console.log(`    Framework: ${analysis.framework?.name || "(not detected)"}`);
        const sqliteMeta = getSqliteMeta(analysis.database);
        const dbPath = sqliteMeta.path ? ` path=${sqliteMeta.path}` : "";
        const dbEnv = sqliteMeta.envVar ? ` env=${sqliteMeta.envVar}` : "";
        console.log(`    Database: ${analysis.database?.type || "(none)"}${dbPath}${dbEnv}`);
        console.log(`    Port: ${analysis.port}`);
        if (analysis.framework && ["nextjs", "express", "fastify", "hono", "nestjs", "nodejs"].includes(analysis.framework.name)) {
          console.log(`    Node base image: ${analysis.nodeBaseImage}`);
          if (analysis.nativeNodeDeps.length > 0) {
            console.log(`    Native deps:     ${analysis.nativeNodeDeps.join(", ")}`);
          }
        }
        if (analysis.healthChecks.length > 0) {
          console.log("    Health:");
          for (const check of analysis.healthChecks) {
            const label = check.level === "warning" ? "WARN" : "INFO";
            const detail = check.detail ? ` — ${check.detail}` : "";
            console.log(`      - [${label}] ${check.message}${detail}`);
          }
        }
        printPreflightChecklist(preflight, { showOkSummary: true });
      if (interactive && analysis.usesPrisma && usesRuntimePrisma(dir) && analysis.dockerfile.exists) {
        const dockerfilePath = join(dir, "Dockerfile");
        if (!dockerfileRunnerHasNodeModules(dockerfilePath)) {
          const answer = (await promptLine(
            "    Runtime Prisma detected. Copy full node_modules into runner stage? (Y/n): "
          ))
            .trim()
            .toLowerCase();
          if (answer === "" || answer === "y" || answer === "yes") {
            const updated = addRunnerNodeModulesCopy(dockerfilePath);
            if (updated && !opts.json) {
              console.log("    Updated Dockerfile to copy node_modules into runner");
            }
          }
        }
      }
      if (interactive && analysis.framework?.name === "nextjs") {
        const configPath = findNextConfigPath(dir);
        if (configPath) {
          const content = readFileSync(configPath, "utf8");
          if (!hasStandaloneOutputConfig(content)) {
            const answer = (await promptLine(
              `    Add output: "standalone" to ${basename(configPath)}? (Y/n): `
            ))
              .trim()
              .toLowerCase();
            if (answer === "" || answer === "y" || answer === "yes") {
              const updated = applyStandaloneOutputConfig(configPath);
              if (updated && !opts.json) {
                console.log("    Updated Next.js config for standalone output");
              }
            }
          }
        }
      }
      if (interactive && analysis.usesPrisma && analysis.dockerfile.exists) {
        const dockerfilePath = join(dir, "Dockerfile");
        if (!dockerfileHasPrismaGenerate(dockerfilePath)) {
          const answer = (await promptLine("    Add prisma generate steps to Dockerfile? (Y/n): "))
            .trim()
            .toLowerCase();
          if (answer === "" || answer === "y" || answer === "yes") {
            const updated = applyPrismaDockerfileUpdates(dockerfilePath);
            if (updated && !opts.json) {
              console.log("    Updated Dockerfile with prisma generate");
            }
          }
        }
      }
        const ignoreSuggestions = detectUplinkIgnoreSuggestions(dir, analysis);
        const uplinkIgnorePath = join(dir, ".uplinkignore");
        if (!existsSync(uplinkIgnorePath) && ignoreSuggestions.length > 0) {
          console.log(`    Uplinkignore: missing`);
          console.log(`      Suggested: ${ignoreSuggestions.join(", ")}`);
        } else {
          console.log(`    Uplinkignore: ${existsSync(uplinkIgnorePath) ? "exists" : "missing"}`);
        }
      }

      const hasRequiredPreflight = preflight.some((item) => item.level === "required");
      if (hasRequiredPreflight && !opts.force) {
        if (!opts.json) {
          console.log("\nRequired preflight items detected.");
          console.log("Resolve them first or re-run with --force to continue anyway.");
        }
        if (!interactive || opts.json) return;
        const answer = (await promptLine("Continue anyway? (y/N): ")).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") {
          return;
        }
      }

      if (opts.dryRun) {
        console.log("\n[Dry run] Would create:");
        if (!analysis.dockerfile.exists) console.log("  - Dockerfile");
        if (!analysis.hostConfig.exists) console.log("  - uplink.host.json");
        console.log(`  - App: ${appName}`);
        console.log("  - Deploy and wait for running status");
        return;
      }

      if (!analysis.hostConfig.exists) {
        const ignoreSuggestions = detectUplinkIgnoreSuggestions(dir, analysis);
        const uplinkIgnorePath = join(dir, ".uplinkignore");
        if (!existsSync(uplinkIgnorePath) && ignoreSuggestions.length > 0) {
          if (useDefaults) {
            writeUplinkIgnore(dir, ignoreSuggestions);
            if (!opts.json) console.log("    Created .uplinkignore");
          } else {
            const shouldCreate = (await promptLine(`Create .uplinkignore with suggested entries? (Y/n): `))
              .trim()
              .toLowerCase();
            if (shouldCreate === "" || shouldCreate === "y" || shouldCreate === "yes") {
              writeUplinkIgnore(dir, ignoreSuggestions);
              if (!opts.json) console.log("    Created .uplinkignore");
            }
          }
        }
      }

      // Step 2: Generate Dockerfile
      if (!analysis.dockerfile.exists) {
        if (analysis.nativeNodeDeps.length > 0) {
          const choice = useDefaults
            ? "y"
            : (await promptLine(
                `Detected native deps (${analysis.nativeNodeDeps.join(", ")}). Use Debian base image? (Y/n): `
              ))
                .trim()
                .toLowerCase();
          if (choice === "" || choice === "y" || choice === "yes") {
            analysis.nodeBaseImage = "debian";
          } else {
            analysis.nodeBaseImage = "alpine";
          }
        }
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
        const configPath = findNextConfigPath(dir);
        if (configPath) {
          const content = readFileSync(configPath, "utf8");
          if (!hasStandaloneOutputConfig(content)) {
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
      let nextAuthOverrides: Record<string, string> | undefined;
      if (interactive && !opts.json && analysis.usesNextAuth) {
        const hostEnv = readHostConfig(dir)?.env;
        const nextAuthStatus = resolveNextAuthEnvStatus(analysis, extraEnv, hostEnv);
        nextAuthOverrides = {};
        if (nextAuthStatus.needsUrl || nextAuthStatus.urlIsLocal) {
          const reason = nextAuthStatus.needsUrl
            ? "NEXTAUTH_URL is missing"
            : `NEXTAUTH_URL points to ${nextAuthStatus.url}`;
          const answer = (await promptLine(
            `    ${reason}. Set NEXTAUTH_URL to ${app.url}? (Y/n): `
          ))
            .trim()
            .toLowerCase();
          if (answer === "" || answer === "y" || answer === "yes") {
            nextAuthOverrides.NEXTAUTH_URL = app.url;
          }
        }
        if (nextAuthStatus.needsSecret) {
          const secret = (await promptLine("    Enter NEXTAUTH_SECRET (leave blank to skip): ")).trim();
          if (secret) {
            nextAuthOverrides.NEXTAUTH_SECRET = secret;
          }
        }
        if (Object.keys(nextAuthOverrides).length === 0) nextAuthOverrides = undefined;
      }
      const mergedExtraEnv = mergeEnv(extraEnv, nextAuthOverrides);
      await updateAppConfig(app.id, dir, { json: Boolean(opts.json), extraEnv: mergedExtraEnv });
      if (envFilePath && !opts.json) {
        console.log(`    Applied env from ${envFilePath} (${Object.keys(extraEnv || {}).length} vars)`);
      }
      if (nextAuthOverrides && !opts.json) {
        console.log(`    Applied NextAuth env overrides (${Object.keys(nextAuthOverrides).length} vars)`);
      }

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
      };      if (opts.wait) {
        const timeoutMs = Math.max(5, Number(opts.waitTimeout || 300)) * 1000;
        const intervalMs = Math.max(1, Number(opts.waitInterval || 2)) * 1000;
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