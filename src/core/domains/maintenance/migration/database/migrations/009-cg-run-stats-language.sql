
DROP TABLE IF EXISTS cg_run_stats;
CREATE TABLE IF NOT EXISTS cg_run_stats (
  language         VARCHAR NOT NULL DEFAULT '',
  receiver_kind    VARCHAR NOT NULL,
  attempted        INTEGER NOT NULL,
  resolved         INTEGER NOT NULL,
  external_skipped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (language, receiver_kind)
);
