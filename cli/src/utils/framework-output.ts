import { existsSync, readFileSync } from "fs";
import { join } from "path";
import type { FrameworkInfo } from "./analyze";

export type FrameworkOutputMode = "standalone" | "export" | "static" | "unknown";

export type FrameworkOutputInfo = {
  framework: "nextjs" | "vite" | "cra";
  mode: FrameworkOutputMode;
  distDir?: string;
  configPath?: string;
};

export type FrameworkOutputCheck = {
  framework: "nextjs" | "vite" | "cra";
  mode: FrameworkOutputMode;
  expectedPaths: string[];
  summary: string;
  guidance: string[];
};

function findNextConfigPath(dir: string): string | null {
  const nextConfigPath = join(dir, "next.config.ts");
  const nextConfigJsPath = join(dir, "next.config.js");
  const nextConfigMjsPath = join(dir, "next.config.mjs");
  if (existsSync(nextConfigPath)) return nextConfigPath;
  if (existsSync(nextConfigJsPath)) return nextConfigJsPath;
  if (existsSync(nextConfigMjsPath)) return nextConfigMjsPath;
  return null;
}

function parseNextConfigContent(content: string): { mode: FrameworkOutputMode; distDir?: string } {
  const outputMatches = [...content.matchAll(/output\s*:\s*["'](standalone|export)["']/g)];
  const mode = outputMatches.length > 0 ? (outputMatches[outputMatches.length - 1][1] as FrameworkOutputMode) : "unknown";
  const distMatches = [...content.matchAll(/distDir\s*:\s*["']([^"']+)["']/g)];
  const distDir = distMatches.length > 0 ? distMatches[distMatches.length - 1][1] : undefined;
  return { mode, distDir };
}

function detectNextOutput(dir: string): FrameworkOutputInfo {
  const configPath = findNextConfigPath(dir);
  if (!configPath) {
    return { framework: "nextjs", mode: "unknown" };
  }
  const content = readFileSync(configPath, "utf8");
  const parsed = parseNextConfigContent(content);
  return {
    framework: "nextjs",
    mode: parsed.mode,
    distDir: parsed.distDir,
    configPath,
  };
}

function findViteConfigPath(dir: string): string | null {
  const viteTs = join(dir, "vite.config.ts");
  const viteJs = join(dir, "vite.config.js");
  const viteMjs = join(dir, "vite.config.mjs");
  if (existsSync(viteTs)) return viteTs;
  if (existsSync(viteJs)) return viteJs;
  if (existsSync(viteMjs)) return viteMjs;
  return null;
}

function parseViteConfigContent(content: string): { distDir?: string } {
  const outDirMatches = [...content.matchAll(/outDir\s*:\s*["']([^"']+)["']/g)];
  const distDir = outDirMatches.length > 0 ? outDirMatches[outDirMatches.length - 1][1] : undefined;
  return { distDir };
}

function detectViteOutput(dir: string): FrameworkOutputInfo {
  const configPath = findViteConfigPath(dir);
  if (!configPath) {
    return { framework: "vite", mode: "static" };
  }
  const content = readFileSync(configPath, "utf8");
  const parsed = parseViteConfigContent(content);
  return {
    framework: "vite",
    mode: "static",
    distDir: parsed.distDir,
    configPath,
  };
}

function detectCraOutput(): FrameworkOutputInfo {
  return { framework: "cra", mode: "static", distDir: "build" };
}

export function detectFrameworkOutput(
  dir: string,
  framework: FrameworkInfo | null
): FrameworkOutputInfo | null {
  if (!framework) return null;
  if (framework.name === "nextjs") {
    return detectNextOutput(dir);
  }
  if (framework.name === "vite") {
    return detectViteOutput(dir);
  }
  if (framework.name === "cra") {
    return detectCraOutput();
  }
  return null;
}

export function getFrameworkOutputCheck(info: FrameworkOutputInfo | null): FrameworkOutputCheck | null {
  if (!info) return null;
  if (info.framework === "nextjs") {
    const distDir = info.distDir || ".next";
    if (info.mode === "standalone") {
      return {
        framework: "nextjs",
        mode: info.mode,
        expectedPaths: [`${distDir}/standalone`, `${distDir}/static`],
        summary: "Next.js standalone output detected.",
        guidance: [],
      };
    }
    if (info.mode === "export") {
      return {
        framework: "nextjs",
        mode: info.mode,
        expectedPaths: ["out"],
        summary: "Next.js output is set to export.",
        guidance: [
          "Uplink hosting expects a server build by default.",
          "Either set output: \"standalone\" in next.config.*",
          "Or provide a Dockerfile that serves the static out/ directory.",
        ],
      };
    }
    return {
      framework: "nextjs",
      mode: "unknown",
      expectedPaths: [`${distDir}/standalone`, `${distDir}/static`],
      summary: "Next.js output mode not detected.",
      guidance: [
        "Uplink hosting expects output: \"standalone\" by default.",
        "Add output: \"standalone\" to next.config.* for server hosting.",
      ],
    };
  }
  if (info.framework === "vite") {
    const distDir = info.distDir || "dist";
    return {
      framework: "vite",
      mode: "static",
      expectedPaths: [distDir],
      summary: "Vite static build detected.",
      guidance: [
        `Build output is expected in ${distDir}/.`,
        "Provide a Dockerfile that serves the static files (e.g., nginx or a static file server).",
      ],
    };
  }
  if (info.framework === "cra") {
    const distDir = info.distDir || "build";
    return {
      framework: "cra",
      mode: "static",
      expectedPaths: [distDir],
      summary: "Create React App static build detected.",
      guidance: [
        `Build output is expected in ${distDir}/.`,
        "Provide a Dockerfile that serves the static files (e.g., nginx or a static file server).",
      ],
    };
  }
  return null;
}
