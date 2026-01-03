import pino from "pino";

const isDevelopment = process.env.NODE_ENV !== "production";

/**
 * Redact sensitive values from log data.
 * Replaces secrets, tokens, and passwords with "[REDACTED]".
 */
function redactSecrets(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj !== "object") return obj;

  const redacted = Array.isArray(obj) ? [...obj] : { ...obj };
  const secretKeys = [
    "secret",
    "token",
    "password",
    "authorization",
    "x-relay-internal-secret",
    "relay_internal_secret",
    "relayInternalSecret",
  ];

  for (const key in redacted) {
    const lowerKey = key.toLowerCase();
    if (secretKeys.some((sk) => lowerKey.includes(sk))) {
      if (typeof redacted[key] === "string" && redacted[key].length > 0) {
        redacted[key] = "[REDACTED]";
      }
    } else if (typeof redacted[key] === "object") {
      redacted[key] = redactSecrets(redacted[key]);
    }
  }

  return redacted;
}

// Custom serializer to redact secrets
const serializers = {
  ...pino.stdSerializers,
  req: (req: any) => {
    const serialized = pino.stdSerializers.req(req);
    // Redact query params and headers that might contain secrets
    if (serialized.query) {
      serialized.query = redactSecrets(serialized.query);
    }
    if (serialized.headers) {
      serialized.headers = redactSecrets(serialized.headers);
    }
    return serialized;
  },
};

export const logger = pino({
  level: process.env.LOG_LEVEL || (isDevelopment ? "debug" : "info"),
  serializers,
  transport: isDevelopment
    ? {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss Z",
          ignore: "pid,hostname",
        },
      }
    : undefined,
});

// Audit logger for security events
export const auditLogger = logger.child({ component: "audit" });

// Helper functions for common audit events
export const auditLog = {
  tokenCreated: (userId: string, tokenId: string, role: string) => {
    auditLogger.info({
      event: "token.created",
      userId,
      tokenId,
      role,
    });
  },

  tokenRevoked: (userId: string, tokenId: string, revokedBy: string) => {
    auditLogger.info({
      event: "token.revoked",
      userId,
      tokenId,
      revokedBy,
    });
  },

  tunnelCreated: (userId: string, tunnelId: string, token: string, port: number) => {
    auditLogger.info({
      event: "tunnel.created",
      userId,
      tunnelId,
      token: token.substring(0, 8) + "...", // Only log prefix
      port,
    });
  },

  tunnelDeleted: (userId: string, tunnelId: string) => {
    auditLogger.info({
      event: "tunnel.deleted",
      userId,
      tunnelId,
    });
  },

  authFailed: (reason: string, ip?: string) => {
    auditLogger.warn({
      event: "auth.failed",
      reason,
      ip,
    });
  },

  authSuccess: (userId: string, role: string, ip?: string) => {
    auditLogger.info({
      event: "auth.success",
      userId,
      role,
      ip,
    });
  },

  adminAction: (userId: string, action: string, details?: Record<string, unknown>) => {
    auditLogger.info({
      event: "admin.action",
      userId,
      action,
      ...details,
    });
  },

  databaseCreated: (userId: string, dbId: string, name: string, provider: string) => {
    auditLogger.info({
      event: "database.created",
      userId,
      dbId,
      name,
      provider,
    });
  },

  databaseDeleted: (userId: string, dbId: string) => {
    auditLogger.info({
      event: "database.deleted",
      userId,
      dbId,
    });
  },
};




