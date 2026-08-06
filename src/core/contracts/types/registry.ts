/**
 * Project Registry types — schema for $TEA_RAGS_DATA_DIR/registry.json.
 *
 * See docs/superpowers/specs/2026-05-12-project-registry-design.md §2.
 */

/**
 * Git state the index represents, captured at Index/ReindexPipeline finalize.
 * Written through `record()` on every run (pipeline owns it). Absent when the
 * project path is not a git repository or for pre-existing registry entries.
 */
export interface RegistryGitState {
  /** Branch checked out at index time; null = detached HEAD. */
  indexedBranch: string | null;
  /** Resolved HEAD sha at index time ("" when the ref could not be resolved). */
  indexedCommit: string;
  /** Working tree had uncommitted changes at index time. */
  indexedDirty: boolean;
}

/** Outcome of one detached auto-update run (spec §4 step 5). */
export interface AutoUpdateRunRecord {
  /** ISO timestamp of run completion. */
  at: string;
  outcome: "ok" | "no-op" | "skipped" | "lock-held" | "failed";
  durationMs: number;
  filesChanged: number;
  /** Present only for `outcome: "failed"`; trimmed message. */
  error?: string;
}

/**
 * Auto-update policy for a project. Sticky like `name`: `record()` preserves
 * it across pipeline reruns; managed exclusively via `setAutoUpdate()` /
 * `recordAutoUpdateRun()` (CLI + updater). Absent = auto-update disabled.
 */
export interface RegistryAutoUpdateConfig {
  enabled: boolean;
  /** Auto-update fires only when repo HEAD is on this branch. */
  targetBranch: string;
  lastRun?: AutoUpdateRunRecord;
}

export interface CollectionEntry {
  collectionName: string;
  path: string;
  name: string | null;
  embeddingModel: string;
  embeddingDimensions: number;
  qdrantUrl: string;
  /**
   * Whether `qdrantUrl` was the embedded Qdrant daemon at index time. The daemon
   * binds an ephemeral free port and may rebind on restart, so the stored
   * `qdrantUrl` is a point-in-time value. Consumers that re-launch indexing seed
   * the embedded marker (not the frozen port) when this is true, so the worker
   * re-resolves the daemon (fresh port + reconnect) instead of pinning a stale
   * URL in external mode. Optional for backward compatibility with pre-existing
   * registry entries (treated as non-embedded / external).
   */
  qdrantEmbedded?: boolean;
  /**
   * Embedding endpoint the project was last indexed against. Symmetric with
   * `qdrantUrl` — prime CLI / run-prime register-first lookups read it so
   * the digest reflects the actual endpoint, not the current shell's env.
   * Optional for backward compatibility with pre-existing registry entries.
   */
  embeddingBaseUrl?: string;
  /**
   * Embedding fallback endpoint (Ollama EMBEDDING_FALLBACK_URL) at index
   * time. Same registry-first lookup as `embeddingBaseUrl`. Undefined when
   * none was configured at index time.
   */
  embeddingFallbackUrl?: string;
  /**
   * Whether the codegraph trajectory family (CODEGRAPH_ENABLED) was active at
   * index time. Codegraph signals land in the payload only when enabled, and
   * the prime CLI must declare the matching signal descriptors or it reports a
   * phantom "removed fields" schema drift. The MCP server's env carries the
   * flag, but the prime hook runs in a fresh shell without it — so prime reads
   * this back register-first and re-applies CODEGRAPH_ENABLED before building
   * the composition. Same registry-first lookup as `embeddingBaseUrl`. Optional
   * for backward compatibility with pre-existing registry entries.
   */
  codegraphEnabled?: boolean;
  /**
   * The FULL effective env set of the last indexing run (canonical keys,
   * code defaults materialized — see `env-groups.ts` /
   * `bootstrap/config/env-snapshot.ts`), excluding identity keys stored in
   * the dedicated fields above, secrets, and server/process knobs. Consumers
   * re-apply the map registry-first with the ONE general rule `outer env >
   * registry env > code default` (alias-group aware). Absent only for
   * pre-existing registry entries — those fall back to `tuning`.
   */
  env?: Record<string, string>;
  /**
   * DEPRECATED legacy field (pre-9vpnz "tuning snapshot"): only-when-set
   * env keys of old runs. Read as a fallback when `env` is absent; never
   * written anymore.
   */
  tuning?: Record<string, string>;
  /** Source collection logical name when this entry is a worktree clone. */
  worktreeOf?: string;
  /** Worktree name (the `<name>` in `<project>-worktree-<name>`). */
  worktreeName?: string;
  /** Git state the index represents (see RegistryGitState). */
  git?: RegistryGitState;
  /** Auto-update policy (see RegistryAutoUpdateConfig). Sticky like `name`. */
  autoUpdate?: RegistryAutoUpdateConfig;
  indexedAt: string;
  teaRagsVersion: string;
  chunksCount: number;
}

/**
 * Partial entry used when registry.record() is invoked from the pipeline.
 * `name` and `autoUpdate` are sticky and managed exclusively via setName() /
 * setAutoUpdate().
 */
export type RecordEntryInput = Omit<CollectionEntry, "name" | "autoUpdate">;

export interface RegistryFileV1 {
  version: 1;
  collections: Record<string, CollectionEntry>;
}

/** Wire shape returned by list_projects MCP tool. */
export type ProjectInfo = CollectionEntry;

/**
 * The registry surface a module outside the owning domain may depend on.
 *
 * The concrete `CollectionRegistry` lives in `domains/maintenance/registry/`;
 * the ingest pipeline only records an entry after an indexing run and receives
 * the instance by DI, so it types that parameter with this port instead of
 * reaching into a sibling domain.
 */
export interface CollectionRegistryPort {
  record: (entry: RecordEntryInput) => void;
}
