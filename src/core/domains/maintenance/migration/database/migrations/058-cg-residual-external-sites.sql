
CREATE TABLE IF NOT EXISTS cg_residual_external_sites (
  model           VARCHAR NOT NULL,
  source_rel_path VARCHAR NOT NULL,
  site_key        VARCHAR NOT NULL,
  menu_hash       VARCHAR NOT NULL,
  p               DOUBLE  NOT NULL,
  PRIMARY KEY (model, source_rel_path, site_key)
);
