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
 *     `ChunkerConfig.languageModulePath`);
 *   - the pool through the bootstrap-owned factory module — either
 *     `runtimeDeps.buildPool` (the bootstrap wrapper passes its own builder)
 *     or `config.poolFactoryModulePath` dynamic-imported here (bd
 *     tea-rags-mcp-89k7k.35, S15). In daemon mode the pool routes through the
 *     multi-client daemon socket (`config.daemonSocketPath`), which already
 *     serialises DuckDB access across processes.
 *
 * Non-serializable deps (`LanguageFactoryDescriptor`, the DuckDB pool) are NEVER
 * carried on the descriptor — only string paths the worker resolves
 * in-thread. This preserves the `.claude/rules/domains-language.md`
 * invariant: the `ingest`-owned worker entry stays domain-internal, with
 * NO static cross-domain import and NO eslint guard exemption.
 *
 * The worker-loaded `createCodegraphEnrichmentProvider(config)` wrapper and
 * the pool construction live in `src/bootstrap/codegraph-worker-pool-factory.ts`
 * (S15); this file owns the config type, the runtime seam and the cross-run
 * parse-cache helper.
 */

import { readManifestFiles } from "../../../adapters/filesystem/dependency-manifests.js";
import type { GraphDbClientPoolPort } from "../../../contracts/types/codegraph-pool.js";
import type { AmbiguousResolveMode } from "../../../contracts/types/codegraph.js";
import type {
  CollectSymbolsFn,
  LanguageCrossRunParseCache,
  LanguageFactoryDescriptor,
  ManifestFilesReader,
  SymbolIdComposer,
} from "../../../contracts/types/language.js";
import type { WorkerEnrichmentDescriptor } from "../../../contracts/types/provider.js";
import {
  CODEGRAPH_SYMBOLS_DERIVED_SIGNALS,
  CODEGRAPH_SYMBOLS_PRESETS,
  CodegraphEnrichmentProvider,
} from "./symbols/index.js";
import { createTemporalCochangeHooks, type TemporalCochangeConfig } from "./temporal/index.js";

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
   * Compiled `domains/maintenance/migration/database` barrel the worker
   * dynamic-imports in-thread to get the graph DDL applier. Same reason as
   * `languageModulePath`: a function cannot cross `postMessage`, and this
   * domain may not import a sibling domain statically.
   */
  migrationsModulePath: string;
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
   * `.gitignore`-shaped patterns layered on top of the unconditional
   * generated + test exclusions. Sourced from `CODEGRAPH_CUSTOM_EXCLUDE` env
   * var at composition time.
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
   * Absolute compiled-JS path to the bootstrap-owned module exporting
   * `createCodegraphWorkerPool` (bd tea-rags-mcp-89k7k.35, S15): the pool a
   * runtime rebuilt from this config alone reads and writes through. The
   * domain consumes the pool through the contracts `GraphDbClientPoolPort`
   * and constructs no duckdb class, so the builder arrives the same way the
   * language and migration modules do — a plain-data path dynamic-imported
   * where the runtime is rebuilt (the working-tree graph build child). A
   * caller that passes `buildPool` through {@link CodegraphProviderRuntimeDeps}
   * (the bootstrap worker factory, tests) does not need this field.
   */
  poolFactoryModulePath?: string;
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
  /**
   * Co-change build config for the temporal sub-graph (bd tea-rags-mcp-x4rpp) —
   * plain data, so the pinned worker rebuilds the SAME completion hook the
   * main-thread provider carries. Absent ⇒ no co-change build.
   */
  temporal?: TemporalCochangeConfig;
}

/**
 * Runtime shape of the dynamically-imported `domains/language` barrel. Typed
 * against the `contracts/` interfaces only — never the concrete classes — so
 * the FACTORY carries no static `domains/language` dependency either (the
 * `import(variable)` is invisible to `no-restricted-imports`). Mirrors the
 * chunker worker's `LanguageModule` interface, plus the cross-run parse
 * cache constructor the working-tree graph child builds its caches with.
 */
