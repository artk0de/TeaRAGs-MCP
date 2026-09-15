/**
 * Maintenance domain errors — worktree operations.
 */

import type { IndexingLockHolder } from "../../contracts/types/footprint.js";
import { TeaRagsError } from "../../infra/errors.js";

/**
 * Maintenance domain error codes. Local strict union.
 */
export type MaintenanceErrorCode =
  | "MAINTENANCE_WORKTREE_SOURCE_NOT_FOUND"
  | "MAINTENANCE_WORKTREE_COLLECTION_EXISTS"
  | "MAINTENANCE_WORKTREE_NOT_FOUND"
  | "MAINTENANCE_INDEXING_LOCK_HELD";

/**
 * Abstract base for all maintenance domain errors.
 * Default httpStatus: 400.
 */
export abstract class MaintenanceError extends TeaRagsError {
  constructor(opts: { code: MaintenanceErrorCode; message: string; hint: string; httpStatus?: number; cause?: Error }) {
    super({ ...opts, httpStatus: opts.httpStatus ?? 400 });
  }
}

/** Source project not found when creating a worktree. */
export class WorktreeSourceNotFoundError extends MaintenanceError {
  constructor(from: string) {
    super({
      code: "MAINTENANCE_WORKTREE_SOURCE_NOT_FOUND",
      message: `Source project not found (from=${from})`,
      hint: "Pass --from with a valid project name, or run from the project directory",
      httpStatus: 404,
    });
  }
}

/** Target collection already exists — cannot clone into it. */
export class WorktreeCollectionExistsError extends MaintenanceError {
  constructor(collectionName: string) {
    super({
      code: "MAINTENANCE_WORKTREE_COLLECTION_EXISTS",
      message: `Target collection already exists: ${collectionName}`,
      hint: "Choose a different worktree name or remove the existing collection first",
      httpStatus: 409,
    });
  }
}

/**
 * A footprint teardown reached a collection whose indexing lock a live run still
 * holds (bd tea-rags-mcp-39xca.13). The lock was left in place; everything else
 * the teardown owns proceeds.
 */
export class IndexingLockHeldError extends MaintenanceError {
  constructor(collectionName: string, holder?: IndexingLockHolder) {
    const heldBy = holder ? ` (pid ${holder.pid} on ${holder.hostname}, ${holder.operation})` : "";
    super({
      code: "MAINTENANCE_INDEXING_LOCK_HELD",
      message: `Collection "${collectionName}" is being indexed by a live run${heldBy} — its indexing lock was left in place`,
      hint: "Wait for that run to finish (get_index_status), then remove again. A crashed run's lock is reclaimed once its process is gone or its heartbeat is 10 minutes old.",
      httpStatus: 409,
    });
  }
}

/** Entry is not a worktree clone — refusing to remove. */
export class WorktreeNotFoundError extends MaintenanceError {
  constructor(name: string) {
    super({
      code: "MAINTENANCE_WORKTREE_NOT_FOUND",
      message: `'${name}' is not a worktree clone (refusing to remove)`,
      hint: "Use worktree list to see available worktrees",
      httpStatus: 404,
    });
  }
}
