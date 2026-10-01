
CREATE TABLE IF NOT EXISTS cg_temporal_bundle_files (
  bundle_id  INTEGER NOT NULL,
  rel_path   VARCHAR NOT NULL,
  PRIMARY KEY (bundle_id, rel_path)
);
