/**
 * Index freshness barrel — auto-update watcher decision surface (hpg2).
 *
 * Sits next to `maintenance/registry/`, which it reads. Consumers outside
 * core (cli/mcp/bootstrap) reach it via `core/api/public`.
 */

export { AUTO_UPDATE_FAILURE_BACKOFF_MS, AUTO_UPDATE_RUN_TTL_MS, IndexFreshnessCheck } from "./freshness-check.js";
export type { IndexFreshnessCheckDeps, IndexFreshnessVerdict } from "./freshness-check.js";
