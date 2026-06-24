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
