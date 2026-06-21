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

import { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type { AmbiguousResolveMode } from "../../../contracts/types/codegraph.js";
import type {
  CollectSymbolsFn,
  LanguageFactoryDescriptor,
  SymbolIdComposer,
} from "../../../contracts/types/language.js";
import type { WorkerEnrichmentDescriptor } from "../../../contracts/types/provider.js";
import { CodegraphEnrichmentProvider } from "./symbols/provider.js";
import { CODEGRAPH_SYMBOLS_DERIVED_SIGNALS } from "./symbols/rerank/derived-signals/index.js";
import { CODEGRAPH_SYMBOLS_PRESETS } from "./symbols/rerank/presets/index.js";
import { InMemoryGlobalSymbolTable } from "./symbols/symbol-table.js";

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
  /**
   * Root directory under which the per-collection DuckDB files live
   * (`<rootDir>/codegraph/<collection>.duckdb`). The worker rebuilds a
   * `GraphDbClientPool` rooted here — identical to `wireCodegraph`'s
   * `rootDir` — so the worker-side pool addresses the SAME files the
   * daemon owns. Required: a pool-mode provider cannot be built without it.
   */
  rootDir: string;
  /**
   * DuckDB per-collection memory ceiling (`CODEGRAPH_DB_MEMORY_LIMIT`),
   * threaded so the worker-side pool applies the same resource cap as the
   * main-thread pool. Reads `acquireWrite` through the daemon, so this only
   * matters for the rare in-process fallback, but mirroring keeps the two
   * pools structurally identical.
   */
  dbMemoryLimit?: string;
  /** DuckDB thread cap (`CODEGRAPH_DB_THREADS`); see `dbMemoryLimit`. */
  dbThreads?: number;
  /**
   * Ambiguous-call resolution mode (`codegraph.ambiguousResolveMode`).
   * Threaded so the in-thread `LanguageFactory` builds each native
   * provider's resolver with the SAME mode as the main thread.
   */
  ambiguousResolveMode?: AmbiguousResolveMode;
}

/**
 * Runtime shape of the dynamically-imported `domains/language` barrel. Typed
 * against the `contracts/` interfaces only — never the concrete classes — so
 * the FACTORY carries no static `domains/language` dependency either (the
 * `import(variable)` is invisible to `no-restricted-imports`). Mirrors the
 * chunker worker's `LanguageModule` interface exactly.
 */
interface LanguageModule {
  LanguageFactory: new (options?: { ambiguousResolveMode?: AmbiguousResolveMode }) => LanguageFactoryDescriptor;
  DefaultSymbolIdComposer: new () => SymbolIdComposer;
  collectSymbols: CollectSymbolsFn;
}

/**
 * Build a `CodegraphEnrichmentProvider` from a structured-clone-safe config —
 * the named factory export the enrichment worker dynamic-imports in-thread
 * (`WorkerEnrichmentDescriptor.providerFactoryExport`). Also called directly by
 * the composition root for the inline path (descriptor attached, executor still
 * dispatches off-thread for OTHER collections but rebuilds this one in-thread).
 *
 * In-thread reconstruction (the rebuild seam):
 *   1. `await import(config.languageModulePath)` → build `LanguageFactory`
 *      (with `ambiguousResolveMode`) + `DefaultSymbolIdComposer`. A runtime
 *      variable path keeps the `ingest`-owned worker entry free of any static
 *      `domains/language` import (`.claude/rules/domains-language.md` §2).
 *   2. Build a `GraphDbClientPool` rooted at `config.rootDir`, pointed at the
 *      daemon socket (`config.daemonSocketPath`). `acquireWrite` proxies
 *      mutations to the single daemon process that owns the RW DuckDB lock, so
 *      a worker-side connection is safe by construction (multi-client daemon).
 *      The `initHook` hydrates the per-collection symbol table from disk,
 *      identical to `wireCodegraph`.
 *   3. Construct the provider in pool mode with the rebuilt deps.
 *
 * @param config Structured-clone-safe daemon + language + exclusion config.
 * @param descriptor Optional descriptor attached to the provider. Supplied by
 *   the composition root when wiring the worker-pool executor; omitted ⇒
 *   inline-only (no workerDescriptor surfaced).
 */
export async function createCodegraphEnrichmentProvider(
  config: CodegraphWorkerConfig,
  descriptor?: WorkerEnrichmentDescriptor,
): Promise<CodegraphEnrichmentProvider> {
  const lang = (await import(config.languageModulePath)) as LanguageModule;
  const languageFactory = new lang.LanguageFactory({ ambiguousResolveMode: config.ambiguousResolveMode });
  const composer = new lang.DefaultSymbolIdComposer();
  const { collectSymbols } = lang;

  const pool = new GraphDbClientPool({
    rootDir: config.rootDir,
    symbolTableFactory: () => new InMemoryGlobalSymbolTable(),
    resources: {
      memoryLimit: config.dbMemoryLimit,
      threads: config.dbThreads,
      preserveInsertionOrder: false,
    },
    daemonSocketPath: config.daemonSocketPath,
    // Hydrate the per-collection symbol table from disk on first open —
    // identical to wireCodegraph. Without it an incremental reindex of file A
    // cannot resolve calls into an unchanged file B.
    initHook: async ({ collectionName, graphDb, symbolTable }) => {
      try {
        const persisted = await graphDb.listAllSymbols();
        if (persisted.length > 0) symbolTable.hydrate(persisted);
      } catch (err) {
        process.stderr.write(
          `[tea-rags] codegraph symbol-table hydration failed for ${collectionName}: ${(err as Error).message}\n`,
        );
      }
    },
  });

  return new CodegraphEnrichmentProvider(
    {
      pool,
      composer,
      collectSymbols,
      // `ambiguousResolveMode` is NOT a provider dep — each native language
      // provider's resolver already carries the mode, baked in when the
      // factory built it above (`new LanguageFactory({ ambiguousResolveMode })`).
      languageFactory,
      derivedSignals: CODEGRAPH_SYMBOLS_DERIVED_SIGNALS,
      presets: CODEGRAPH_SYMBOLS_PRESETS,
      exclusion: {
        excludeTests: config.excludeTests ?? true,
        customPatterns: config.customExcludePatterns ?? [],
      },
    },
    descriptor,
  );
}
