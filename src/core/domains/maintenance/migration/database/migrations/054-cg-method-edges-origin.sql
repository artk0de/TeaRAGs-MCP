
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS origin VARCHAR;
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS model VARCHAR;
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS p DOUBLE;
ALTER TABLE cg_symbols_edges_method ADD COLUMN IF NOT EXISTS site_key VARCHAR;
