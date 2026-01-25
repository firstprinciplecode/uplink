import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, basename, isAbsolute, dirname } from "path";

export interface FrameworkInfo {
  name: string;
  version?: string;
}

export interface DatabaseInfo {
  type: "sqlite" | "postgres" | "mysql" | "mongodb" | "prisma" | "unknown";
  file?: string;
  path?: string;
  envVar?: string;
  pathSource?: "literal" | "env" | "cwd" | "unknown" | "prompt" | "default";
  reason: string;
}

export interface StorageInfo {
  path: string;
  reason: string;
}

export interface Requirement {
  type: "persistent_volume" | "env_var" | "dockerfile" | "host_config";
  reason: string;
  path?: string;
  name?: string;
  suggested?: string;
}

export interface HealthCheck {
  level: "info" | "warning";
  message: string;
  detail?: string;
}

export interface AnalysisResult {
  framework: FrameworkInfo | null;
  packageManager: "npm" | "yarn" | "pnpm" | "bun" | null;
  database: DatabaseInfo | null;
  storage: StorageInfo[];
  port: number;
  dockerfile: { exists: boolean; path?: string };
  hostConfig: { exists: boolean; path?: string; config?: any };
  requirements: Requirement[];
  healthChecks: HealthCheck[];
  nativeNodeDeps: string[];
  nodeBaseImage: "alpine" | "debian";
  usesPrisma: boolean;
  usesNextAuth: boolean;
}

