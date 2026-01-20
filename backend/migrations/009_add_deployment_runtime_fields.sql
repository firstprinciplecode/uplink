-- Add runtime metadata to deployments (container id + internal port)
ALTER TABLE app_deployments ADD COLUMN IF NOT EXISTS container_id TEXT;
ALTER TABLE app_deployments ADD COLUMN IF NOT EXISTS internal_port INTEGER;
