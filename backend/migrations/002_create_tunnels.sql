-- Create tunnels table for tunnel management
-- Postgres/Neon compatible
CREATE TABLE IF NOT EXISTS tunnels (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    project_id TEXT,
    token TEXT NOT NULL UNIQUE,
    target_port INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ
);

-- Index for fast token lookups (used by allow-tls endpoint)
CREATE INDEX IF NOT EXISTS idx_tunnels_token ON tunnels(token);

-- Index for user queries
CREATE INDEX IF NOT EXISTS idx_tunnels_owner_user_id ON tunnels(owner_user_id);

-- Index for status queries
CREATE INDEX IF NOT EXISTS idx_tunnels_status ON tunnels(status);

