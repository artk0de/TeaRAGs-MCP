CREATE TABLE IF NOT EXISTS cg_symbols_inheritance (
  source_fq_name     VARCHAR NOT NULL,
  source_rel_path    VARCHAR NOT NULL,
  source_symbol_id   VARCHAR,
  ancestor_fq_name   VARCHAR NOT NULL,
  ancestor_symbol_id VARCHAR,
  kind               VARCHAR NOT NULL,
  ordinal            INTEGER NOT NULL,
  PRIMARY KEY (source_fq_name, source_rel_path, ancestor_fq_name, kind)
);

CREATE INDEX IF NOT EXISTS idx_cg_inh_source       ON cg_symbols_inheritance (source_fq_name);
CREATE INDEX IF NOT EXISTS idx_cg_inh_ancestor_sym ON cg_symbols_inheritance (ancestor_symbol_id);
CREATE INDEX IF NOT EXISTS idx_cg_inh_ancestor_fq  ON cg_symbols_inheritance (ancestor_fq_name);
CREATE INDEX IF NOT EXISTS idx_cg_inh_source_path  ON cg_symbols_inheritance (source_rel_path);
