/**
 * CodegraphEnrichmentProvider factory shape — the rebuild seam for the
 * unified enrichment worker pool (Phase 2 of the worker-pool plan).
 *
 * `CodegraphWorkerConfig` is the structured-clone-safe payload that lives
 * on `WorkerEnrichmentDescriptor.serializableConfig` for codegraph. The
 * worker thread receives this object via `workerData` / `postMessage`,
 * then in-thread:
 *   - `await import(config.languageModulePath)` — rebuild the
 *     `LanguageFactoryDescriptor` (mirrors the chunker precedent at
 *     `ChunkerConfig.languageModulePath`).
 *   - `new DaemonGraphDbClient(config.daemonSocketPath)` — connect to the
 *     existing multi-client daemon socket (memory project
 *     `project_codegraph_daemon` — daemon already serialises DuckDB access
 *     across processes).
 *
 * Non-serializable deps (`LanguageFactoryDescriptor`, DuckDB pool / client) are NEVER
 * carried on the descriptor — only string paths the worker resolves
 * in-thread. This preserves the `.claude/rules/domains-language.md`
 * invariant: the `ingest`-owned worker entry stays domain-internal, with
 * NO static cross-domain import and NO eslint guard exemption.
 *
 * The actual `createCodegraphEnrichmentProvider(config)` factory function
 * — which reads this config, opens the daemon, and constructs the
 * provider — lives in Phase 2 Task 4 alongside the worker entry. This
 * file declares the type seam Task 4 builds on, plus the inline-mode
 * shape the composition root uses today.
 */

/**
 * Structured-clone-safe configuration the worker thread reads to rebuild a
 * `CodegraphEnrichmentProvider` in-process. Every field MUST be plain data —
 * NO class instances, NO function references, NO file handles. The named
 * factory export is the sole interpreter of this payload.
 */
export interface CodegraphWorkerConfig {
  /**
   * Absolute compiled-JS path to the language-factory module the worker
   * dynamic-imports in-thread. Mirrors `ChunkerConfig.languageModulePath`
   * exactly — the worker calls `(await import(path)).LanguageFactoryDescriptor` (or
   * the equivalent named export Task 4 chooses) to get the per-language
   * walker + resolver capabilities.
   */
  languageModulePath: string;
  /**
   * Absolute socket path of the running `DaemonGraphDbClient` daemon
   * (`adapters/duckdb/daemon/`). The worker opens a fresh multi-client
   * connection to this socket — the daemon owns the exclusive DuckDB RW
   * lock and serialises writes across processes, so a worker-side
   * connection is safe by construction.
   *
   * When undefined (test fixtures, inline-mode bypass), the consuming
   * factory must short-circuit to a direct-mode provider — the worker
   * entry won't be exercised in that path.
   */
  daemonSocketPath?: string;
  /**
   * The Qdrant collection name this provider instance is pinned to. Used
   * as the affinity routing key (`WorkerPool.dispatch(req, collectionName)`)
   * AND as the DuckDB partition selector inside the per-worker provider
   * cache `Map<collectionName, providerInstance>`. Optional only because
   * inline-mode callers (composition root in tests) may construct the
   * provider before a specific collection is bound.
   */
  collectionName?: string;
  /**
   * Codegraph-layer exclusion of conventional test files from the
   * call/import graph. Defaults to `true` to match the env-var contract.
   * Test files still get indexed into Qdrant — this only keeps them out
   * of the codegraph fan-graph signals (`fanIn` / `fanOut` / hub
   * detection / PageRank).
   */
  excludeTests?: boolean;
  /**
   * `.gitignore`-shaped patterns layered on top of the test exclusions.
   * Sourced from `CODEGRAPH_CUSTOM_EXCLUDE` env var at composition time.
   */
  customExcludePatterns?: readonly string[];
}
