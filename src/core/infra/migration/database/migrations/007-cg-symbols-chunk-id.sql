ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS chunk_id VARCHAR;

CREATE INDEX IF NOT EXISTS idx_cg_symbols_symbol ON cg_symbols (symbol_id);
