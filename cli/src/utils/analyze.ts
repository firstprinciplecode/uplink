import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";

export interface FrameworkInfo {
  name: string;
  version?: string;
}

export interface DatabaseInfo {
  type: "sqlite" | "postgres" | "mysql" | "mongodb" | "prisma" | "unknown";
  file?: string;
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

export interface AnalysisResult {
  framework: FrameworkInfo | null;
  packageManager: "npm" | "yarn" | "pnpm" | "bun" | null;
  database: DatabaseInfo | null;
  storage: StorageInfo[];
  port: number;
  dockerfile: { exists: boolean; path?: string };
  hostConfig: { exists: boolean; path?: string; config?: any };
  requirements: Requirement[];
}

function readJsonSafe(path: string): any | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
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

export function detectDatabase(dir: string): DatabaseInfo | null {
  const pkgPath = join(dir, "package.json");
  const pkg = readJsonSafe(pkgPath);

  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    // SQLite
    if (deps["better-sqlite3"] || deps["sqlite3"] || deps["sql.js"]) {
      // Look for .db files
      const dbFiles = findFiles(dir, (name) => name.endsWith(".db") || name.endsWith(".sqlite"));
      const dbFile = dbFiles.length > 0 ? basename(dbFiles[0]) : undefined;
      return {
        type: "sqlite",
        file: dbFile,
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

export function analyzeProject(dir: string): AnalysisResult {
  const framework = detectFramework(dir);
  const packageManager = detectPackageManager(dir);
  const database = detectDatabase(dir);
  const storage = detectStorage(dir);
  const port = detectPort(dir);

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

  // Build requirements
  const requirements: Requirement[] = [];

  if (!dockerfile.exists) {
    requirements.push({
      type: "dockerfile",
      reason: "No Dockerfile found — required for deployment",
    });
  }

  if (!hostConfig.exists) {
    requirements.push({
      type: "host_config",
      reason: "No uplink.host.json found — will be generated",
    });
  }

  if (database?.type === "sqlite") {
    requirements.push({
      type: "persistent_volume",
      reason: `SQLite database detected${database.file ? ` (${database.file})` : ""}`,
      path: "/data",
    });
    requirements.push({
      type: "env_var",
      name: "DATABASE_PATH",
      suggested: "/data/app.db",
      reason: "Database path for persistent storage",
    });
  }

  for (const s of storage) {
    requirements.push({
      type: "persistent_volume",
      reason: s.reason,
      path: `/data/${s.path}`,
    });
  }

  return {
    framework,
    packageManager,
    database,
    storage,
    port,
    dockerfile,
    hostConfig,
    requirements,
  };
}
