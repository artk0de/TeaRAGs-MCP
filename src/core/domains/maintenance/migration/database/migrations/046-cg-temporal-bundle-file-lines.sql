
ALTER TABLE cg_temporal_bundle_files ADD COLUMN IF NOT EXISTS lines_added INTEGER;
ALTER TABLE cg_temporal_bundle_files ADD COLUMN IF NOT EXISTS lines_deleted INTEGER;
