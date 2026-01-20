import { Router } from "express";
import { createHash, randomUUID } from "crypto";
import bodyParser from "body-parser";
import { pool } from "../db/pool";
import { makeError } from "../schemas/error";
import { bodySizeLimits } from "../middleware/body-size";
import { validateBody } from "../middleware/validate";
import { config } from "../utils/config";
import { logger } from "../utils/logger";
import {
  type AppRecord,
  type AppDeploymentRecord,
  type AppReleaseRecord,
  toAppResponse,
} from "../models/app";
import { z } from "zod";

export const appRouter = Router();

const createAppSchema = z.object({
  name: z.string().trim().min(1).max(64),
});

const createReleaseSchema = z.object({
  sha256: z.string().trim().toLowerCase().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().int().nonnegative().max(500_000_000),
});

const createDeploymentSchema = z.object({
  releaseId: z.string().trim().min(1).max(128),
});

const updateAppConfigSchema = z.object({
  volumes: z.record(z.string().min(1), z.literal("persistent")).optional(),
  env: z.record(z.string().min(1).max(64), z.string().max(4096)).optional(),
});

function requireUserId(req: any): string {
  const userId = req.user?.id;
  if (!userId) throw new Error("missing user");
  return String(userId);
}

// Create app
appRouter.post("/", bodySizeLimits.small, validateBody(createAppSchema), async (req: any, res) => {
  const ownerUserId = requireUserId(req);
  const { name } = req.body as { name: string };
  const id = `app_${randomUUID()}`;

  try {
    const existing = await pool.query(
      "SELECT id, owner_user_id, name, created_at, updated_at FROM apps WHERE owner_user_id = $1 AND name = $2 LIMIT 1",
      [ownerUserId, name]
    );
    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      const record: AppRecord = {
        id: row.id,
        ownerUserId: row.owner_user_id,
        name: row.name,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      return res.status(200).json(toAppResponse(record, config.hostDomain));
    }

    const now = new Date().toISOString();
    await pool.query(
      "INSERT INTO apps (id, owner_user_id, name, created_at, updated_at) VALUES ($1,$2,$3,$4,$5)",
      [id, ownerUserId, name, now, now]
    );

    const record: AppRecord = { id, ownerUserId, name, createdAt: now, updatedAt: now };
    return res.status(201).json(toAppResponse(record, config.hostDomain));
  } catch (error) {
    logger.error({ event: "apps.create.failed", error });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to create app"));
  }
});

