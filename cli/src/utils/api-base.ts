import { homedir } from "os";
import { join } from "path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { createInterface } from "readline";

export const DEFAULT_API_BASE = "https://api.uplink.spot";

type ApiConfig = {
  apiBase?: string;
};

export function isLocalApiBase(apiBase: string): boolean {
  return (
    apiBase.includes("://localhost") ||
    apiBase.includes("://127.0.0.1") ||
    apiBase.includes("://0.0.0.0")
  );
}

export function normalizeApiBase(input: string | undefined | null): string | null {
  if (!input) return null;
  let value = String(input).trim();
  if (!value) return null;
  if (!value.includes("://")) {
    value = `https://${value}`;
  }
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function parseTokenEnv(raw?: string | null): { token?: string; apiBase?: string } {
  if (!raw) return {};
  const idx = raw.lastIndexOf("@");
  if (idx <= 0) return { token: raw };
  const token = raw.slice(0, idx);
  const maybeBase = raw.slice(idx + 1);
  const apiBase = normalizeApiBase(maybeBase);
  if (!apiBase) return { token: raw };
  return { token, apiBase };
}

function getConfigPath(): string {
  return join(homedir(), ".uplink", "config.json");
}

export function readApiBaseConfig(): string | null {
  try {
    const configPath = getConfigPath();
    if (!existsSync(configPath)) return null;
    const raw = readFileSync(configPath, "utf-8");
    const parsed = JSON.parse(raw) as ApiConfig;
    return normalizeApiBase(parsed.apiBase) ?? null;
  } catch {
    return null;
  }
}

export function writeApiBaseConfig(apiBase: string): void {
  const normalized = normalizeApiBase(apiBase);
  if (!normalized) return;
  const configPath = getConfigPath();
  const configDir = join(homedir(), ".uplink");
  mkdirSync(configDir, { recursive: true });
  const contents: ApiConfig = { apiBase: normalized };
  writeFileSync(configPath, JSON.stringify(contents, null, 2), "utf-8");
}

export function getResolvedApiBase(): string {
  const envBase = normalizeApiBase(process.env.AGENTCLOUD_API_BASE);
  if (envBase) return envBase;
  const parsedToken = parseTokenEnv(process.env.AGENTCLOUD_TOKEN);
  if (parsedToken.apiBase) return parsedToken.apiBase;
  const configBase = readApiBaseConfig();
  if (configBase) return configBase;
  return DEFAULT_API_BASE;
}

export function getResolvedApiToken(apiBase: string): string | undefined {
  const parsedToken = parseTokenEnv(process.env.AGENTCLOUD_TOKEN);
  if (parsedToken.token) return parsedToken.token;
  if (isLocalApiBase(apiBase)) {
    return process.env.AGENTCLOUD_TOKEN_DEV || undefined;
  }
  return undefined;
}

export function formatTokenForEnv(token: string, apiBase: string): string {
  if (apiBase === DEFAULT_API_BASE) return token;
  return `${token}@${apiBase}`;
}

function promptLine(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function promptForApiBase(): Promise<string> {
  process.stdout.write("\nSelect API base:\n");
  process.stdout.write(`  1) ${DEFAULT_API_BASE} (hosted)\n`);
  process.stdout.write("  2) Custom\n");
  const choice = (await promptLine("Choose [1/2] (default 1): ")).trim().toLowerCase();
  if (choice === "2" || choice === "custom") {
    const raw = (await promptLine("Enter API base URL: ")).trim();
    const normalized = normalizeApiBase(raw);
    if (normalized) return normalized;
    process.stdout.write(`Invalid URL. Using ${DEFAULT_API_BASE}.\n`);
  }
  return DEFAULT_API_BASE;
}

export async function ensureApiBase(options: { interactive: boolean }): Promise<string> {
  const envBase = normalizeApiBase(process.env.AGENTCLOUD_API_BASE);
  if (envBase) return envBase;

  const parsedToken = parseTokenEnv(process.env.AGENTCLOUD_TOKEN);
  if (parsedToken.apiBase) {
    process.env.AGENTCLOUD_API_BASE = parsedToken.apiBase;
    return parsedToken.apiBase;
  }

  const configBase = readApiBaseConfig();
  if (configBase) {
    process.env.AGENTCLOUD_API_BASE = configBase;
    return configBase;
  }

  if (!options.interactive) {
    return DEFAULT_API_BASE;
  }

  const selected = await promptForApiBase();
  writeApiBaseConfig(selected);
  process.env.AGENTCLOUD_API_BASE = selected;
  return selected;
}