function readJsonSafe(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function readEnvFile(path: string): Record<string, string> | null {
  try {
    const raw = readFileSync(path, "utf8");
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
  } catch {
    return null;
  }
}

function readPackageDeps(dir: string): Record<string, string> {
  const pkgPath = join(dir, "package.json");
  const pkg = readJsonSafe(pkgPath);
  if (!pkg) return {};
  return { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
}

function detectUsesPrisma(dir: string): boolean {
  const deps = readPackageDeps(dir);
  return Boolean(deps["@prisma/client"] || deps["prisma"]);
}

function detectUsesNextAuth(dir: string): boolean {
  const deps = readPackageDeps(dir);
  return Boolean(deps["next-auth"] || deps["@auth/core"] || deps["@auth/nextjs"]);
}

function readHostEnv(analysis: AnalysisResult): Record<string, string> {
  const raw = analysis.hostConfig?.config?.env;
  if (!raw || typeof raw !== "object") return {};
  return Object.fromEntries(
    Object.entries(raw).filter(([, value]) => typeof value === "string")
  ) as Record<string, string>;
}

function isLocalhostUrl(value: string): boolean {
  return (
    value.includes("://localhost") ||
    value.includes("://127.0.0.1") ||
    value.includes("://0.0.0.0")
  );
}

function fileContains(path: string, patterns: string[]): string | null {
  try {
    const content = readFileSync(path, "utf8");
    for (const pattern of patterns) {
      if (content.includes(pattern)) return pattern;
    }
  } catch {}
  return null;
}

function findFiles(dir: string, predicate: (name: string) => boolean, maxDepth = 3): string[] {
  const results: string[] = [];
  function walk(current: string, depth: number) {
    if (depth > maxDepth) return;
    try {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (entry.isFile() && predicate(entry.name)) {
          results.push(fullPath);
        }
      }
    } catch {}
  }
  walk(dir, 0);
  return results;
}

function detectSqlitePath(
  dir: string
): { path?: string; envVar?: string; pathSource?: DatabaseInfo["pathSource"] } {
  const sourceFiles = findFiles(dir, (name) => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name), 3);

  for (const filePath of sourceFiles) {
    let content = "";
    try {
      content = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }

    const envFallbackMatch = content.match(
      /const\s+\w+\s*=\s*process\.env\.([A-Z0-9_]+)\s*\|\|\s*path\.join\(\s*process\.cwd\(\)\s*,\s*["'`]([^"'`]+)["'`]\s*\)/m
    );
    if (envFallbackMatch) {
      return { envVar: envFallbackMatch[1], path: envFallbackMatch[2], pathSource: "env" };
    }

    const envDirectMatch = content.match(/new\s+Database\(\s*process\.env\.([A-Z0-9_]+)\s*\)/m);
    if (envDirectMatch) {
      return { envVar: envDirectMatch[1], pathSource: "env" };
    }

    const cwdAssignMatch = content.match(
      /const\s+(\w+)\s*=\s*path\.join\(\s*process\.cwd\(\)\s*,\s*["'`]([^"'`]+)["'`]\s*\)/m
    );
    if (cwdAssignMatch) {
      const varName = cwdAssignMatch[1];
      const fileName = cwdAssignMatch[2];
      const dbVarUse = new RegExp(`new\\s+Database\\(\\s*${varName}\\s*\\)`).test(content);
      if (dbVarUse) {
        return { path: fileName, pathSource: "cwd" };
      }
    }

    const literalMatch = content.match(/new\s+Database\(\s*["'`]([^"'`]+)["'`]\s*\)/m);
    if (literalMatch) {
      return { path: literalMatch[1], pathSource: "literal" };
    }
  }

  return { pathSource: "unknown" };
}

export function detectFramework(dir: string): FrameworkInfo | null {
  const pkgPath = join(dir, "package.json");
  const pkg = readJsonSafe(pkgPath);

  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    // Next.js
    if (deps["next"]) {
      return { name: "nextjs", version: deps["next"]?.replace(/[\^~]/, "") };
    }
    // Express
    if (deps["express"]) {
      return { name: "express", version: deps["express"]?.replace(/[\^~]/, "") };
    }
    // Fastify
    if (deps["fastify"]) {
      return { name: "fastify", version: deps["fastify"]?.replace(/[\^~]/, "") };
    }
    // Hono
    if (deps["hono"]) {
      return { name: "hono", version: deps["hono"]?.replace(/[\^~]/, "") };
    }
    // Nest.js
    if (deps["@nestjs/core"]) {
      return { name: "nestjs", version: deps["@nestjs/core"]?.replace(/[\^~]/, "") };
    }
    // Generic Node.js
    if (pkg.main || pkg.scripts?.start) {
      return { name: "nodejs", version: undefined };
    }
  }

  // Python
  if (existsSync(join(dir, "requirements.txt")) || existsSync(join(dir, "pyproject.toml"))) {
    const reqPath = join(dir, "requirements.txt");
    if (existsSync(reqPath)) {
      const content = readFileSync(reqPath, "utf8");
      if (content.includes("django")) return { name: "django" };
      if (content.includes("flask")) return { name: "flask" };
      if (content.includes("fastapi")) return { name: "fastapi" };
    }
    return { name: "python" };
  }

  // Go
  if (existsSync(join(dir, "go.mod"))) {
    return { name: "go" };
  }

  // Rust
  if (existsSync(join(dir, "Cargo.toml"))) {
    return { name: "rust" };
  }

  return null;
}

export function detectPackageManager(dir: string): "npm" | "yarn" | "pnpm" | "bun" | null {
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  if (existsSync(join(dir, "bun.lockb"))) return "bun";
  if (existsSync(join(dir, "package-lock.json"))) return "npm";
  if (existsSync(join(dir, "package.json"))) return "npm";
  return null;
}

function detectNativeNodeDeps(dir: string): string[] {
  const pkgPath = join(dir, "package.json");
  const pkg = readJsonSafe(pkgPath);
  if (!pkg) return [];

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const knownNativeDeps = new Set([
    "lightningcss",
    "sharp",
    "better-sqlite3",
    "sqlite3",
    "bcrypt",
    "bcryptjs",
    "argon2",
    "canvas",
    "node-sass",
    "playwright",
    "puppeteer",
  ]);

  return Object.keys(deps || {}).filter((name) => knownNativeDeps.has(name));
}

export function detectDatabase(dir: string): DatabaseInfo | null {
  const pkgPath = join(dir, "package.json");
  const pkg = readJsonSafe(pkgPath);

  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    // SQLite
    if (deps["better-sqlite3"] || deps["sqlite3"] || deps["sql.js"]) {
      const sqlitePath = detectSqlitePath(dir);
      // Look for .db files
      const dbFiles = findFiles(dir, (name) => name.endsWith(".db") || name.endsWith(".sqlite"));
      const dbFile = dbFiles.length > 0 ? basename(dbFiles[0]) : undefined;
      return {
        type: "sqlite",
        file: dbFile,
        path: sqlitePath.path,
        envVar: sqlitePath.envVar,
        pathSource: sqlitePath.pathSource,
        reason: `SQLite dependency detected${dbFile ? ` (${dbFile})` : ""}`,
      };
    }

    // Postgres
    if (deps["pg"] || deps["postgres"] || deps["@neondatabase/serverless"]) {
      return { type: "postgres", reason: "PostgreSQL dependency detected" };
    }

    // MySQL
    if (deps["mysql2"] || deps["mysql"]) {
      return { type: "mysql", reason: "MySQL dependency detected" };
    }

    // MongoDB
    if (deps["mongodb"] || deps["mongoose"]) {
      return { type: "mongodb", reason: "MongoDB dependency detected" };
    }

    // Prisma (check schema for provider)
    if (deps["@prisma/client"] || deps["prisma"]) {
      const schemaPath = join(dir, "prisma", "schema.prisma");
      if (existsSync(schemaPath)) {
        const content = readFileSync(schemaPath, "utf8");
        if (content.includes('provider = "sqlite"')) {
          return { type: "sqlite", reason: "Prisma with SQLite detected" };
        }
        if (content.includes('provider = "postgresql"')) {
          return { type: "postgres", reason: "Prisma with PostgreSQL detected" };
        }
        if (content.includes('provider = "mysql"')) {
          return { type: "mysql", reason: "Prisma with MySQL detected" };
        }
      }
      return { type: "prisma", reason: "Prisma detected" };
    }

    // Drizzle
    if (deps["drizzle-orm"]) {
      return { type: "unknown", reason: "Drizzle ORM detected (check drizzle config for provider)" };
    }
  }

  // Check for .db files even without dependencies
  const dbFiles = findFiles(dir, (name) => name.endsWith(".db") || name.endsWith(".sqlite"));
  if (dbFiles.length > 0) {
    return {
      type: "sqlite",
      file: basename(dbFiles[0]),
      reason: `SQLite database file found (${basename(dbFiles[0])})`,
    };
  }

  return null;
}

export function detectStorage(dir: string): StorageInfo[] {
  const storage: StorageInfo[] = [];

  // Common upload directories
  const uploadDirs = ["public/uploads", "uploads", "storage", "files", "media"];
  for (const uploadDir of uploadDirs) {
    const fullPath = join(dir, uploadDir);
    if (existsSync(fullPath) && statSync(fullPath).isDirectory()) {
      storage.push({ path: uploadDir, reason: `Upload directory found (${uploadDir})` });
    }
  }

  // Check for multer or file upload dependencies
  const pkgPath = join(dir, "package.json");
  const pkg = readJsonSafe(pkgPath);
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps["multer"] || deps["formidable"] || deps["busboy"]) {
      if (storage.length === 0) {
        storage.push({ path: "uploads", reason: "File upload library detected (multer/formidable)" });
      }
    }
  }

  return storage;
}

export function detectPort(dir: string): number {
  // Check uplink.host.json
  const hostConfigPath = join(dir, "uplink.host.json");
  const hostConfig = readJsonSafe(hostConfigPath);
  if (hostConfig?.port && typeof hostConfig.port === "number") {
    return hostConfig.port;
  }

  // Check package.json scripts for PORT
  const pkgPath = join(dir, "package.json");
  const pkg = readJsonSafe(pkgPath);
  if (pkg?.scripts?.start) {
    const portMatch = pkg.scripts.start.match(/PORT[=:](\d+)/);
    if (portMatch) return Number(portMatch[1]);
  }

  // Check for common framework defaults
  const framework = detectFramework(dir);
  if (framework) {
    // Next.js, Create React App default to 3000
    if (["nextjs", "nodejs", "express", "fastify"].includes(framework.name)) return 3000;
    // Django defaults to 8000
    if (framework.name === "django") return 8000;
    // Flask defaults to 5000
    if (framework.name === "flask") return 5000;
    // FastAPI defaults to 8000
    if (framework.name === "fastapi") return 8000;
    // Go apps often use 8080
    if (framework.name === "go") return 8080;
  }

  return 3000; // Default
}

function detectHealthChecks(dir: string, analysis: AnalysisResult): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const pkgPath = join(dir, "package.json");
  const pkg = readJsonSafe(pkgPath);

  if (!pkg) {
    checks.push({
      level: "warning",
      message: "No package.json found",
      detail: "Node apps typically require package.json with scripts and dependencies.",
    });
  } else {
    const scripts = pkg.scripts || {};
    if (!scripts.start) {
      checks.push({
        level: "warning",
        message: "No start script in package.json",
        detail: "Add a start script so the container knows how to run the app.",
      });
    }
    if (analysis.framework?.name === "nextjs" && !scripts.build) {
      checks.push({
        level: "warning",
        message: "No build script for Next.js",
        detail: "Add a build script (e.g. next build) for Docker builds.",
      });
    }

    const hasLockfile =
      existsSync(join(dir, "package-lock.json")) ||
      existsSync(join(dir, "pnpm-lock.yaml")) ||
      existsSync(join(dir, "yarn.lock")) ||
      existsSync(join(dir, "bun.lockb"));
    if (!hasLockfile) {
      checks.push({
        level: "info",
        message: "No lockfile detected",
        detail: "Lockfiles improve reproducible builds on the builder.",
      });
    }
  }

  if (analysis.framework?.name === "nextjs" && !analysis.dockerfile.exists) {
    const nextConfigPath = join(dir, "next.config.ts");
    const nextConfigJsPath = join(dir, "next.config.js");
    const nextConfigMjsPath = join(dir, "next.config.mjs");
    const configPath = existsSync(nextConfigPath)
      ? nextConfigPath
      : existsSync(nextConfigJsPath)
        ? nextConfigJsPath
        : existsSync(nextConfigMjsPath)
          ? nextConfigMjsPath
          : null;
    if (configPath) {
      const content = readFileSync(configPath, "utf8");
      if (!/output\s*:\s*["']standalone["']/.test(content)) {
        checks.push({
          level: "info",
          message: "Next.js config missing output: \"standalone\"",
          detail: "Standalone builds are recommended for smaller Docker images.",
        });
      }
    }
  }

  if (analysis.framework?.name === "nextjs" && analysis.dockerfile.exists) {
    const nextConfigPath = join(dir, "next.config.ts");
    const nextConfigJsPath = join(dir, "next.config.js");
    const nextConfigMjsPath = join(dir, "next.config.mjs");
    const configPath = existsSync(nextConfigPath)
      ? nextConfigPath
      : existsSync(nextConfigJsPath)
        ? nextConfigJsPath
        : existsSync(nextConfigMjsPath)
          ? nextConfigMjsPath
          : null;
    if (configPath) {
      const content = readFileSync(configPath, "utf8");
      if (!/output\s*:\s*["']standalone["']/.test(content)) {
        checks.push({
          level: "warning",
          message: "Next.js output missing standalone build config",
          detail: "Dockerfile expects .next/standalone; add output: \"standalone\".",
        });
      }
    }
  }

  if (analysis.usesPrisma) {
    const schemaPath = join(dir, "prisma", "schema.prisma");
    if (!existsSync(schemaPath)) {
      checks.push({
        level: "warning",
        message: "Prisma detected but schema.prisma is missing",
        detail: "Ensure prisma/schema.prisma exists for generate and migrations.",
      });
    }
    if (analysis.dockerfile.exists) {
      const dockerfilePath = join(dir, "Dockerfile");
      const hasGenerate = fileContains(dockerfilePath, ["prisma generate"]);
      if (!hasGenerate) {
        checks.push({
          level: "warning",
          message: "Prisma detected but Dockerfile lacks prisma generate",
          detail: "Add `npx prisma generate` after dependency install.",
        });
      }
    } else {
      checks.push({
        level: "info",
        message: "Prisma detected; ensure Dockerfile runs prisma generate",
        detail: "Generated Dockerfile will include prisma generate when enabled.",
      });
    }
  }

  if (analysis.usesNextAuth) {
    const envFilePath = join(dir, ".env");
    const envFile = existsSync(envFilePath) ? readEnvFile(envFilePath) : null;
    const hostEnv = readHostEnv(analysis);
    const nextAuthUrl = hostEnv.NEXTAUTH_URL || envFile?.NEXTAUTH_URL || "";
    const nextAuthSecret = hostEnv.NEXTAUTH_SECRET || envFile?.NEXTAUTH_SECRET || "";
    if (!nextAuthUrl) {
      checks.push({
        level: "warning",
        message: "NextAuth detected but NEXTAUTH_URL is missing",
        detail: "Set NEXTAUTH_URL to your app URL in env or host config.",
      });
    } else if (isLocalhostUrl(nextAuthUrl)) {
      checks.push({
        level: "warning",
        message: "NEXTAUTH_URL points to localhost",
        detail: "Use the public app URL to avoid auth callback 401s.",
      });
    }
    if (!nextAuthSecret) {
      checks.push({
        level: "warning",
        message: "NextAuth detected but NEXTAUTH_SECRET is missing",
        detail: "Set NEXTAUTH_SECRET for secure session handling.",
      });
    }
  }

  if (analysis.nativeNodeDeps.length > 0) {
    checks.push({
      level: "warning",
      message: "Native Node.js deps detected; Alpine may fail to build",
      detail: `Deps: ${analysis.nativeNodeDeps.join(", ")}`,
    });
  }

  return checks;
}

export function analyzeProject(dir: string): AnalysisResult {
  const framework = detectFramework(dir);
  const packageManager = detectPackageManager(dir);
  const database = detectDatabase(dir);
  const storage = detectStorage(dir);
  const port = detectPort(dir);
  const nativeNodeDeps = detectNativeNodeDeps(dir);
  const nodeBaseImage = nativeNodeDeps.length > 0 ? "debian" : "alpine";
  const usesPrisma = detectUsesPrisma(dir);
  const usesNextAuth = detectUsesNextAuth(dir);

  const dockerfilePath = join(dir, "Dockerfile");
  const dockerfile = {
    exists: existsSync(dockerfilePath),
    path: existsSync(dockerfilePath) ? "Dockerfile" : undefined,
  };

  const hostConfigPath = join(dir, "uplink.host.json");
  const hostConfigData = readJsonSafe(hostConfigPath);
  const hostConfig = {
    exists: existsSync(hostConfigPath),
    path: existsSync(hostConfigPath) ? "uplink.host.json" : undefined,
    config: hostConfigData,
  };

  const analysis: AnalysisResult = {
    framework,
    packageManager,
    database,
    storage,
    port,
    dockerfile,
    hostConfig,
    requirements: [],
    healthChecks: [],
    nativeNodeDeps,
    nodeBaseImage,
    usesPrisma,
    usesNextAuth,
  };

  analysis.requirements = buildRequirements(analysis);
  analysis.healthChecks = detectHealthChecks(dir, analysis);
  return analysis;
}

export function buildRequirements(analysis: AnalysisResult): Requirement[] {
  const requirements: Requirement[] = [];

  if (!analysis.dockerfile.exists) {
    requirements.push({
      type: "dockerfile",
      reason: "No Dockerfile found — required for deployment",
    });
  }

  if (!analysis.hostConfig.exists) {
    requirements.push({
      type: "host_config",
      reason: "No uplink.host.json found — will be generated",
    });
  }

  if (analysis.database?.type === "sqlite") {
    const usingPrisma = analysis.usesPrisma;
    const dbPath = analysis.database.path;
    const envVar = analysis.database.envVar;
    const defaultEnvVar = usingPrisma ? "DATABASE_URL" : "DATABASE_PATH";
    const defaultSuggested = usingPrisma ? "file:/data/app.db" : "/data/app.db";
    if (dbPath) {
      const volumePath = isAbsolute(dbPath) ? dirname(dbPath) : "/app";
      requirements.push({
        type: "persistent_volume",
        reason: `SQLite database path detected (${dbPath})`,
        path: volumePath,
      });
    } else {
      requirements.push({
        type: "persistent_volume",
        reason: `SQLite database detected${analysis.database.file ? ` (${analysis.database.file})` : ""}`,
        path: "/data",
      });
    }

    if (envVar) {
      requirements.push({
        type: "env_var",
        name: envVar,
        suggested: dbPath || defaultSuggested,
        reason: "Database path env var detected",
      });
    } else if (!dbPath) {
      requirements.push({
        type: "env_var",
        name: defaultEnvVar,
        suggested: defaultSuggested,
        reason: "Database path for persistent storage",
      });
    }
  }

  for (const s of analysis.storage) {
    requirements.push({
      type: "persistent_volume",
      reason: s.reason,
      path: `/data/${s.path}`,
    });
  }

  return requirements;
}
