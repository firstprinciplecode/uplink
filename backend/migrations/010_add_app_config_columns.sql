-- Add volume_config and env_config columns to apps table for persistent volumes and environment variables
ALTER TABLE apps ADD COLUMN volume_config TEXT;
ALTER TABLE apps ADD COLUMN env_config TEXT;
