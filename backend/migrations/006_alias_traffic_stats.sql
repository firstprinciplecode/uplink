-- Alias traffic stats (persisted) keyed by alias.
-- We store per-relay-run snapshots to avoid double counting when syncing repeatedly.

-- Per alias + relay run snapshot
CREATE TABLE IF NOT EXISTS alias_traffic_runs (
  alias TEXT NOT NULL,
  relay_run_id TEXT NOT NULL,
  requests BIGINT NOT NULL DEFAULT 0,
  bytes_in BIGINT NOT NULL DEFAULT 0,
  bytes_out BIGINT NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  last_status INTEGER,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (alias, relay_run_id)
);

-- Aggregate totals per alias across runs
CREATE TABLE IF NOT EXISTS alias_traffic_totals (
  alias TEXT PRIMARY KEY,
  requests BIGINT NOT NULL DEFAULT 0,
  bytes_in BIGINT NOT NULL DEFAULT 0,
  bytes_out BIGINT NOT NULL DEFAULT 0,
  last_seen_at TEXT,
  last_status INTEGER,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_alias_traffic_runs_alias ON alias_traffic_runs(alias);
