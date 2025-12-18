import { logger } from "./logger";

interface Config {
  port: number;
  databaseUrl: string;
  neonApiKey?: string;
  neonProjectId?: string;
  tunnelDomain: string;
  adminTokens: string[];
  dbLimitPerUser: number;
  logLevel: string;
}

function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Required environment variable ${key} is not set`);
  }
  return value;
}

function getOptionalEnv(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

function getOptionalNumberEnv(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (!value) return defaultValue;
  const num = Number(value);
  if (isNaN(num)) {
    logger.warn(`Invalid number for ${key}, using default: ${defaultValue}`);
    return defaultValue;
  }
  return num;
}

export function validateConfig(): Config {
  const config: Config = {
    port: getOptionalNumberEnv("PORT", 4000),
    databaseUrl: getOptionalEnv(
      "CONTROL_PLANE_DATABASE_URL",
      "sqlite:./data/control-plane.db"
    ),
    neonApiKey: process.env.NEON_API_KEY,
    neonProjectId: process.env.NEON_PROJECT_ID,
    tunnelDomain: getOptionalEnv("TUNNEL_DOMAIN", "t.uplink.spot"),
    adminTokens: (process.env.ADMIN_TOKENS || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    dbLimitPerUser: getOptionalNumberEnv("DB_LIMIT_PER_USER", 5),
    logLevel: getOptionalEnv("LOG_LEVEL", process.env.NODE_ENV === "production" ? "info" : "debug"),
  };

  // Validate Neon config if using Neon provider
  const isSqlite = config.databaseUrl.startsWith("sqlite:");
  if (!isSqlite && !config.neonApiKey) {
    logger.warn("NEON_API_KEY not set - database provisioning will not work");
  }
  if (!isSqlite && !config.neonProjectId) {
    logger.warn("NEON_PROJECT_ID not set - database provisioning will not work");
  }

  logger.info({
    event: "config.validated",
    port: config.port,
    databaseType: isSqlite ? "sqlite" : "postgres",
    tunnelDomain: config.tunnelDomain,
    hasNeonConfig: !!(config.neonApiKey && config.neonProjectId),
  });

  return config;
}

export const config = validateConfig();

