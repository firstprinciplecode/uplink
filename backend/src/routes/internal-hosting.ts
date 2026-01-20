import { Router } from "express";
import { pool } from "../db/pool";
import { makeError } from "../schemas/error";
import { logger } from "../utils/logger";
import { createHash } from "crypto";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { isR2Enabled, signGetArtifactUrl } from "../utils/r2";

export const internalHostingRouter = Router();

function isAuthorizedRuntime(req: any): boolean {
  const secret = process.env.HOSTING_RUNTIME_SECRET || "";
  if (!secret) return false;
  const provided = req.headers["x-hosting-runtime-secret"];
  return provided === secret;
}

internalHostingRouter.use((req: any, res, next) => {
  if (!isAuthorizedRuntime(req)) {
    return res.status(403).json(makeError("FORBIDDEN", "Invalid runtime secret"));
  }
  next();
});

// List pending builds (uploaded tarball, not yet built)
internalHostingRouter.get("/pending-builds", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, app_id, sha256, artifact_key, size_bytes
       FROM app_releases
       WHERE upload_status = 'uploaded' AND (build_status = 'queued' OR build_status = 'building')
       ORDER BY created_at ASC
       LIMIT 10`
    );

    const releases = result.rows.map((r) => ({
      id: r.id,
      appId: r.app_id,
      sha256: r.sha256,
      sizeBytes: Number(r.size_bytes || 0),
      artifactKey: r.artifact_key,
    }));
    if (isR2Enabled()) {
      for (const release of releases) {
        release.artifactUrl = await signGetArtifactUrl(String(release.artifactKey || ""));
      }
    } else {
      const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol || "http";
      const host = req.get("host") || "127.0.0.1";
      const baseUrl = `${proto}://${host}`;
      for (const release of releases) {
        release.artifactUrl = `${baseUrl}/internal/hosting/releases/${encodeURIComponent(
          release.id
        )}/artifact`;
      }
    }
    return res.json({ releases });
  } catch (error) {
    logger.error({ event: "internal.hosting.pending_builds.failed", error });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to list pending builds"));
  }
});

// Download artifact for a release
internalHostingRouter.get("/releases/:id/artifact", async (req, res) => {
  const id = String(req.params.id || "");
  try {
    const result = await pool.query(
      "SELECT sha256, artifact_key FROM app_releases WHERE id = $1 LIMIT 1",
      [id]
    );
    if (result.rowCount === 0) return res.status(404).json(makeError("NOT_FOUND", "Release not found"));

    if (isR2Enabled()) {
      const artifactKey = String(result.rows[0].artifact_key || "");
      const url = await signGetArtifactUrl(artifactKey);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Location", url);
      return res.status(302).end();
    }

    const artifactsDir = process.env.HOSTING_ARTIFACTS_DIR || "./data/hosting-artifacts";
    const artifactKey = String(result.rows[0].artifact_key || "");
    const filePath = join(artifactsDir, artifactKey);
    if (!existsSync(filePath)) {
      return res.status(404).json(makeError("NOT_FOUND", "Artifact not found"));
    }

    const buf = readFileSync(filePath);
    const gotSha = createHash("sha256").update(buf).digest("hex");
    const expectedSha = String(result.rows[0].sha256 || "").toLowerCase();
    if (gotSha !== expectedSha) {
      return res.status(500).json(makeError("INTEGRITY_ERROR", "Artifact sha mismatch on disk"));
    }

    res.setHeader("Content-Type", "application/octet-stream");
    return res.status(200).send(buf);
  } catch (error) {
    logger.error({ event: "internal.hosting.artifact.failed", error });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to read artifact"));
  }
});

// Mark build complete (v1 MVP: no docker yet)
internalHostingRouter.post("/releases/:id/build-complete", async (req, res) => {
  const id = String(req.params.id || "");
  const imageRef = String(req.body?.imageRef || "");
  const status = String(req.body?.status || "ready");
  try {
    const now = new Date().toISOString();
    await pool.query(
      "UPDATE app_releases SET build_status = $2, image_ref = $3, updated_at = $4 WHERE id = $1",
      [id, status, imageRef || null, now]
    );
    return res.json({ id, status });
  } catch (error) {
    logger.error({ event: "internal.hosting.build_complete.failed", error });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to update build status"));
  }
});

// List pending deployments (ready build, queued deployment)
internalHostingRouter.get("/pending-deployments", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT d.id, d.app_id, d.release_id, r.image_ref, a.volume_config, a.env_config
       FROM app_deployments d
       JOIN app_releases r ON r.id = d.release_id
       JOIN apps a ON a.id = d.app_id
       WHERE d.status = 'queued' AND r.build_status = 'ready'
       ORDER BY d.created_at ASC
       LIMIT 10`
    );

    const deployments = result.rows.map((r) => {
      let volumeConfig: any;
      let envConfig: any;
      try {
        volumeConfig = r.volume_config ? JSON.parse(r.volume_config) : undefined;
      } catch {
        volumeConfig = undefined;
      }
      try {
        envConfig = r.env_config ? JSON.parse(r.env_config) : undefined;
      } catch {
        envConfig = undefined;
      }
      return {
        id: r.id,
        appId: r.app_id,
        releaseId: r.release_id,
        imageRef: r.image_ref,
        volumeConfig,
        envConfig,
      };
    });
    return res.json({ deployments });
  } catch (error) {
    logger.error({ event: "internal.hosting.pending_deployments.failed", error });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to list pending deployments"));
  }
});

// Mark deployment started/running
internalHostingRouter.post("/deployments/:id/started", async (req, res) => {
  const id = String(req.params.id || "");
  const runnerTarget = String(req.body?.runnerTarget || "");
  const containerId = req.body?.containerId ? String(req.body.containerId) : null;
  const internalPort = req.body?.internalPort ? Number(req.body.internalPort) : null;
  try {
    const now = new Date().toISOString();
    await pool.query(
      "UPDATE app_deployments SET status = 'running', runner_target = $2, container_id = $3, internal_port = $4, updated_at = $5 WHERE id = $1",
      [id, runnerTarget || null, containerId, internalPort, now]
    );
    return res.json({ id, status: "running" });
  } catch (error) {
    logger.error({ event: "internal.hosting.deployment_started.failed", error });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to update deployment status"));
  }
});

// Routes map for router: appId -> runnerTarget/internalPort
internalHostingRouter.get("/routes", async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT app_id, runner_target, internal_port
       FROM app_deployments
       WHERE status = 'running' AND runner_target IS NOT NULL
       ORDER BY updated_at DESC`
    );
    const routes: Record<string, any> = {};
    for (const row of result.rows) {
      if (!routes[row.app_id]) {
        routes[row.app_id] = { runnerTarget: row.runner_target, internalPort: row.internal_port || null };
      }
    }
    return res.json({ routes });
  } catch (error) {
    logger.error({ event: "internal.hosting.routes.failed", error });
    return res.status(500).json(makeError("INTERNAL_ERROR", "Failed to list routes"));
  }
});

