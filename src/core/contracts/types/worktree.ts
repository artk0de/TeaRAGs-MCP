/**
 * Worktree maintenance contracts — shared shapes for per-worktree index clones.
 *
 * Produced by the maintenance domain (`WorktreeProvisioner`) and consumed by the
 * CLI through `api/public`. They live in `contracts/` rather than
 * `api/public/dto` because the domain that produces them cannot import upward
 * into `api/` — the same relocation pattern as `IngestCodeConfig` /
 * `EnrichmentHealthMap`.
 */

/** Input for cloning a source index into a new worktree collection. */
export interface WorktreeCreateInput {
  name: string;
  from?: string;
  path?: string;
  createGit: boolean;
  branch?: string;
}

/** Input for tearing down a worktree index clone. */
export interface WorktreeRemoveInput {
  name: string;
  force: boolean;
  keepGit: boolean;
}

/** Result of a successful worktree clone. */
export interface WorktreeCreateResult {
  collectionName: string;
  alias: string;
  sourceProject: string;
  worktreePath: string;
}

/** Read view of a worktree clone (or a non-worktree path). */
export interface WorktreeInfo {
  isWorktree: boolean;
  collectionName?: string;
  alias?: string;
  worktreeOf?: string;
  worktreeName?: string;
  chunksCount?: number;
}
