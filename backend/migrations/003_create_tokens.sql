-- Create tokens table for control plane authentication
-- Store only hashes of tokens (never raw tokens).
-- Compatible with Postgres/Neon; SQLite will treat types loosely.

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  token_prefix TEXT NOT NULL,
  role TEXT NOT NULL,
  user_id TEXT NOT NULL,
  label TEXT,
  created_by_user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  revoked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_tokens_prefix ON tokens(token_prefix);
CREATE INDEX IF NOT EXISTS idx_tokens_user_id ON tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_tokens_role ON tokens(role);


