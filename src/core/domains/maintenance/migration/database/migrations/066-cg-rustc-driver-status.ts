/**
 * Codegraph schema — the rustc call-site driver's outcome (bd s3i8m).
 *
 * `cg_rustc_driver_status`: how the driver settled on the last codegraph run
 * that resolved Rust, as the `RustcDriverStatus` JSON the surfaces render, plus
 * when that run finalized. At most one row: every run that resolved Rust
 * replaces it, a run that resolved none leaves it. It is a new table rather than
 * a column on `cg_run_stats`, whose rows are per receiver kind and written only
 * by whole-corpus runs — the driver acquires on incremental runs too.
 *
 * Additive: a database that predates it simply has no status to report.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_066_CG_RUSTC_DRIVER_STATUS = `
CREATE TABLE IF NOT EXISTS cg_rustc_driver_status (
  status_json    VARCHAR NOT NULL,
  recorded_at_ms BIGINT  NOT NULL
);
`;
