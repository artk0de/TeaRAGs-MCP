
ALTER TABLE cg_identifiers ADD COLUMN IF NOT EXISTS bound_call_unwrapped BOOLEAN;
ALTER TABLE cg_identifiers ADD COLUMN IF NOT EXISTS return_wrapper VARCHAR;
