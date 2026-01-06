-- Hosting runtime fields for builder/runner/router contract (v1 MVP)

-- app_releases: record build output image reference
ALTER TABLE app_releases ADD COLUMN IF NOT EXISTS image_ref TEXT;

-- app_deployments: record runtime container identity + internal port
ALTER TABLE app_deployments ADD COLUMN IF NOT EXISTS container_id TEXT;
ALTER TABLE app_deployments ADD COLUMN IF NOT EXISTS internal_port INTEGER;

