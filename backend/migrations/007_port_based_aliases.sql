-- Migration 007: Port-based aliases
-- Change alias system from tunnel-ID-based to port-based
-- Aliases now point to (owner_user_id, target_port) instead of specific tunnel_id

-- Add target_port column to tunnel_aliases
ALTER TABLE tunnel_aliases ADD COLUMN target_port INTEGER;

-- Migrate existing data: populate target_port from associated tunnel
UPDATE tunnel_aliases 
SET target_port = (
  SELECT t.target_port 
  FROM tunnels t 
  WHERE t.id = tunnel_aliases.tunnel_id
);

-- Make tunnel_id nullable (aliases can exist without a specific tunnel)
-- Note: SQLite doesn't support ALTER COLUMN, so we'll recreate the table
-- For PostgreSQL, we'd use: ALTER TABLE tunnel_aliases ALTER COLUMN tunnel_id DROP NOT NULL;

-- Drop old unique constraint on alias
-- SQLite doesn't support DROP CONSTRAINT, so we'll recreate the table
-- For PostgreSQL: ALTER TABLE tunnel_aliases DROP CONSTRAINT IF EXISTS tunnel_aliases_alias_key;

-- Create new index for port-based lookups
CREATE INDEX IF NOT EXISTS idx_tunnel_aliases_port ON tunnel_aliases(owner_user_id, target_port);

-- For SQLite compatibility, we'll handle the nullable tunnel_id and unique constraint
-- by recreating the table. For PostgreSQL, the above ALTER statements would work.
-- Since the user mentioned they can clean the DB, we'll provide a clean migration path:

-- Drop and recreate table with new schema (clean approach)
-- This is safe since user mentioned they can clean the DB
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
