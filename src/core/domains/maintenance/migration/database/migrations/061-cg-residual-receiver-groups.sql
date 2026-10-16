
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS receiver_group VARCHAR;
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS class_targets VARCHAR;
