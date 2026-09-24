
ALTER TABLE cg_symbols_edges_file ADD COLUMN IF NOT EXISTS imported_export_names VARCHAR;
ALTER TABLE cg_symbols_edges_file ADD COLUMN IF NOT EXISTS reexported_export_names VARCHAR;
