import { resolve } from "node:path";

import type {
  WorktreeCreateInput,
  WorktreeCreateResult,
  WorktreeInfo,
  WorktreeRemoveInput,
} from "../../../contracts/index.js";
import type { WorktreeProvisioner } from "../../../domains/maintenance/worktree/index.js";
import type { CollectionEntry, CollectionRegistry } from "../../../domains/maintenance/registry/index.js";

/**
 * WorktreeOps — CLI-facing facade over the maintenance worktree domain.
 *
 * Worktree management is a CLI-only maintenance concern, so this facade is
 * re-exported through `api/public` for the CLI to instantiate directly (mirrors
 * `ProjectRegistryOps`) and is NOT part of the `App` / MCP contract. Commands
 * delegate to `WorktreeProvisioner`; read queries (`list` / `info`) are pure
 * registry reads exposed as standalone helpers below (CQS).
 */
export class WorktreeOps {
  constructor(private readonly provisioner: WorktreeProvisioner) {}

  async create(input: WorktreeCreateInput): Promise<WorktreeCreateResult> {
    return this.provisioner.create(input);
  }

  async remove(input: WorktreeRemoveInput): Promise<{ removed: boolean }> {
    return this.provisioner.remove(input);
  }
}

/**
 * Single source of the worktree read shape: maps a registry entry to a
 * `WorktreeInfo`. Used by both the list and info query helpers below.
 */
export function toWorktreeInfo(entry: CollectionEntry): WorktreeInfo {
  return {
    isWorktree: true,
    collectionName: entry.collectionName,
    alias: entry.name ?? undefined,
    worktreeOf: entry.worktreeOf,
    worktreeName: entry.worktreeName,
    chunksCount: entry.chunksCount,
  };
}

/** Query: every worktree clone in the registry as `WorktreeInfo`. */
export function listWorktreeInfos(registry: CollectionRegistry): WorktreeInfo[] {
  return registry.listWorktrees().map(toWorktreeInfo);
}

/** Query: worktree info for a working directory (`isWorktree:false` when not one). */
export function worktreeInfoForPath(registry: CollectionRegistry, cwd: string): WorktreeInfo {
  const entry = registry.findByPath(resolve(cwd));
  if (entry?.worktreeOf === undefined) return { isWorktree: false };
  return toWorktreeInfo(entry);
}
