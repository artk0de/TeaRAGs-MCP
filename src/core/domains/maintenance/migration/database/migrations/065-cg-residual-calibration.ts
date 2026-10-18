/**
 * Codegraph schema — per-repository Kev self-calibration (bd
 * tea-rags-mcp-2m83f.62).
 *
 * `cg_static_site_sample`: a deterministic sample of the call sites the static
 * resolver settled — resolved to one in-project target, or skipped as
 * external — on a non-constant receiver whose member a project class defines.
 * A site joins when its hash priority falls under a fixed admission rate, so
 * the sample is per-site stable and rides the per-file reconciliation;
 * calibration draws the lowest priorities. `candidates` is the residual menu
 * the site would get (sorted method symbolIds, the name-matched block when the
 * owners overflow the menu limit), `owners` the full owner count.
 *
 * `cg_residual_calibration`: the fitted accept threshold per (language,
 * stratum), valid only for the model and prompt-template hash it was fitted
 * under.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_065_CG_RESIDUAL_CALIBRATION = `
CREATE TABLE IF NOT EXISTS cg_static_site_sample (
  source_rel_path   VARCHAR NOT NULL,
  site_key          VARCHAR NOT NULL,
  language          VARCHAR NOT NULL,
  method_symbol_id  VARCHAR NOT NULL,
  method_start_line INTEGER NOT NULL,
  method_end_line   INTEGER NOT NULL,
  line              INTEGER NOT NULL,
  call_column       INTEGER NOT NULL,
  receiver_text     VARCHAR NOT NULL,
  receiver_kind     VARCHAR NOT NULL,
  member            VARCHAR NOT NULL,
  outcome           VARCHAR NOT NULL,
  target_symbol_id  VARCHAR,
  reason            VARCHAR,
  owners            INTEGER NOT NULL,
  candidates        VARCHAR NOT NULL,
  menu_overflow     BOOLEAN NOT NULL,
  priority          DOUBLE  NOT NULL,
  PRIMARY KEY (source_rel_path, site_key)
);
CREATE TABLE IF NOT EXISTS cg_residual_calibration (
  language          VARCHAR NOT NULL,
  stratum           VARCHAR NOT NULL,
  threshold         DOUBLE,
  lower_bound       DOUBLE,
  n                 INTEGER NOT NULL,
  pi                DOUBLE,
  none_rates        VARCHAR,
  model             VARCHAR NOT NULL,
  template_hash     VARCHAR NOT NULL,
  graph_fingerprint VARCHAR NOT NULL,
  created_at        BIGINT  NOT NULL,
  PRIMARY KEY (language, stratum)
);
`;
