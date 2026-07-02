-- Codegraph schema — persist def-shape signature on cg_symbols (bd tfepp/d9o7o).
-- arity/visibility (xlnub) + kwargs/block (d9o7o). All nullable; NULL = unknown
-- (narrowers treat as keep). Mirror of SQL_012_CG_SYMBOLS_ARITY_VISIBILITY.
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS arity_json VARCHAR;
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS visibility VARCHAR;
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS kwargs_json VARCHAR;
ALTER TABLE cg_symbols ADD COLUMN IF NOT EXISTS accepts_block BOOLEAN;
