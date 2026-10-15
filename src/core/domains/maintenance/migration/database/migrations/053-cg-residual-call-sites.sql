
CREATE TABLE IF NOT EXISTS cg_residual_call_sites (
  source_rel_path   VARCHAR NOT NULL,
  site_key          VARCHAR NOT NULL,
  method_symbol_id  VARCHAR NOT NULL,
  method_start_line INTEGER NOT NULL,
  method_end_line   INTEGER NOT NULL,
  line              INTEGER NOT NULL,
  call_column       INTEGER NOT NULL,
  receiver_text     VARCHAR NOT NULL,
  member            VARCHAR NOT NULL,
  kind              VARCHAR NOT NULL,
  candidates        VARCHAR NOT NULL,
  menu_hash         VARCHAR NOT NULL,
  menu_overflow     BOOLEAN NOT NULL,
  PRIMARY KEY (source_rel_path, site_key)
);

CREATE INDEX IF NOT EXISTS idx_cg_residual_call_sites_site_key
  ON cg_residual_call_sites (site_key);
