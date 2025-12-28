-- Add alias_limit column to tokens table for premium alias feature
-- alias_limit values:
--   0  = No aliases allowed (default for free users)
--   >0 = User can create up to N aliases
--   -1 = Unlimited aliases (admin)

ALTER TABLE tokens ADD COLUMN IF NOT EXISTS alias_limit INTEGER DEFAULT 0;

-- Set existing admin tokens to unlimited (-1)
UPDATE tokens SET alias_limit = -1 WHERE role = 'admin';

-- Index for quick lookup
CREATE INDEX IF NOT EXISTS idx_tokens_alias_limit ON tokens(alias_limit);


