/**
 * Codegraph schema — residual sites a model put outside the project (bd
 * tea-rags-mcp-2m83f.45, residual wave 1.5).
 *
 * One row per residual site whose verdict is "none of these — defined outside
 * the project" at or above `CODEGRAPH_RESIDUAL_NONE_THRESHOLD`. The residual
 * pass replaces a model's rows on every run; the status reads them joined to
 * `cg_residual_call_sites` on (path, site, menu hash), so a site that is gone
 * or whose menu changed no longer counts, and needs no verdict store.
 *
 * Companion `.sql` mirrors this for the disk-loading test path. Keep in sync.
 */
export const SQL_058_CG_RESIDUAL_EXTERNAL_SITES = `
CREATE TABLE IF NOT EXISTS cg_residual_external_sites (
  model           VARCHAR NOT NULL,
  source_rel_path VARCHAR NOT NULL,
  site_key        VARCHAR NOT NULL,
  menu_hash       VARCHAR NOT NULL,
  p               DOUBLE  NOT NULL,
  PRIMARY KEY (model, source_rel_path, site_key)
);
`;
