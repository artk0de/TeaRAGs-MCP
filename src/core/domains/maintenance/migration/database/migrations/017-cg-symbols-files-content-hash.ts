/**
 * Codegraph schema — per-file content hash on `cg_symbols_files`
 * (bd tea-rags-mcp-6goqa).
 *
 * `cg_symbols_files` held only `(rel_path, language)`, so the graph could tell
 * whether a file was PRESENT but not whether its rows were CURRENT. A file only
 * ever heals when it is itself re-extracted, so a dead import edge survived
 * every incremental reindex once its file stopped changing. The repair check
 * diffs this column against the SHA256 the ingest snapshot already stores per
 * file, which costs no extra I/O.
 *
 * Nullable with no default: rows written before this column existed read back as
 * NULL, and the repair check treats NULL as "unknown, therefore re-extract".
 * Defaulting to anything else would assert those rows are current — the exact
 * assumption that hid the shadow-DuckDB defect.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_017_CG_SYMBOLS_FILES_CONTENT_HASH = `
ALTER TABLE cg_symbols_files ADD COLUMN IF NOT EXISTS content_hash VARCHAR;
`;
