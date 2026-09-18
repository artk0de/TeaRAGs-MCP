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

/**
 * Why a registered sibling did not seed a new working tree's first index
 * (bd tea-rags-mcp-k8gac). The first five are stamp mismatches
 * (`checkWorktreeSeedCompatibility`); the rest are live facts established while
 * trying.
 */
export type WorktreeSeedRejectionReason =
  | "qdrant-backend"
  | "embedding-model"
  | "payload-schema"
  | "language-versions"
  | "index-env"
  /** No collection behind the entry, or its last index never completed. */
  | "source-not-indexed"
  /** An index run or its background enrichment holds the sibling right now. */
  | "source-busy"
  | "clone-failed";

/** Which registered collection a seed came from, or was refused by. */
export interface WorktreeSeedSourceRef {
  collectionName: string;
  /** Registered alias, when the sibling has one. */
  project: string | null;
  path: string;
}

/** One sibling that was considered and refused, with the stamp or fact that refused it. */
export interface WorktreeSeedCandidateRejection extends WorktreeSeedSourceRef {
  reason: WorktreeSeedRejectionReason;
  detail: string;
}

/**
 * What a first index did about seeding from a sibling working tree. Present on
 * an `IndexStats` whenever the run was a first index the seed could have
 * applied to; absent on incremental, forced and recompute runs.
 *
 * `seeded`: the sibling's footprint was cloned and the ordinary incremental
 * sync embedded only what differs — `filesCopied` kept their sibling points
 * verbatim, `filesIndexed` were embedded by this run, `filesRemoved` existed in
 * the sibling only. `gitRefresh` says whether the git layer is being rebuilt
 * against THIS worktree's history (it runs as the run's background enrichment).
 *
 * `skipped`: a normal first index ran, for `reason`; `rejected` lists every
 * sibling that was considered, when there was any.
 */
export type WorktreeSeedReport =
  | {
      status: "seeded";
      source: WorktreeSeedSourceRef;
      filesCopied: number;
      filesIndexed: number;
      filesRemoved: number;
      gitRefresh: "background" | "not-applicable";
      /** Newer siblings refused before `source` was accepted. */
      rejected: WorktreeSeedCandidateRejection[];
    }
  | {
      status: "skipped";
      reason: "disabled" | "restricted-run" | "no-sibling" | "no-compatible-sibling";
      rejected: WorktreeSeedCandidateRejection[];
    };
