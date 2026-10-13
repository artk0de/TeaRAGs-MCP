
CREATE TABLE IF NOT EXISTS cg_symbols_edges_field (
  source_rel_path  VARCHAR NOT NULL,
  source_symbol_id VARCHAR NOT NULL,
  owner_kind       VARCHAR NOT NULL,
  owner_type       VARCHAR,
  receiver         VARCHAR,
  field_name       VARCHAR NOT NULL,
  access_kind      VARCHAR NOT NULL,
  access_count     INTEGER NOT NULL,
  first_line       INTEGER
);