// Update app config (volumes/env)
appRouter.put("/:id/config", bodySizeLimits.small, validateBody(updateAppConfigSchema), async (req: any, res) => {
  const ownerUserId = requireUserId(req);
  const appId = String(req.params.id || "");
  const { volumes, env } = req.body as { volumes?: Record<string, string>; env?: Record<string, string> };

  if (!volumes && !env) {
    return res.status(400).json(makeError("INVALID_BODY", "Provide volumes and/or env config"));
  }

  try {
    const result = await pool.query(
      "SELECT id FROM apps WHERE id = $1 AND owner_user_id = $2 LIMIT 1",
      [appId, ownerUserId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json(makeError("NOT_FOUND", "App not found"));
    }

    const now = new Date().toISOString();
    await pool.query(
      "UPDATE apps SET volume_config = COALESCE($2, volume_config), env_config = COALESCE($3, env_config), updated_at = $4 WHERE id = $1",
      [appId, volumes ? JSON.stringify(volumes) : null, env ? JSON.stringify(env) : null, now]
    );

    return res.json({ id: appId, volumes: volumes || null, env: env || null });
  } catch (error) {
    logger.error({ event: "apps.config.update.failed", error });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to update app config"));
  }
});

// List apps
appRouter.get("/", async (req: any, res) => {
  const ownerUserId = requireUserId(req);
  try {
    const result = await pool.query(
      "SELECT id, owner_user_id, name, created_at, updated_at FROM apps WHERE owner_user_id = $1 ORDER BY created_at DESC",
      [ownerUserId]
    );
    const apps = result.rows.map((row) =>
      toAppResponse(
        {
          id: row.id,
          ownerUserId: row.owner_user_id,
          name: row.name,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        config.hostDomain
      )
    );
    return res.json({ apps, count: apps.length });
  } catch (error) {
    logger.error({ event: "apps.list.failed", error });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to list apps"));
  }
});

// Get app
appRouter.get("/:id", async (req: any, res) => {
  const ownerUserId = requireUserId(req);
  const id = String(req.params.id || "");
  try {
    const result = await pool.query(
      "SELECT id, owner_user_id, name, created_at, updated_at FROM apps WHERE id = $1 AND owner_user_id = $2 LIMIT 1",
      [id, ownerUserId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json(makeError("NOT_FOUND", "App not found"));
    }
    const row = result.rows[0];
    return res.json(
      toAppResponse(
        {
          id: row.id,
          ownerUserId: row.owner_user_id,
          name: row.name,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        },
        config.hostDomain
      )
    );
  } catch (error) {
    logger.error({ event: "apps.get.failed", error });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to get app"));
  }
});

// Create release (returns uploadUrl; actual upload is a separate endpoint in v1)
appRouter.post("/:id/releases", bodySizeLimits.small, validateBody(createReleaseSchema), async (req: any, res) => {
  const ownerUserId = requireUserId(req);
  const appId = String(req.params.id || "");
  const { sha256, sizeBytes } = req.body as { sha256: string; sizeBytes: number };

  try {
    const app = await pool.query(
      "SELECT id FROM apps WHERE id = $1 AND owner_user_id = $2 LIMIT 1",
      [appId, ownerUserId]
    );
    if (app.rowCount === 0) {
      return res.status(404).json(makeError("NOT_FOUND", "App not found"));
    }

    const releaseId = `rel_${randomUUID()}`;
    const artifactKey = `hosting/releases/${releaseId}.tgz`;
    const now = new Date().toISOString();

    await pool.query(
      `INSERT INTO app_releases
        (id, app_id, sha256, size_bytes, artifact_key, upload_status, build_status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,'pending','queued',$6,$7)`,
      [releaseId, appId, sha256, sizeBytes, artifactKey, now, now]
    );

    const release: AppReleaseRecord = {
      id: releaseId,
      appId,
      sha256,
      sizeBytes,
      artifactKey,
      uploadStatus: "pending",
      buildStatus: "queued",
      createdAt: now,
      updatedAt: now,
    };

    // v1: upload goes to the control plane (Bearer-auth), not a third-party presigned URL.
    // Prefer the request host so self-hosted setups work without AGENTCLOUD_API_BASE on the server.
    const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "https";
    const host = req.get("host") || "api.uplink.spot";
    const baseUrl = `${proto}://${host}`;
    const uploadUrl = `${baseUrl}/v1/apps/${encodeURIComponent(appId)}/releases/${encodeURIComponent(
      releaseId
    )}/artifact`;

    return res.status(201).json({ release, uploadUrl });
  } catch (error) {
    logger.error({ event: "apps.release.create.failed", error });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to create release"));
  }
});

// Upload artifact (v1 MVP)
appRouter.put(
  "/:id/releases/:releaseId/artifact",
  bodyParser.raw({ type: "application/octet-stream", limit: "200mb" }),
  async (req: any, res) => {
    const ownerUserId = requireUserId(req);
    const appId = String(req.params.id || "");
    const releaseId = String(req.params.releaseId || "");

    try {
      const check = await pool.query(
        `SELECT r.id, r.sha256, r.size_bytes, r.artifact_key
         FROM app_releases r
         JOIN apps a ON a.id = r.app_id
         WHERE r.id = $1 AND r.app_id = $2 AND a.owner_user_id = $3
         LIMIT 1`,
        [releaseId, appId, ownerUserId]
      );
      if (check.rowCount === 0) {
        return res.status(404).json(makeError("NOT_FOUND", "Release not found"));
      }

      const expectedSha = String(check.rows[0].sha256 || "").toLowerCase();
      const buf: Buffer | undefined = Buffer.isBuffer(req.body) ? req.body : undefined;
      if (!buf || buf.length === 0) {
        return res.status(400).json(makeError("INVALID_BODY", "Expected application/octet-stream body"));
      }

      const gotSha = createHash("sha256").update(buf).digest("hex");
      if (gotSha !== expectedSha) {
        await pool.query("UPDATE app_releases SET upload_status = 'failed', updated_at = $2 WHERE id = $1", [
          releaseId,
          new Date().toISOString(),
        ]);
        return res.status(400).json(makeError("INVALID_SHA256", "Uploaded artifact sha256 did not match"));
      }

      // NOTE: v1 stub implementation: verify hash, then mark uploaded.
      // The private builder/runner system will define the durable artifact store contract (object storage/registry).
      const now = new Date().toISOString();
      await pool.query(
        "UPDATE app_releases SET upload_status = 'uploaded', updated_at = $2 WHERE id = $1",
        [releaseId, now]
      );
      return res.status(200).json({ id: releaseId, status: "uploaded" });
    } catch (error) {
      logger.error({ event: "apps.release.upload.failed", error });
      return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to upload artifact"));
    }
  }
);

// Create deployment
appRouter.post(
  "/:id/deployments",
  bodySizeLimits.small,
  validateBody(createDeploymentSchema),
  async (req: any, res) => {
    const ownerUserId = requireUserId(req);
    const appId = String(req.params.id || "");
    const { releaseId } = req.body as { releaseId: string };

    try {
      const check = await pool.query(
        `SELECT r.id
         FROM app_releases r
         JOIN apps a ON a.id = r.app_id
         WHERE r.id = $1 AND r.app_id = $2 AND a.owner_user_id = $3
         LIMIT 1`,
        [releaseId, appId, ownerUserId]
      );
      if (check.rowCount === 0) {
        return res.status(404).json(makeError("NOT_FOUND", "Release not found"));
      }

      const deploymentId = `dep_${randomUUID()}`;
      const now = new Date().toISOString();
      await pool.query(
        `INSERT INTO app_deployments (id, app_id, release_id, status, runner_target, created_at, updated_at)
         VALUES ($1,$2,$3,'queued',NULL,$4,$5)`,
        [deploymentId, appId, releaseId, now, now]
      );
      const deployment: AppDeploymentRecord = {
        id: deploymentId,
        appId,
        releaseId,
        status: "queued",
        runnerTarget: null,
        createdAt: now,
        updatedAt: now,
      };
      return res.status(201).json(deployment);
    } catch (error) {
      logger.error({ event: "apps.deployment.create.failed", error });
      return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to create deployment"));
    }
  }
);

// Status (v1: latest release + latest deployment)
appRouter.get("/:id/status", async (req: any, res) => {
  const ownerUserId = requireUserId(req);
  const appId = String(req.params.id || "");
  try {
    const appRes = await pool.query(
      "SELECT id, owner_user_id, name, created_at, updated_at FROM apps WHERE id = $1 AND owner_user_id = $2 LIMIT 1",
      [appId, ownerUserId]
    );
    if (appRes.rowCount === 0) {
      return res.status(404).json(makeError("NOT_FOUND", "App not found"));
    }
    const appRow = appRes.rows[0];
    const app = toAppResponse(
      {
        id: appRow.id,
        ownerUserId: appRow.owner_user_id,
        name: appRow.name,
        createdAt: appRow.created_at,
        updatedAt: appRow.updated_at,
      },
      config.hostDomain
    );

    const relRes = await pool.query(
      `SELECT id, app_id, sha256, size_bytes, artifact_key, upload_status, build_status, created_at, updated_at
       FROM app_releases WHERE app_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [appId]
    );
    const depRes = await pool.query(
      `SELECT id, app_id, release_id, status, runner_target, created_at, updated_at
       FROM app_deployments WHERE app_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [appId]
    );

    const activeRelease = relRes.rowCount
      ? {
          id: relRes.rows[0].id,
          appId: relRes.rows[0].app_id,
          sha256: relRes.rows[0].sha256,
          sizeBytes: Number(relRes.rows[0].size_bytes),
          uploadStatus: relRes.rows[0].upload_status,
          buildStatus: relRes.rows[0].build_status,
          createdAt: relRes.rows[0].created_at,
          updatedAt: relRes.rows[0].updated_at,
        }
      : null;

    const activeDeployment = depRes.rowCount
      ? {
          id: depRes.rows[0].id,
          appId: depRes.rows[0].app_id,
          releaseId: depRes.rows[0].release_id,
          status: depRes.rows[0].status,
          runnerTarget: depRes.rows[0].runner_target,
          createdAt: depRes.rows[0].created_at,
          updatedAt: depRes.rows[0].updated_at,
        }
      : null;

    return res.json({
      app,
      activeDeployment,
      activeRelease,
    });
  } catch (error) {
    logger.error({ event: "apps.status.failed", error });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to get app status"));
  }
});

// Logs (v1: stub)
appRouter.get("/:id/logs", async (req: any, res) => {
  const ownerUserId = requireUserId(req);
  const appId = String(req.params.id || "");
  try {
    const appRes = await pool.query(
      "SELECT id FROM apps WHERE id = $1 AND owner_user_id = $2 LIMIT 1",
      [appId, ownerUserId]
    );
    if (appRes.rowCount === 0) {
      return res.status(404).json(makeError("NOT_FOUND", "App not found"));
    }
    const depRes = await pool.query(
      `SELECT runner_target, container_id
       FROM app_deployments
       WHERE app_id = $1 AND status = 'running'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [appId]
    );
    if (depRes.rowCount === 0) {
      return res.status(409).json(makeError("NOT_READY", "No running deployment"));
    }
    const runnerTarget = String(depRes.rows[0].runner_target || "");
    const containerId = String(depRes.rows[0].container_id || "");
    if (!runnerTarget || !containerId) {
      return res.status(409).json(makeError("NOT_READY", "Deployment missing runtime metadata"));
    }
    if (!config.hostingRuntimeSecret) {
      return res.status(500).json(makeError("INTERNAL_ERROR", "HOSTING_RUNTIME_SECRET not configured"));
    }

    const tailRaw = req.query?.tail ? Number(req.query.tail) : 200;
    const tail = Math.min(Math.max(1, Number.isFinite(tailRaw) ? tailRaw : 200), 500);
    const url = `http://${runnerTarget}:${config.runnerHealthPort}/logs?containerId=${encodeURIComponent(
      containerId
    )}&tail=${tail}`;
    const logsRes = await fetch(url, {
      headers: { "x-hosting-runtime-secret": config.hostingRuntimeSecret },
    });
    const json = await logsRes.json().catch(() => ({}));
    if (!logsRes.ok) {
      return res
        .status(502)
        .json(makeError("UPSTREAM_ERROR", `Runner logs failed (${logsRes.status})`));
    }
    const lines = Array.isArray(json?.lines) ? json.lines : [];
    return res.json({ lines });
  } catch (error) {
    logger.error({ event: "apps.logs.failed", error });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to get logs"));
  }
});

