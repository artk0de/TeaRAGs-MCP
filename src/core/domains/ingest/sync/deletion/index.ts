/**
 * Deletion subdomain barrel.
 *
 * Re-exports the 3-level fallback deletion cascade (strategy + executor + retry
 * helper), the per-path outcome type, and the post-deletion reindex
 * coordinator. Consumers outside `sync/deletion/` import from here.
 */
export { performDeletion, type DeletionConfig } from "./strategy.js";
export { BatchDeleteExecutor } from "./batch-executor.js";
export { DeletionRetryHelper, type RetryOptions, type AttemptFn } from "./retry-helper.js";
export { createDeletionOutcome, type DeletionOutcome } from "./outcome.js";
export { ReindexCoordinator } from "./reindex-coordinator.js";