interface LanguageModule {
  LanguageFactory: new (options?: {
    ambiguousResolveMode?: AmbiguousResolveMode;
    crossRunParseCache?: LanguageCrossRunParseCache;
    manifestFilesReader?: ManifestFilesReader;
  }) => LanguageFactoryDescriptor;
  CrossRunParseCache: new () => LanguageCrossRunParseCache;
  DefaultSymbolIdComposer: new () => SymbolIdComposer;
  collectSymbols: CollectSymbolsFn;
}

/**
 * Builds the per-collection pool a provider runtime reads and writes through
 * — the construction that left this domain with S15 (bd tea-rags-mcp-89k7k.35,
 * H-D2=a): the concrete `GraphDbClientPool` (and, in daemon mode, its
 * `DaemonRouting`) is a composition decision owned by the bootstrap module
 * `src/bootstrap/codegraph-worker-pool-factory.ts`. Implementations return the
 * contracts port; the domain never sees the concrete class.
 */
export type CodegraphPoolBuilder = (
  config: CodegraphWorkerConfig,
) => GraphDbClientPoolPort | Promise<GraphDbClientPoolPort>;

/**
 * Build a `CodegraphEnrichmentProvider` from a structured-clone-safe config —
 * the named factory export the enrichment worker dynamic-imports in-thread
 * (`WorkerEnrichmentDescriptor.providerFactoryExport`). Also called directly by
 * the composition root for the inline path (descriptor attached, executor still
 * dispatches off-thread for OTHER collections but rebuilds this one in-thread).
 *
 * The pool under the provider is built by the bootstrap-owned factory, reached
 * through `config.poolFactoryModulePath` (S15) — the worker hands this function
 * only the plain-data config, so the module-path seam is the one it uses.
 */
export async function createCodegraphEnrichmentProvider(
  config: CodegraphWorkerConfig,
  descriptor?: WorkerEnrichmentDescriptor,
): Promise<CodegraphEnrichmentProvider> {
  return (await createCodegraphProviderRuntime(config, descriptor)).provider;
}

/**
 * A provider together with the pool it writes through, typed at the port the
 * domain consumes. The pool is otherwise private to the provider, and a caller
 * that OWNS the database files — the working-tree graph build, which must
 * CHECKPOINT and close every client before its output is self-contained —
 * needs it. Callers needing the concrete class build it themselves
 * (`createCodegraphWorkerPool` in the bootstrap module).
 */
export interface CodegraphProviderRuntime {
  provider: CodegraphEnrichmentProvider;
  pool: GraphDbClientPoolPort;
}

/**
 * Process-local collaborators a caller may hand {@link createCodegraphProviderRuntime}
 * beside its plain-data config — things that cannot be rebuilt from the config
 * or resolved from its module paths.
 */
export interface CodegraphProviderRuntimeDeps {
  /**
   * Parses carried from earlier runs in this process (the warm working-tree
   * graph child, which builds one tree again and again), from
   * {@link createLanguageCrossRunParseCache}. Absent: the run parses cold.
   */
  crossRunParseCache?: LanguageCrossRunParseCache;
  /**
   * Builds the runtime's pool (S15). Absent: the builder is dynamic-imported
   * from `config.poolFactoryModulePath` — the only channel a runtime rebuilt
   * from the plain-data config alone (the tree-graph build child) has. One of
   * the two is required; neither is a construction bug.
   */
  buildPool?: CodegraphPoolBuilder;
}

/**
 * A fresh cross-run parse cache from the language module at
 * `languageModulePath` — the same dynamic import the runtime makes, so the
 * caller holding the cache needs no static `domains/language` dependency.
 */
export async function createLanguageCrossRunParseCache(
  languageModulePath: string,
): Promise<LanguageCrossRunParseCache> {
  const lang = (await import(languageModulePath)) as LanguageModule;
  return new lang.CrossRunParseCache();
}

/**
 * Load the pool builder a config-only runtime (the tree-graph build child)
 * resolves from `poolFactoryModulePath` — the bootstrap module exporting
 * `createCodegraphWorkerPool`.
 */
async function loadCodegraphPoolBuilder(poolFactoryModulePath: string): Promise<CodegraphPoolBuilder> {
  const module = (await import(poolFactoryModulePath)) as { createCodegraphWorkerPool: CodegraphPoolBuilder };
  return module.createCodegraphWorkerPool;
}

