-- Migration 007: Port-based aliases
-- Change alias system from tunnel-ID-based to port-based
-- Aliases now point to (owner_user_id, target_port) instead of specific tunnel_id
-- 
-- This migration drops and recreates the tunnel_aliases table with the new schema.
-- Existing aliases will be lost - users will need to recreate them.

-- Drop and recreate table with new schema (clean approach)
DROP TABLE IF EXISTS tunnel_aliases;

CREATE TABLE tunnel_aliases (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  tunnel_id TEXT,  -- Now nullable - can exist without specific tunnel
  alias TEXT NOT NULL,
  target_port INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Create indexes
CREATE INDEX idx_tunnel_aliases_owner ON tunnel_aliases(owner_user_id);
CREATE INDEX idx_tunnel_aliases_tunnel ON tunnel_aliases(tunnel_id);
CREATE INDEX idx_tunnel_aliases_port ON tunnel_aliases(owner_user_id, target_port);
CREATE INDEX idx_tunnel_aliases_alias ON tunnel_aliases(alias);

-- Unique constraint: alias is unique per (owner_user_id, target_port) combination
-- Note: SQLite doesn't support partial unique indexes, so we enforce uniqueness at application level
-- For PostgreSQL, we could add: CREATE UNIQUE INDEX idx_tunnel_aliases_unique ON tunnel_aliases(owner_user_id, target_port, alias);
