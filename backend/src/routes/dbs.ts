import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { pool } from "../db/pool";
import { makeError } from "../schemas/error";
import {
  CreateDbRequestBody,
  CreateDbResponse,
  ListDbsResponse,
  GetDbResponse,
  DeleteDbResponse,
  LinkServiceRequestBody,
} from "../schemas/database";
import { createNeonDatabase, deleteNeonDatabase } from "../providers/neon";
import { toDatabaseResponse } from "../models/database";

export const dbRouter = Router();

// Simple auth stub – replace with real auth middleware
interface AuthedRequest extends Request {
  user?: { id: string };
}

// POST /v1/dbs
dbRouter.post("/", async (req: AuthedRequest, res: Response) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
  }

  const body = req.body as CreateDbRequestBody;
  if (!body.name || !body.project) {
    return res
      .status(400)
      .json(makeError("INVALID_INPUT", "name and project are required"));
  }

  const provider = body.provider ?? "neon";
  const region = body.region ?? "eu-central-1";
  const plan = body.plan ?? "dev";
  const projectId = body.project;

  // Quota guard per user
  const limitPerUser = Number(process.env.DB_LIMIT_PER_USER ?? "5");
  const countRes = await pool.query(
    "SELECT COUNT(*) AS count FROM databases WHERE owner_user_id = $1 AND status <> 'deleted'",
    [user.id]
  );
  const currentCount = Number(countRes.rows[0].count);
  if (currentCount >= limitPerUser) {
    return res
      .status(429)
      .json(
        makeError("DB_LIMIT_REACHED", "Database limit reached for this user", {
          limit: limitPerUser,
        })
      );
  }

  // TODO: look up project by slug and validate ownership
  const nameCheck = await pool.query(
    "SELECT id FROM databases WHERE project_id = $1 AND name = $2 AND status <> 'deleted'",
    [projectId, body.name]
  );
  if (nameCheck.rowCount > 0) {
    return res
      .status(409)
      .json(
        makeError("DB_NAME_TAKEN", "Database name already exists in project", {
          project: body.project,
          name: body.name,
        })
      );
  }

  try {
    const neon = await createNeonDatabase({
      name: body.name,
      region,
      plan,
    });

    const id = `db_${randomUUID()}`;
    const now = new Date().toISOString();

    const insert = await pool.query(
      `
      INSERT INTO databases (
        id, owner_user_id, project_id, name, provider, provider_database_id,
        engine, version, region, status, host, port, database, "user",
        encrypted_password, created_at, updated_at
      ) VALUES (
        $1, $2, $3, $4, $5, $6,
        $7, $8, $9, $10, $11, $12, $13, $14,
        $15, $16, $17
      )
      RETURNING *
    `,
      [
        id,
        user.id,
        projectId,
        body.name,
        provider,
        neon.providerDatabaseId,
        "postgres",
        neon.version,
        region,
        "ready",
        neon.host,
        neon.port,
        neon.database,
        neon.user,
        neon.encryptedPassword,
        now,
        now,
      ]
    );

    const record = insert.rows[0];
    const response: CreateDbResponse = toDatabaseResponse(
      record,
      neon.directConnectionString,
      neon.pooledConnectionString
    );
    return res.status(201).json(response);
  } catch (err) {
    console.error("Error creating DB:", err);
    return res
      .status(500)
      .json(
        makeError("PROVIDER_ERROR", "Failed to provision database", { provider })
      );
  }
});

// GET /v1/dbs
dbRouter.get("/", async (req: AuthedRequest, res: Response) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
  }

  const project = req.query.project as string | undefined;
  const params: Array<string> = [user.id];
  let sql =
    "SELECT * FROM databases WHERE owner_user_id = $1 AND status <> 'deleted'";

  if (project) {
    params.push(project);
    sql += " AND project_id = $2";
  }

  const result = await pool.query(sql, params);
  const items: ListDbsResponse["items"] = result.rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    project: row.project_id,
    provider: row.provider,
    engine: row.engine,
    region: row.region,
    status: row.status,
    ready: row.status === "ready",
    createdAt: row.created_at,
  }));

  const response: ListDbsResponse = { items };
  return res.json(response);
});

// GET /v1/dbs/:id
dbRouter.get("/:id", async (req: AuthedRequest, res: Response) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
  }

  const id = req.params.id;
  const result = await pool.query(
    "SELECT * FROM databases WHERE id = $1 AND owner_user_id = $2",
    [id, user.id]
  );

  if (result.rowCount === 0) {
    return res
      .status(404)
      .json(makeError("NOT_FOUND", "Database not found", { id }));
  }

  const row = result.rows[0];
  const maskedPassword = "******";
  const direct = `postgres://${encodeURIComponent(
    row.user
  )}:${maskedPassword}@${row.host}:${row.port}/${row.database}?sslmode=require`;

  const response: GetDbResponse = toDatabaseResponse(row, direct);
  return res.json(response);
});

// DELETE /v1/dbs/:id
dbRouter.delete("/:id", async (req: AuthedRequest, res: Response) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
  }

  const id = req.params.id;
  const result = await pool.query(
    "SELECT * FROM databases WHERE id = $1 AND owner_user_id = $2",
    [id, user.id]
  );

  if (result.rowCount === 0) {
    return res
      .status(404)
      .json(makeError("NOT_FOUND", "Database not found", { id }));
  }

  const row = result.rows[0];

  try {
    await deleteNeonDatabase({ providerDatabaseId: row.provider_database_id });
  } catch (err) {
    console.error("Error deleting Neon DB:", err);
  }

  await pool.query(
    "UPDATE databases SET status = 'deleted', updated_at = NOW() WHERE id = $1",
    [id]
  );

  const response: DeleteDbResponse = { id, status: "deleted" };
  return res.json(response);
});

// POST /v1/dbs/:id/link-service
dbRouter.post("/:id/link-service", async (req: AuthedRequest, res: Response) => {
  const user = req.user;
  if (!user) {
    return res.status(401).json(makeError("UNAUTHORIZED", "Missing auth"));
  }

  const id = req.params.id;
  const body = req.body as LinkServiceRequestBody;

  if (!body.service || !body.envVar) {
    return res
      .status(400)
      .json(makeError("INVALID_INPUT", "service and envVar are required"));
  }

  // TODO: validate service ownership and persist env var linkage
  return res.json({
    service: body.service,
    envVar: body.envVar,
    dbId: id,
    status: "linked",
  });
});

