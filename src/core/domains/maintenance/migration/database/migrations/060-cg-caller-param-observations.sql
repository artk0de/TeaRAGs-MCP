
CREATE TABLE IF NOT EXISTS cg_caller_param_observations (
  source_rel_path VARCHAR NOT NULL PRIMARY KEY,
  observations    VARCHAR NOT NULL
);
ALTER TABLE cg_run_stats ADD COLUMN IF NOT EXISTS param_typed BIGINT DEFAULT 0;
ALTER TABLE cg_file_resolve_stats ADD COLUMN IF NOT EXISTS param_typed INTEGER DEFAULT 0;
