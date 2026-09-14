/**
 * Codegraph schema — per-FILE resolve tallies (bd tea-rags-mcp-xpmwg).
 *
 * `cg_run_stats` holds what the LAST run resolved, replaced per language. That
 * is a corpus measurement only while every run sees the whole corpus of the
 * languages it touches, and an incremental run does not: one `.tsx` file
 * re-resolved on taxdome replaced the typescript breakdown (bareCall
 * 122777/175773 after a full recompute) with that file's handful of calls,
 * `summarizeCodegraphResolve` then dropped typescript under
 * `MIN_LANGUAGE_SHARE`, and prime showed ruby alone.
 *
 * `cg_file_resolve_stats` stores the tally per caller file instead. A run
 * replaces the rows of exactly the files it resolved, deleting a file drops its
 * rows, and the read sums them per (language, receiver kind) — so the report
 * describes the corpus however few files the last run touched.
 *
 * `cg_file_resolve_stats_coverage` names the languages whose per-file rows a
 * whole-corpus run has populated. It is EMPTY after this migration, and that is
 * what keeps the upgrade honest: until a full index or a
 * `--force-enrichments codegraph` covers a language, its per-file rows describe
 * only the files incremental runs happened to touch, so the read keeps using the
 * `cg_run_stats` measurement for it. Without the table the first small
 * incremental after the upgrade would reproduce the very bug this fixes.
 *
 * Counters are INTEGER: one file's call sites, summed at read. Keyed by
 * (rel_path, receiver_kind) — a file carries one language, so the language is a
 * value column, not part of the key.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_025_CG_FILE_RESOLVE_STATS = `
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
`;
