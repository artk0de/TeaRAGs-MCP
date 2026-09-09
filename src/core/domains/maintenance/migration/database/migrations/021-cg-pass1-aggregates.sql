-- Codegraph schema — persist the per-file pass-1 aggregate slice (bd znxg8).
-- `cg_symbols` hydrates on open, so definition lookups see the whole project;
-- the run-global ancestry / self-dispatch registries pass-2 resolves against
-- were built only from the CURRENT batch. An incremental run therefore matched a
-- complete symbol table against a batch-sized registry, which mis-resolves
-- rather than under-resolves: concrete `SomeService.call(...)` entries degraded
-- onto the shared template they inherit. One row per file, written on the same
-- per-file reconciliation as the edge tables; the slice is JSON in one column
-- because it is read back whole, once per run, and never queried by field.
-- No secondary indexes — the only read is a full scan (cf. migration 019).
-- Mirrors 021-cg-pass1-aggregates.ts — keep in sync.
CREATE TABLE IF NOT EXISTS cg_pass1_aggregates (
  rel_path        VARCHAR NOT NULL,
  language        VARCHAR NOT NULL,
  aggregates_json VARCHAR NOT NULL,
  PRIMARY KEY (rel_path)
);
