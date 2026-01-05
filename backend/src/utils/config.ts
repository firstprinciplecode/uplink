import { logger } from "./logger";

interface Config {
  port: number;
  databaseUrl: string;
  neonApiKey?: string;
  neonProjectId?: string;
  tunnelDomain: string;
  aliasDomain: string;
  hostDomain: string;
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
    tunnelDomain: getOptionalEnv("TUNNEL_DOMAIN", "x.uplink.spot"),
    aliasDomain: getOptionalEnv("ALIAS_DOMAIN", "uplink.spot"),
    hostDomain: getOptionalEnv("HOST_DOMAIN", "host.uplink.spot"),
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

  // Security warnings for production
  const isProduction = process.env.NODE_ENV === "production";
  
  if (isProduction && !process.env.CONTROL_PLANE_TOKEN_PEPPER) {
    // Fail closed in production. Without a pepper, a DB leak enables offline guessing against token hashes.
    throw new Error("SECURITY: CONTROL_PLANE_TOKEN_PEPPER must be set in production");
  }
  
  if (isProduction && isSqlite) {
    logger.warn({
      event: "security.warning", 
      message: "SQLite detected in production - use Postgres for better security and performance",
      severity: "medium",
    });
  }
  
  if (isProduction && config.adminTokens.length === 0) {
    logger.warn({
      event: "security.warning",
      message: "No ADMIN_TOKENS configured - admin access requires DB-backed tokens only",
      severity: "low",
    });
  }

  if (isProduction && !process.env.RELAY_INTERNAL_SECRET) {
    // Fail closed in production; internal endpoints (relay, on-demand TLS) must be authenticated.
    throw new Error("SECURITY: RELAY_INTERNAL_SECRET must be set in production");
  }

  logger.info({
    event: "config.validated",
    port: config.port,
    databaseType: isSqlite ? "sqlite" : "postgres",
    tunnelDomain: config.tunnelDomain,
    hostDomain: config.hostDomain,
    hasNeonConfig: !!(config.neonApiKey && config.neonProjectId),
    hasPepper: !!process.env.CONTROL_PLANE_TOKEN_PEPPER,
    hasInternalSecret: !!process.env.RELAY_INTERNAL_SECRET,
  });

  return config;
}

export const config = validateConfig();



