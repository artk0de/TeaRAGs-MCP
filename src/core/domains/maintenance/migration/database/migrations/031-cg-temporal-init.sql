
CREATE TABLE IF NOT EXISTS cg_temporal_files (
  rel_path         VARCHAR PRIMARY KEY,
  bundle_count     INTEGER NOT NULL,
  partner_count    INTEGER NOT NULL,
  last_changed_at  BIGINT  NOT NULL
);
CREATE TABLE IF NOT EXISTS cg_temporal_edges_cochange (
  rel_path_a         VARCHAR NOT NULL,
  rel_path_b         VARCHAR NOT NULL,
  support            INTEGER NOT NULL,
  confidence_ab      DOUBLE  NOT NULL,
  confidence_ba      DOUBLE  NOT NULL,
  lift               DOUBLE  NOT NULL,
  last_co_change_at  BIGINT  NOT NULL,
  sample_commits     VARCHAR NOT NULL,
  PRIMARY KEY (rel_path_a, rel_path_b)
);
CREATE TABLE IF NOT EXISTS cg_temporal_meta (
  meta_key               VARCHAR PRIMARY KEY,
  head                   VARCHAR NOT NULL,
  fingerprint            VARCHAR NOT NULL,
  built_at               BIGINT  NOT NULL,
  window_since           BIGINT  NOT NULL,
  commit_count           INTEGER NOT NULL,
  bundle_count           INTEGER NOT NULL,
  admitted_bundle_count  INTEGER NOT NULL,
  max_files_per_bundle   INTEGER NOT NULL,
  min_support            INTEGER NOT NULL,
  max_partners_per_file  INTEGER NOT NULL,
  session_gap_minutes    INTEGER
);
