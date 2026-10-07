
CREATE TABLE IF NOT EXISTS cg_temporal_bundle_commits (
  bundle_id    INTEGER NOT NULL PRIMARY KEY,
  commit_shas  VARCHAR NOT NULL
);
