/**
 * Codegraph schema — persist the per-file PASS-1 AGGREGATE slice
 * (bd tea-rags-mcp-znxg8).
 *
 * `cg_symbols` is hydrated when the collection opens, so definition lookups see
 * the whole project on every run. The run-global maps pass-2 resolves against —
 * ancestry, the hierarchy view, the self-dispatch template registry — were
 * assembled only from the files the CURRENT batch walked. An incremental run
 * therefore resolved a complete symbol table against a batch-sized registry,
 * which mis-resolves rather than under-resolves: with the shared template
 * missing from the registry the Ruby entry strategy stands down and the
 * constant strategy's ancestor walk lands every concrete `SomeService.call(...)`
 * on the mixin's own method. The field report sampled 200 caller edges of one
 * such hub and found 200 of 200 degraded that way, from 134 files, while
 * `inProjectEdgeRecall` read 1.0.
 *
 * One row per file, written on the same per-file reconciliation as the edge
 * tables (`applyScopedRowDiff` scoped by `rel_path`), so the row is replaced
 * when the file is re-walked and deleted when the file is. The aggregate slice
 * itself is JSON in a single column: it is read back whole, exactly once per
 * run, and never queried by field — the same reasoning that keeps `scope_json`
 * a JSON-encoded VARCHAR in `cg_symbols` (migration 002) rather than a DuckDB
 * list type.
 *
 * No secondary indexes. The only read is a full table scan for hydration; an
 * index on `language` would earn nothing and migration 019 removed exactly that
 * kind of unearned index elsewhere.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_021_CG_PASS1_AGGREGATES = `
CREATE TABLE IF NOT EXISTS cg_pass1_aggregates (
  rel_path        VARCHAR NOT NULL,
  language        VARCHAR NOT NULL,
  aggregates_json VARCHAR NOT NULL,
  PRIMARY KEY (rel_path)
);
`;
