
CREATE TABLE IF NOT EXISTS cg_static_site_sample (
  source_rel_path   VARCHAR NOT NULL,
  site_key          VARCHAR NOT NULL,
  language          VARCHAR NOT NULL,
  method_symbol_id  VARCHAR NOT NULL,
  method_start_line INTEGER NOT NULL,
  method_end_line   INTEGER NOT NULL,
  line              INTEGER NOT NULL,
  call_column       INTEGER NOT NULL,
  receiver_text     VARCHAR NOT NULL,
  receiver_kind     VARCHAR NOT NULL,
  member            VARCHAR NOT NULL,
  outcome           VARCHAR NOT NULL,
  target_symbol_id  VARCHAR,
  reason            VARCHAR,
  owners            INTEGER NOT NULL,
  candidates        VARCHAR NOT NULL,
  menu_overflow     BOOLEAN NOT NULL,
  priority          DOUBLE  NOT NULL,
  PRIMARY KEY (source_rel_path, site_key)
);
CREATE TABLE IF NOT EXISTS cg_residual_calibration (
  language          VARCHAR NOT NULL,
  stratum           VARCHAR NOT NULL,
  threshold         DOUBLE,
  lower_bound       DOUBLE,
  n                 INTEGER NOT NULL,
  pi                DOUBLE,
  none_rates        VARCHAR,
  model             VARCHAR NOT NULL,
  template_hash     VARCHAR NOT NULL,
  graph_fingerprint VARCHAR NOT NULL,
  created_at        BIGINT  NOT NULL,
  PRIMARY KEY (language, stratum)
);
