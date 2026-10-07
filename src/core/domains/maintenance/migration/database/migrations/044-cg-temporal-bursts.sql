
ALTER TABLE cg_temporal_bundle_commits ADD COLUMN IF NOT EXISTS burst_id INTEGER;
ALTER TABLE cg_temporal_meta ADD COLUMN IF NOT EXISTS admitted_burst_count INTEGER;
ALTER TABLE cg_temporal_meta ADD COLUMN IF NOT EXISTS burst_window_minutes INTEGER;
ALTER TABLE cg_temporal_meta ADD COLUMN IF NOT EXISTS burst_window_method VARCHAR;
