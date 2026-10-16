
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS language VARCHAR;
ALTER TABLE cg_residual_call_sites ADD COLUMN IF NOT EXISTS receiver_kind VARCHAR;
UPDATE cg_residual_call_sites r SET language = f.language
  FROM cg_symbols_files f
 WHERE f.rel_path = r.source_rel_path AND r.language IS NULL;
