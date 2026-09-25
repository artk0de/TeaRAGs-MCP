
ALTER TABLE cg_symbols_files ADD COLUMN IF NOT EXISTS abstract_type_count INTEGER;
ALTER TABLE cg_symbols_files ADD COLUMN IF NOT EXISTS concrete_type_count INTEGER;
