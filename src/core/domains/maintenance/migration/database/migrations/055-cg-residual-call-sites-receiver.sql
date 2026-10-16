
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS language VARCHAR;
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS receiver_kind VARCHAR;
