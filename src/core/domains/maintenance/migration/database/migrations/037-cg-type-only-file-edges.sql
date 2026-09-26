
CREATE TABLE IF NOT EXISTS cg_symbols_edges_file_type_only (
  source_rel_path  VARCHAR NOT NULL,
  target_rel_path  VARCHAR NOT NULL,
  import_text      VARCHAR,
  PRIMARY KEY (source_rel_path, target_rel_path)
);
