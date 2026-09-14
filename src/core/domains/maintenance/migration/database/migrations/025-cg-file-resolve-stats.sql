
CREATE TABLE IF NOT EXISTS cg_file_resolve_stats (
  rel_path            VARCHAR NOT NULL,
  receiver_kind       VARCHAR NOT NULL,
  language            VARCHAR NOT NULL,
  attempted           INTEGER NOT NULL,
  resolved            INTEGER NOT NULL,
  external_skipped    INTEGER NOT NULL DEFAULT 0,
  unresolvable        INTEGER NOT NULL DEFAULT 0,
  no_in_project_def   INTEGER NOT NULL DEFAULT 0,
  core_ambiguous      INTEGER NOT NULL DEFAULT 0,
  ambiguous_fanout    INTEGER NOT NULL DEFAULT 0,
  unnarrowed_template INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (rel_path, receiver_kind)
);

CREATE TABLE IF NOT EXISTS cg_file_resolve_stats_coverage (
  language VARCHAR PRIMARY KEY
);