/**
 * Build a `CodegraphEnrichmentProvider` runtime from a structured-clone-safe
 * config — the rebuild seam the enrichment worker (through the bootstrap
 * module's `createCodegraphEnrichmentProvider`) and the working-tree graph
 * build child share.
 *
 * In-thread reconstruction (the rebuild seam):
 *   1. `await import(config.languageModulePath)` → build `LanguageFactory`
 *      (with `ambiguousResolveMode`) + `DefaultSymbolIdComposer`. A runtime
 *      variable path keeps the `ingest`-owned worker entry free of any static
 *      `domains/language` import (`.claude/rules/domains-language.md` §2).
 *   2. Build the pool through `runtimeDeps.buildPool` or, absent that, the
 *      builder dynamic-imported from `config.poolFactoryModulePath` — daemon
 *      routing and symbol-table hydration included, owned by the bootstrap
 *      module (S15). `acquireWrite` proxies mutations to the single daemon
 *      process that owns the RW DuckDB lock, so a worker-side connection is
 *      safe by construction (multi-client daemon).
 *   3. Construct the provider in pool mode with the rebuilt deps.
 *
 * @param config Structured-clone-safe daemon + language + exclusion config.
 * @param descriptor Optional descriptor attached to the provider. Supplied by
 *   the composition root when wiring the worker-pool executor; omitted ⇒
 *   inline-only (no workerDescriptor surfaced).
 * @param runtimeDeps Process-local collaborators (parse cache, pool builder).
 */
export async function createCodegraphProviderRuntime(
  config: CodegraphWorkerConfig,
  descriptor?: WorkerEnrichmentDescriptor,
  runtimeDeps: CodegraphProviderRuntimeDeps = {},
): Promise<CodegraphProviderRuntime> {
  const lang = (await import(config.languageModulePath)) as LanguageModule;
  // NO root is passed here on purpose. `config.rootDir` is the DuckDB storage
  // root (`paths.appData`), fixed at bootstrap before any collection exists —
  // wiring it in as the TypeScript resolver's `repoRoot` pointed `loadTsConfig`
  // at a directory that holds no project, so every path alias was silently lost
  // on every project (bd tea-rags-mcp-f4wcm). The root a resolver needs is the
  // one the RUN is indexing, and it arrives per call on `CallContext.projectRoot`.
  // The manifest walk is a function, so it cannot ride the structured-clone
  // config: this module — loaded in-thread by the enrichment worker — wires it
  // here, exactly as the main-thread composition does (bd tea-rags-mcp-2wu2h).
  const languageFactory = new lang.LanguageFactory({
    ambiguousResolveMode: config.ambiguousResolveMode,
    manifestFilesReader: readManifestFiles,
    ...(runtimeDeps.crossRunParseCache ? { crossRunParseCache: runtimeDeps.crossRunParseCache } : {}),
  });
  const composer = new lang.DefaultSymbolIdComposer();
  const { collectSymbols } = lang;

  const buildPool = runtimeDeps.buildPool ?? (await resolveConfigPoolBuilder(config));

  const pool = await buildPool(config);

  const provider = new CodegraphEnrichmentProvider(
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
      exclusion: { customPatterns: config.customExcludePatterns ?? [] },
      collectionCompletionHooks: createTemporalCochangeHooks(config.temporal),
    },
    descriptor,
  );
  return { provider, pool };
}

/** `buildPool` from deps, else from the config's module path — else a construction bug. */
async function resolveConfigPoolBuilder(config: CodegraphWorkerConfig): Promise<CodegraphPoolBuilder> {
  if (config.poolFactoryModulePath === undefined) {
    // Programming error: every caller either injects the builder (bootstrap
    // worker factory, tests) or ships its module path (tree-graph build).
    throw new Error(
      "createCodegraphProviderRuntime: config.poolFactoryModulePath or runtimeDeps.buildPool is required — " +
        "the pool builder is bootstrap-owned (src/bootstrap/codegraph-worker-pool-factory.ts)",
    );
  }
  return loadCodegraphPoolBuilder(config.poolFactoryModulePath);
}
