-- Create apps / releases / deployments tables for Uplink Hosting v1
-- Postgres/Neon compatible (also used by sqlite migration runner)

CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    owner_user_id TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Owner-scoped unique app names
CREATE UNIQUE INDEX IF NOT EXISTS idx_apps_owner_name ON apps(owner_user_id, name);
CREATE INDEX IF NOT EXISTS idx_apps_owner_user_id ON apps(owner_user_id);

CREATE TABLE IF NOT EXISTS app_releases (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    artifact_key TEXT NOT NULL,
    upload_status TEXT NOT NULL DEFAULT 'pending',
    build_status TEXT NOT NULL DEFAULT 'queued',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_releases_app_id ON app_releases(app_id);
CREATE INDEX IF NOT EXISTS idx_app_releases_sha256 ON app_releases(sha256);

CREATE TABLE IF NOT EXISTS app_deployments (
    id TEXT PRIMARY KEY,
    app_id TEXT NOT NULL,
    release_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued',
    runner_target TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_app_deployments_app_id ON app_deployments(app_id);
CREATE INDEX IF NOT EXISTS idx_app_deployments_release_id ON app_deployments(release_id);

