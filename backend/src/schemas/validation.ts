import { z } from "zod";

// Auth schemas
export const createTokenSchema = z.object({
  role: z.enum(["user", "admin"]).default("user"),
  label: z.string().max(200).optional(),
  expiresInDays: z.number().int().positive().max(365).optional(),
});

export const revokeTokenSchema = z.object({
  id: z.string().optional(),
  token: z.string().optional(),
}).refine((data) => data.id || data.token, {
  message: "Either id or token must be provided",
});

// Tunnel schemas
export const createTunnelSchema = z.object({
  port: z.number().int().positive().max(65535),
});

// Database schemas
export const createDatabaseSchema = z.object({
  name: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/, {
    message: "Database name must contain only alphanumeric characters, underscores, and hyphens",
  }),
  project: z.string().min(1),
  provider: z.enum(["neon"]).default("neon"),
  region: z.string().optional(),
  plan: z.string().optional(),
});

// Admin query schemas
export const listQuerySchema = z.object({
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive().max(200)).optional(),
  offset: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().nonnegative()).optional(),
  status: z.string().optional(),
});

// Type exports for use in routes
export type CreateTokenInput = z.infer<typeof createTokenSchema>;
export type RevokeTokenInput = z.infer<typeof revokeTokenSchema>;
export type CreateTunnelInput = z.infer<typeof createTunnelSchema>;
export type CreateDatabaseInput = z.infer<typeof createDatabaseSchema>;
export type ListQueryInput = z.infer<typeof listQuerySchema>;

