-- bd tea-rags-mcp-cnqrg — re-grain cg_run_stats to (language, receiver_kind).
--
-- The single-column receiver_kind PRIMARY KEY rejects two languages that share
-- a receiver kind (e.g. (typescript, constant) + (ruby, constant)), so the
-- table is recreated with a composite PRIMARY KEY (language, receiver_kind).
-- cg_run_stats is a transient per-run cache — recordRunStats DELETEs + INSERTs
-- the whole table every enrichment run — so dropping it loses nothing; the next
-- run repopulates it. DuckDB cannot ALTER a PRIMARY KEY in place.
DROP TABLE IF EXISTS cg_run_stats;
CREATE TABLE IF NOT EXISTS cg_run_stats (
  language         VARCHAR NOT NULL DEFAULT '',
  receiver_kind    VARCHAR NOT NULL,
  attempted        INTEGER NOT NULL,
  resolved         INTEGER NOT NULL,
  external_skipped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (language, receiver_kind)
);
