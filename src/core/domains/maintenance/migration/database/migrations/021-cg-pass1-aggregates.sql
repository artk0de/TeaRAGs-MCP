
CREATE TABLE IF NOT EXISTS cg_pass1_aggregates (
  rel_path        VARCHAR NOT NULL,
  language        VARCHAR NOT NULL,
  aggregates_json VARCHAR NOT NULL,
  PRIMARY KEY (rel_path)
);
