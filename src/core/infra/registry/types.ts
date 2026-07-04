/**
 * Project Registry types — schema for $TEA_RAGS_DATA_DIR/registry.json.
 *
 * See docs/superpowers/specs/2026-05-12-project-registry-design.md §2.
 */

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
   * Tuning env vars (curated allowlist — see `tuning-env.ts`) that were SET
   * in the indexing process env at index time, keyed by the exact env var
   * name the operator exported. The MCP server's env block carries these, but
   * CLI `index-codebase` and prime run in a fresh shell without them — so
   * consumers re-apply this map registry-first before building config, with
   * explicit process env winning over the stored value (env > registry >
   * code default). Same registry-first lookup as `codegraphEnabled`. Absent
   * when no tuning var was set at index time and for pre-existing registry
   * entries (treated as untuned — code defaults apply).
   */
  tuning?: Record<string, string>;
  /** Source collection logical name when this entry is a worktree clone. */
  worktreeOf?: string;
  /** Worktree name (the `<name>` in `<project>-worktree-<name>`). */
  worktreeName?: string;
  indexedAt: string;
  teaRagsVersion: string;
  chunksCount: number;
}

/**
 * Partial entry used when registry.record() is invoked from the pipeline.
 * `name` is sticky and managed exclusively via setName().
 */
export type RecordEntryInput = Omit<CollectionEntry, "name">;

export interface RegistryFileV1 {
  version: 1;
  collections: Record<string, CollectionEntry>;
}

/** Wire shape returned by list_projects MCP tool. */
export type ProjectInfo = CollectionEntry;
