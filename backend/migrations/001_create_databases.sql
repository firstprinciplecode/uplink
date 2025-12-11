-- Migration: Create databases table for control plane
-- Postgres/Neon compatible
CREATE TABLE IF NOT EXISTS databases (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_database_id TEXT NOT NULL,
  engine TEXT NOT NULL,
  version TEXT NOT NULL,
  region TEXT NOT NULL,
  status TEXT NOT NULL,
  host TEXT NOT NULL,
  port INTEGER NOT NULL,
  database TEXT NOT NULL,
  "user" TEXT NOT NULL,
  encrypted_password TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS databases_unique_name_per_project
  ON databases (project_id, name) WHERE status <> 'deleted';

CREATE INDEX IF NOT EXISTS databases_owner_user_id ON databases (owner_user_id);
CREATE INDEX IF NOT EXISTS databases_status ON databases (status);

