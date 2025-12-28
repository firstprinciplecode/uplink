-- Create tunnel_aliases table for permanent aliases
-- Works with Postgres/SQLite (types are loosely enforced in SQLite)
CREATE TABLE IF NOT EXISTS tunnel_aliases (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  tunnel_id TEXT NOT NULL,
  alias TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tunnel_aliases_owner ON tunnel_aliases(owner_user_id);
CREATE INDEX IF NOT EXISTS idx_tunnel_aliases_tunnel ON tunnel_aliases(tunnel_id);



