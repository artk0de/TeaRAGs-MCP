
ALTER TABLE cg_residual_external_sites ADD COLUMN IF NOT EXISTS outcome VARCHAR DEFAULT 'external';
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS schema_attribute BIGINT DEFAULT 0;
ALTER TABLE cg_file_resolve_stats ADD COLUMN IF NOT EXISTS schema_attribute INTEGER DEFAULT 0;
