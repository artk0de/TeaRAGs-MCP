/**
 * GitEnrichmentProvider — implements EnrichmentProvider for git trajectory metrics.
 *
 * Wires file-reader + chunk-reader + caches.
 * Owns both the isomorphic-git pack cache (for readBlob/readCommit)
 * and the HEAD-based enrichment result cache.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { VcsAdapterFactory } from "../../../adapters/vcs/factory.js";
import type { VcsGitAdapter } from "../../../adapters/vcs/git/adapter.js";
import { resolveRepoRoot } from "../../../adapters/vcs/git/git-cli/client.js";
import type {
  BlameLine,
  BlobBatchReader,
  CommitInfo,
  FileChurnData,
  GitAdapterKind,
  OidBatchResolver,
} from "../../../adapters/vcs/types.js";
import type { TrajectoryGitConfig } from "../../../contracts/types/config.js";
import type { FileClassification } from "../../../contracts/types/file-classification.js";
import type {
  ChunkLookupEntry,
  ChunkSignalOptions,
  ChunkSignalOverlay,
  EnrichmentProvider,
  EnrichmentScope,
  FileSignalOptions,
  FileSignalOverlay,
  FileSignalTransform,
  FilterDescriptor,
  WorkerEnrichmentDescriptor,
} from "../../../contracts/types/provider.js";
import type { RerankPreset } from "../../../contracts/types/reranker.js";
import { isDebug } from "../../../infra/runtime.js";
import { gitFilters } from "./filters.js";
import { GitBlameStore } from "./infra/blame-store.js";
import { relativizeChunkMap } from "./infra/build-accumulators.js";
import { GitEnrichmentCache } from "./infra/cache.js";
import { buildChunkChurnMap } from "./infra/chunk-reader.js";
import { defaultBlamePoolSize } from "./infra/churn-walk/blame-pool-defaults.js";
import { BlameWorkerPool } from "./infra/churn-walk/blame-pool.js";
import { ChunkChurnWalkPool } from "./infra/churn-walk/walk-pool.js";
import { GitCommitDiscoveryStore } from "./infra/commit-discovery-store.js";
import { GitCommitDiscovery } from "./infra/commit-discovery.js";
import { FileChurnDiscoveryStore } from "./infra/file-churn-discovery-store.js";
import { FileChurnDiscovery } from "./infra/file-churn-discovery.js";
import {
  buildFileSignalDiscovery,
  buildFileSignalMap,
  buildFileSignalsForPaths,
  sliceFileSignalsByPaths,
} from "./infra/file-reader.js";
import { buildBugFixShaSet } from "./infra/merge-branch-resolver.js";
import type { SquashOptions } from "./infra/metrics.js";
import { assembleFileSignals } from "./infra/metrics/file-assembler.js";
import { gitPayloadSignalDescriptors } from "./payload-signals.js";
import { gitDerivedSignals } from "./rerank/derived-signals/index.js";
import { GIT_PRESETS } from "./rerank/presets/index.js";
import type { ChunkChurnOverlay } from "./types.js";

/** Subset of TrajectoryGitConfig used by the provider at runtime, plus the
 *  VCS adapter kind (`config.vcs.adapter`) the per-root adapters are built with. */
export type GitProviderConfig = Pick<
  TrajectoryGitConfig,
  | "logMaxAgeMonths"
  | "logTimeoutMs"
  | "chunkConcurrency"
  | "blamePoolSize"
  | "chunkMaxAgeMonths"
  | "chunkTimeoutMs"
  | "chunkMaxFileLines"
> & {
  /** GIT_ADAPTER kind for VcsAdapterFactory — structured-clone-safe literal. */
  vcsAdapter: GitAdapterKind;
};

const DEFAULT_PROVIDER_CONFIG: GitProviderConfig = {
  logMaxAgeMonths: 12,
  logTimeoutMs: 60000,
  chunkConcurrency: 10,
  blamePoolSize: defaultBlamePoolSize(),
  chunkMaxAgeMonths: 6,
  chunkTimeoutMs: 120000,
  chunkMaxFileLines: 10000,
  vcsAdapter: "git",
};

/**
 * Run-scoped, repo-wide file churn discovery (bd tea-rags-mcp-j4lm9). ONE
 * `git log HEAD --numstat` shared across every `streamFileBatch` call of a run,
 * sliced per batch in memory — replacing the former per-batch full-history
 * pathspec log (~one full history walk per file batch). Keyed by (root, HEAD)
 * so it survives batches WITHIN a run and self-invalidates across runs (HEAD
 * moves); dropped explicitly at the run-end finalize seam for memory hygiene.
 */
interface RunFileDiscovery {
  readonly root: string;
  readonly headSha: string;
  /** The in-flight (or resolved) discovery — memoized as a PROMISE, not a
   *  resolved value, so concurrent streaming batches share ONE full-history
   *  `git log --numstat` instead of each racing to spawn its own (~1GB). */
  readonly data: Promise<Map<string, FileChurnData>>;
}

export class GitEnrichmentProvider implements EnrichmentProvider {
  readonly key = "git";

  // ── Query-side contract ──
  readonly signals = gitPayloadSignalDescriptors;
  readonly derivedSignals = gitDerivedSignals;
  readonly filters: FilterDescriptor[] = gitFilters;
  readonly presets: RerankPreset[] = GIT_PRESETS;

  private readonly squashOpts?: SquashOptions;
  private readonly config: GitProviderConfig;
  /** Bug-fix SHAs resolved from merge branch prefixes. Updated per buildFileSignals() call. */
  private bugFixShas: Set<string> = new Set();

  /** Blame results keyed by FileChurnData identity — populated in buildFileSignals,
   *  consumed in fileSignalTransform. WeakMap auto-cleans when churnData is GC'd. */
  private readonly blameByChurnData = new WeakMap<FileChurnData, BlameLine[]>();
  /** Blame results keyed by relative path — passed into buildChunkChurnMap so
   *  chunk overlays receive per-range line ownership. Same blame pass as file-level. */
  private blameByRelPath: Map<string, BlameLine[]> = new Map();

  /** Persistent OID-keyed blame cache (bd tea-rags-mcp-v2mlw): blame lines
   *  survive across runs keyed by each file's HEAD blob OID, so
   *  force/incremental reindex only blames CHANGED files. */
  private readonly blameStore = new GitBlameStore();
  /** In-memory tier of the blame cache — lazily loaded from blameStore per
   *  root, dropped at the finalize seam (finalizeSignals). */
  private blameCache: Map<string, { oid: string; lines: BlameLine[] }> | null = null;
  private blameCacheRoot: string | null = null;
  private blameCacheDirty = false;
  /** FILE-phase off-main-thread blame pool (bd tea-rags-mcp-dog1v). Lazily
   *  spawned on the first shallow cache-miss, closed at the finalize seam. */
  private blamePool?: BlameWorkerPool;
  /** ONE persistent `git cat-file --batch-check` process per run/root — the
   *  OID lookups that key the blame cache ride it (EDR-immune: no fresh
   *  spawns). Closed at the finalize seam. */
  /** Memoized as a PROMISE (not the resolved reader) so concurrent streaming
   *  batches share ONE `cat-file --batch-check` process instead of each spawning
   *  and leaking its own — the same single-flight the file discovery needs. */
  private oidReaderPromise: Promise<OidBatchResolver> | null = null;
  private oidReaderRoot: string | null = null;

  /** Lazy per-root VCS adapters for the run (w2dlu T6) — created on first use
   *  via VcsAdapterFactory with the configured kind, cached as promises so
   *  concurrent callers share one creation. Dropped at the finalize seam. */
  private readonly vcsAdapters = new Map<string, Promise<VcsGitAdapter>>();

  /** Run-scoped, store-backed per-file churn discovery — the FILE analogue of
   *  the chunk `createCommitDiscovery` matrix, but provider-owned like
   *  `fileDiscovery` (streamFileBatch / buildFileSignals own the lifecycle). ONE
   *  instance per root, incrementally topped-up from its own file-churn store;
   *  dropped at the finalize seam so a HEAD move (a new run) rebuilds the window
   *  from the persisted snapshot instead of re-walking the whole repo. */
  private readonly fileChurnDiscoveries = new Map<string, FileChurnDiscovery>();

  /**
   * Worker-pool descriptor — present iff the composition root wired this
   * provider for off-main-thread dispatch via WorkerPoolEnrichmentExecutor.
   * Inline-only callers (tests, the default inline executor) leave it
   * undefined and the executor falls back to in-thread provider calls.
   */
  readonly workerDescriptor?: WorkerEnrichmentDescriptor;

  constructor(
    config?: Partial<GitProviderConfig>,
    squashOpts?: SquashOptions,
    workerDescriptor?: WorkerEnrichmentDescriptor,
  ) {
    this.config = { ...DEFAULT_PROVIDER_CONFIG, ...config };
    this.squashOpts = squashOpts;
    this.workerDescriptor = workerDescriptor;
    this.fileSignalTransform = (data, maxEndLine) => {
      const churnData = data as unknown as FileChurnData;
      const blameLines = this.blameByChurnData.get(churnData);
      return assembleFileSignals(
        churnData,
        maxEndLine,
        this.squashOpts,
        this.bugFixShas,
        blameLines,
      ) as unknown as FileSignalOverlay;
    };
  }

  resolveRoot(absolutePath: string): string {
    return resolveRepoRoot(absolutePath);
  }

  /** Lazy per-root adapter for the run — one factory call per root, shared as
   *  a cached promise (a rejected creation stays cached: fail-loud once per
   *  run, per the es-git no-silent-fallback contract). */
  private async adapterFor(root: string): Promise<VcsGitAdapter> {
    let adapter = this.vcsAdapters.get(root);
    if (!adapter) {
      adapter = VcsAdapterFactory.create(this.config.vcsAdapter, root);
      this.vcsAdapters.set(root, adapter);
    }
    return adapter;
  }

  /** Lazy per-root, run-scoped file-churn discovery — ONE store-backed instance
   *  per root shared by BOTH the whole-set (`buildFileSignalMap`) and streaming
   *  (`buildFileSignalDiscovery`) file-signal reads, so a warm run tops up its
   *  window incrementally (a `from..to` range read) instead of re-walking the
   *  whole repo. Window config mirrors the legacy reads
   *  (`logMaxAgeMonths` / `logTimeoutMs`) so `buildFileSignalDiscovery`'s
   *  otherwise-ignored window param stays consistent — no silent mismatch.
   *  Construction is synchronous (mirrors createCommitDiscovery): the discovery
   *  awaits the adapter promise internally on its first git touch. Dropped at
   *  the finalize seam. */
  private fileChurnDiscoveryFor(root: string): FileChurnDiscovery {
    let discovery = this.fileChurnDiscoveries.get(root);
    if (!discovery) {
      discovery = new FileChurnDiscovery(this.adapterFor(root), {
        maxAgeMonths: this.config.logMaxAgeMonths,
        timeoutMs: this.config.logTimeoutMs,
        store: new FileChurnDiscoveryStore(),
      });
      this.fileChurnDiscoveries.set(root, discovery);
    }
    return discovery;
  }

  /**
   * Git policy: generated files carry harmful signals (regeneration churn,
   * generator as "owner") and are huge blame targets → skip entirely.
   * Documentation keeps cheap file-level ownership but drops the per-chunk
   * churn walk over prose. Everything else (incl. tests) enriches fully.
   */
  shouldEnrich(file: { relPath: string; classification: FileClassification }): EnrichmentScope {
    if (file.classification.isGenerated) return "none";
    if (file.classification.isDocumentation) return "file-only";
    return "full";
  }

  readonly fileSignalTransform: FileSignalTransform;

  private readonly enrichmentCache = new GitEnrichmentCache();
  private readonly isoGitCache: Record<string, unknown> = {};
  private lastFileResult: Map<string, FileChurnData> | null = null;
  /** Run-scoped discovery — see RunFileDiscovery. Lazy on the first streaming
   *  batch, reset by finalizeSignals (and re-keyed automatically when HEAD moves). */
  private fileDiscovery: RunFileDiscovery | null = null;

  async buildFileSignals(root: string, options?: FileSignalOptions): Promise<Map<string, FileSignalOverlay>> {
    // Fast check: skip if not a git repo
    if (!existsSync(join(root, ".git"))) {
      return new Map();
    }

    const adapter = await this.adapterFor(root);
    let rawData: Map<string, FileChurnData>;

    if (options?.paths) {
      // Whole-set path (backfill / recovery): a fresh per-path history walk.
      // Kept separate from streamFileBatch so backfill/recovery semantics are
      // unchanged — they do not share the run-scoped streaming discovery.
      rawData = await buildFileSignalsForPaths(adapter, options.paths, this.config.logTimeoutMs);
    } else {
      rawData = await buildFileSignalMap(
        adapter,
        this.enrichmentCache,
        this.config.logMaxAgeMonths,
        this.config.logTimeoutMs,
        this.fileChurnDiscoveryFor(root),
      );
    }

    return this.buildSignalsFromRawData(root, rawData, options);
  }

  /** Per-batch streaming: same computation as buildFileSignals, scoped to the
   *  batch's paths — but the batch's FileChurnData is SLICED from the ONE
   *  run-scoped repo-wide discovery instead of a fresh per-batch full-history
   *  pathspec log (bd tea-rags-mcp-j4lm9). Populates blameByRelPath/lastFileResult
   *  for the batch so the matching buildChunkSignals call (same batch) sees
   *  per-range ownership. Arrow-property so `this` survives being passed as a
   *  coordinator callback. */
  streamFileBatch = async (
    root: string,
    batchPaths: string[],
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>> => {
    // Fast check: skip if not a git repo (mirrors buildFileSignals).
    if (!existsSync(join(root, ".git"))) {
      return new Map();
    }
    const rawData = sliceFileSignalsByPaths(await this.getRunDiscovery(root), batchPaths);
    return this.buildSignalsFromRawData(root, rawData, options);
  };

  /** git streams file+chunk signals per batch — nothing is deferred, so the
   *  file finalize is an empty no-op (and defersChunkEnrichment stays unset).
   *  It IS the once-per-run seam (CompletionRunner.runFinalize calls it for every
   *  provider), so drop the run-scoped discovery here — its full-repo
   *  FileChurnData map must not outlive the run. A fresh run rebuilds it lazily;
   *  the (root, HEAD) key is the correctness guard, this is memory hygiene.
   *
   *  bd tea-rags-mcp-v2mlw: also the blame-cache seam — persist the OID-keyed
   *  blame cache to its store, drop the in-memory tier (next run reloads from
   *  disk), and close the run's persistent `cat-file --batch-check` process
   *  (best-effort — the process is idle either way). */
  finalizeSignals = async (): Promise<Map<string, FileSignalOverlay>> => {
    this.fileDiscovery = null;
    // Drop the run-scoped file-churn discovery instances with the run — the next
    // run rebuilds each from its persisted store snapshot (topping up the window
    // for the new HEAD). Its own latch pins one HEAD's aggregate, so it must not
    // outlive the run (matches vcsAdapters/fileDiscovery reset below).
    this.fileChurnDiscoveries.clear();
    this.persistBlameCache();
    this.blameCache = null;
    this.blameCacheRoot = null;
    await this.oidReaderPromise?.then(async (r) => r.close()).catch(() => undefined);
    this.oidReaderPromise = null;
    this.oidReaderRoot = null;
    // Close the FILE-phase blame pool — its workers hold their own es-git repo
    // handles; drop them with the run (dog1v).
    await this.blamePool?.close().catch(() => undefined);
    this.blamePool = undefined;
    // w2dlu T6: per-root adapters are run-scoped — drop them with the run so
    // a later run re-creates fresh instances (matters once adapters hold
    // native repo handles, e.g. es-git).
    this.vcsAdapters.clear();
    return new Map();
  };

  /**
   * Lazily build (or reuse) the run-scoped repo-wide discovery keyed by
   * (root, HEAD). Reused across every streaming batch of a run; a HEAD move
   * (new run) rebuilds. Dropped at the finalize seam (finalizeSignals).
   */
  private async getRunDiscovery(root: string): Promise<Map<string, FileChurnData>> {
    const adapter = await this.adapterFor(root);
    const headSha = await adapter.getHead().catch(() => "");
    if (this.fileDiscovery?.root === root && this.fileDiscovery.headSha === headSha) {
      return this.fileDiscovery.data;
    }
    // Warm the commit-graph (+ changed-path Bloom filters) in the BACKGROUND —
    // NOT chained before the discovery. It accelerates git BLAME (which runs
    // after discovery) and future runs, but its Bloom filters help only PATHSPEC
    // logs, not this pathspec-less numstat sweep; chaining it ahead would only
    // delay git-file start. Fire-and-forget, best-effort (bd tea-rags-mcp).
    void adapter.writeCommitGraph(this.config.logTimeoutMs).catch(() => undefined);
    // Store the PROMISE synchronously — before awaiting the `git log --numstat`
    // (still ~30s windowed on a monolith). The coordinator fires streamFileBatch
    // per embedding batch WITHOUT awaiting, so dozens land in flight before the
    // first discovery resolves; memoizing the resolved value (the old code) let
    // every one spawn its own numstat log → 3-5GB OOM. This is the single-flight
    // of adapterFor / GitCommitDiscovery.matrixPromise. Bounded by
    // logMaxAgeMonths (full history was 141s on taxdome, blocking git-file
    // enrichment ~150s; the window matches buildFileSignalMap).
    const data = buildFileSignalDiscovery(
      adapter,
      this.config.logTimeoutMs,
      this.config.logMaxAgeMonths,
      this.fileChurnDiscoveryFor(root),
    );
    this.fileDiscovery = { root, headSha, data };
    // A transient discovery failure must not poison the whole run: drop the
    // cache on rejection so a LATER (non-concurrent) batch can retry, while the
    // batches already racing this one still shared it (no retry storm).
    data.catch(() => {
      if (this.fileDiscovery?.data === data) this.fileDiscovery = null;
    });
    return data;
  }

  /**
   * Shared file-signal assembly for both the whole-set (buildFileSignals) and
   * streaming (streamFileBatch) paths: cache the raw result, resolve the
   * bug-fix SHA set, run git blame per file, and return the raw FileChurnData
   * as overlays. The only difference between the two callers is where rawData
   * came from — the downstream computation is identical.
   */
  private async buildSignalsFromRawData(
    root: string,
    rawData: Map<string, FileChurnData>,
    options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>> {
    this.lastFileResult = rawData;

    // Build bug-fix SHA set from merge branch prefixes (all commits across all files)
    const allCommits = new Map<string, CommitInfo>();
    for (const [, data] of rawData) {
      for (const c of data.commits) {
        if (!allCommits.has(c.sha)) allCommits.set(c.sha, c);
      }
    }
    this.bugFixShas = buildBugFixShaSet(Array.from(allCommits.values()));

    // Fetch git blame per file in parallel (throttled by chunkConcurrency).
    // Stored in WeakMap so fileSignalTransform can look up by churnData identity later.
    await this.populateBlameMap(root, rawData, options);

    // Return raw FileChurnData — coordinator/applier will call computeFileSignals
    // with actual line count when applying per-file
    const result = new Map<string, FileSignalOverlay>();
    for (const [path, churnData] of rawData) {
      result.set(path, churnData as unknown as FileSignalOverlay);
    }
    return result;
  }

  /** bd tea-rags-mcp-82va1: factory for the run-scoped commit-discovery
   *  matrix — the provider owns the window config (chunkMaxAgeMonths /
   *  chunkTimeoutMs), ChunkPhase owns the instance lifecycle (lazy create at
   *  first chunk dispatch, dropped at drain). Arrow-property so `this`
   *  survives callback passing (precedent: streamFileBatch). */
  createCommitDiscovery = (repoRoot: string): GitCommitDiscovery =>
    // Construction stays synchronous (ChunkPhase creates it before any await
    // to avoid a double-create race) — the discovery awaits the adapter
    // promise internally on its first git touch.
    new GitCommitDiscovery(this.adapterFor(repoRoot), {
      maxAgeMonths: this.config.chunkMaxAgeMonths,
      timeoutMs: this.config.chunkTimeoutMs,
      store: new GitCommitDiscoveryStore(),
    });

  /** bd tea-rags-mcp-iqpuu: factory for the run-scoped off-thread churn-walk
   *  thread — the provider owns the walk implementation, ChunkPhase owns the
   *  instance lifecycle (lazy create at first chunk dispatch, closed at
   *  drain). Arrow-property so `this` survives callback passing (precedent:
   *  createCommitDiscovery). */
  // Walk pool is decoupled from the (larger) blame concurrency: the chunk-churn
  // walk is CPU-bound (git log + structuredPatch) and showed no measured win
  // past a few workers, so cap it at 4 while the blame pool scales higher.
  createChunkChurnWalkThread = (): ChunkChurnWalkPool => new ChunkChurnWalkPool(Math.min(4, this.config.blamePoolSize));

  /** Run `git blame HEAD` per file and store results for transform-time
   *  lookup. Failures fall back to empty arrays — assembleFileSignals will
   *  produce unknown ownership.
   *
   *  bd tea-rags-mcp-v2mlw: OID-keyed blame cache. Per-file `git blame` is a
   *  FRESH process spawn, and a machine-wide EDR change (SentinelOne) caps
   *  fresh git spawns at ~10/s with zero parallel scaling — blame cost cannot
   *  be parallelized away. Persistent processes are NOT throttled, so each
   *  batch first resolves HEAD:<path> blob OIDs through ONE long-lived
   *  `cat-file --batch-check` process (resolveHeadOids) and reuses stored
   *  blame lines when a file's OID is unchanged; only changed files run
   *  `git blame`. Cold first index is unaffected (all misses); force /
   *  incremental runs and the backfill blame only changed files. Non-empty
   *  results only are cached: [] can be a transient blame failure (blameFile
   *  swallows errors) — pinning it would freeze the failure.
   *
   *  Accumulates into `this.blameByRelPath` across calls — buildFileSignals
   *  may be invoked multiple times per indexing run (initial pass + backfill,
   *  reindex_changes, etc.). chunk enrichment runs AFTER all file passes via
   *  buildChunkSignals, so the chunk-level blame map must retain entries from
   *  every prior pass. Replacing the map would erase blame for files indexed
   *  in earlier batches and produce "unknown" chunk ownership. */
  private async populateBlameMap(
    root: string,
    rawData: Map<string, FileChurnData>,
    options?: FileSignalOptions,
  ): Promise<void> {
    const entries = Array.from(rawData.entries());
    if (entries.length === 0) return;
    const startedAt = Date.now();

    const oidByPath = await this.resolveHeadOids(
      root,
      entries.map(([rel]) => rel),
    );
    const cache = this.ensureBlameCache(root);

    let hits = 0;
    const missEntries: [string, FileChurnData][] = [];
    for (const [relPath, churnData] of entries) {
      const oid = oidByPath.get(relPath);
      const cached = oid ? cache.get(relPath) : undefined;
      if (oid && cached?.oid === oid) {
        hits++;
        this.blameByChurnData.set(churnData, cached.lines);
        this.blameByRelPath.set(relPath, cached.lines);
      } else {
        missEntries.push([relPath, churnData]);
      }
    }

    // Blame every cache-miss on the off-main-thread pool. Blame is native
    // `git blame` (adapter-delegated for es-git too — the in-process libgit2
    // blame was a 60x loss on large repos, dog1v). Native blame is an async
    // child process, so the pool's N workers = N concurrent `git blame` (each
    // worker serial); parallel git blame sustains ~69-89/s uncapped by EDR.
    const recordBlame = (relPath: string, churnData: FileChurnData, lines: BlameLine[]): void => {
      this.blameByChurnData.set(churnData, lines);
      this.blameByRelPath.set(relPath, lines);
      const oid = oidByPath.get(relPath);
      // Cache only non-empty results: [] can be a transient blame failure
      // (blameFile swallows errors) — pinning it would freeze the failure.
      if (oid && lines.length > 0) {
        cache.set(relPath, { oid, lines });
        this.blameCacheDirty = true;
      }
    };

    if (missEntries.length > 0) {
      const blameByPath = await this.ensureBlamePool().blame(
        root,
        this.config.vcsAdapter,
        missEntries.map(([relPath, churnData]) => ({ relPath, historyDepthHint: churnData.commits.length })),
        this.config.logTimeoutMs,
      );
      for (const [relPath, churnData] of missEntries) {
        recordBlame(relPath, churnData, blameByPath.get(relPath) ?? []);
      }
    }

    options?.onBlameStats?.({
      files: entries.length,
      hits,
      misses: missEntries.length,
      durationMs: Date.now() - startedAt,
    });
  }

  /** Resolve HEAD:<path> blob OIDs for a batch through ONE persistent
   *  `cat-file --batch-check` process per run/root (EDR-immune: the lookups
   *  ride an already-running process, no fresh spawns). ANY failure returns
   *  an empty map — every file becomes a cache miss and the pass degrades to
   *  today's blame-everything behavior; blame stays best-effort. */
  private async resolveHeadOids(root: string, relPaths: string[]): Promise<Map<string, string | null>> {
    try {
      if (this.oidReaderRoot !== root || !this.oidReaderPromise) {
        // Close a stale (root-switched) reader out of band; set the new creation
        // PROMISE synchronously — before any await — so concurrent batches share
        // it instead of each spawning a `cat-file --batch-check`.
        const stale = this.oidReaderRoot !== root ? this.oidReaderPromise : null;
        this.oidReaderRoot = root;
        this.oidReaderPromise = this.adapterFor(root).then((a) => a.createOidBatchResolver());
        void stale?.then(async (r) => r.close()).catch(() => undefined);
      }
      const reader = await this.oidReaderPromise;
      const oids = await Promise.all(relPaths.map(async (rel) => reader.check(`HEAD:${rel}`)));
      const result = new Map<string, string | null>();
      relPaths.forEach((rel, i) => result.set(rel, oids[i]));
      return result;
    } catch {
      return new Map();
    }
  }

  /** Lazily load (or reuse) the in-memory blame cache for a root; a root
   *  switch persists the previous root's dirty entries first. */
  private ensureBlameCache(root: string): Map<string, { oid: string; lines: BlameLine[] }> {
    if (this.blameCacheRoot === root && this.blameCache) return this.blameCache;
    this.persistBlameCache();
    this.blameCache = this.blameStore.load(root) ?? new Map();
    this.blameCacheRoot = root;
    this.blameCacheDirty = false;
    return this.blameCache;
  }

  /** Lazily spawn (or reuse) the run's FILE-phase blame worker pool. */
  private ensureBlamePool(): BlameWorkerPool {
    this.blamePool ??= new BlameWorkerPool(this.config.blamePoolSize);
    return this.blamePool;
  }

  /** Persist the in-memory blame cache iff it has unsaved entries. */
  private persistBlameCache(): void {
    if (this.blameCacheDirty && this.blameCache && this.blameCacheRoot) {
      this.blameStore.save(this.blameCacheRoot, this.blameCache);
    }
    this.blameCacheDirty = false;
  }

  async buildChunkSignals(
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    // bd tea-rags-mcp-iqpuu: off-thread branch iff ChunkPhase attached the
    // run-scoped walk thread AND the run-scoped discovery is present AND the
    // HEAD cache is skipped (ChunkPhase always sets skipCache; the cached
    // path stays inline-only so cache semantics are untouched). The contract
    // duck type is structurally ChunkChurnWalkPool — cast at the boundary
    // (precedent: blobReader below).
    const walkThread = options?.churnWalkThread as unknown as ChunkChurnWalkPool | undefined;
    let rawResult: Map<string, Map<string, ChunkChurnOverlay>>;
    if (walkThread && options?.commitDiscovery && options.skipCache) {
      rawResult = await this.walkChunkChurnOffThread(root, chunkMap, walkThread, options.commitDiscovery, options);
    } else {
      rawResult = await buildChunkChurnMap(
        await this.adapterFor(root),
        chunkMap,
        this.enrichmentCache,
        this.isoGitCache,
        this.config.chunkConcurrency,
        this.config.chunkMaxAgeMonths,
        this.lastFileResult ?? undefined,
        this.squashOpts,
        this.config.chunkTimeoutMs,
        this.config.chunkMaxFileLines,
        options?.concurrencySemaphore,
        options?.skipCache,
        this.blameByRelPath,
        // kc93: run-scoped reader shared across batches when ChunkPhase injects
        // one. The duck-typed contract shape is structurally BlobBatchReader.
        options?.blobReader as BlobBatchReader | undefined,
        // 7gnre: run-scoped (commitSha, filePath) → hunks memo shared across
        // batches — the same sweep commits are otherwise re-diffed per batch.
        options?.diffMemo,
        // 82va1: run-scoped commit-discovery matrix — the walk slices it
        // in-memory instead of paying a per-batch pathspec log.
        options?.commitDiscovery,
        // iqpuu: per-walk instrumentation for the [ChunkChurn] pipeline line.
        options?.onWalkStats,
      );
    }

    // Chunk enrichment is the last reader of blameByRelPath. Swap in a fresh
    // map so every file's BlameLine[] (and the porcelain those slices used to
    // pin) is not retained for the provider/daemon lifetime — the next run's
    // file passes repopulate it. Replacing (not clearing) leaves any reference
    // already handed to buildChunkChurnMap intact. (blameByChurnData is a
    // WeakMap and self-evicts.)
    this.blameByRelPath = new Map();

    const result = new Map<string, Map<string, ChunkSignalOverlay>>();
    for (const [filePath, overlayMap] of rawResult) {
      const chunkEntries = new Map<string, ChunkSignalOverlay>();
      for (const [chunkId, overlay] of overlayMap) {
        chunkEntries.set(chunkId, overlay as unknown as ChunkSignalOverlay);
      }
      result.set(filePath, chunkEntries);
    }
    return result;
  }

  /**
   * bd tea-rags-mcp-iqpuu: off-thread chunk-churn walk. Builds one fully
   * serializable job — the batch's relativized chunk map, the pre-sliced
   * discovery rows + shared bugFixShaSet (queried HERE so the run-scoped
   * matrix stays a main-thread singleton), and the blame / file-churn slices
   * this instance accumulated during streamFileBatch — and ships it to the
   * dedicated walk worker. Walk semantics are byte-identical to the inline
   * path: the worker runs the same buildChunkChurnMapUncached with its own
   * run-scoped reader/memo/limiter.
   */
  private async walkChunkChurnOffThread(
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    walkThread: ChunkChurnWalkPool,
    discovery: NonNullable<ChunkSignalOptions["commitDiscovery"]>,
    options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkChurnOverlay>>> {
    const relativeChunkMap = relativizeChunkMap(root, chunkMap);
    if (relativeChunkMap.size === 0) return new Map();

    // Same failure semantics as walkCommits' discovery branch: a broken
    // discovery ⇒ no churn for this batch, never a thrown enrichment error.
    let commitEntries: { commit: CommitInfo; changedFiles: string[] }[];
    try {
      // The contract duck type's commit shape is structurally CommitInfo.
      commitEntries = (await discovery.commitsForFiles([...relativeChunkMap.keys()])) as {
        commit: CommitInfo;
        changedFiles: string[];
      }[];
    } catch (error) {
      if (isDebug()) {
        console.error(
          `[ChunkChurn] discovery slice failed, skipping chunk churn:`,
          error instanceof Error ? error.message : error,
        );
      }
      commitEntries = [];
    }
    const bugFixShas = await discovery.getBugFixShas().catch(() => new Set<string>());

    // Slice the file-phase state to this batch's files (only existing
    // entries) — equivalent to the inline path passing the full maps, since
    // the walk only reads keys of its own relativeChunkMap.
    const blameByPath = new Map<string, BlameLine[]>();
    const fileChurnData = this.lastFileResult ? new Map<string, FileChurnData>() : undefined;
    for (const rel of relativeChunkMap.keys()) {
      const blame = this.blameByRelPath.get(rel);
      if (blame) blameByPath.set(rel, blame);
      const churn = this.lastFileResult?.get(rel);
      if (churn && fileChurnData) fileChurnData.set(rel, churn);
    }

    const outcome = await walkThread.walk({
      repoRoot: root,
      gitAdapter: this.config.vcsAdapter,
      relativeChunkMap,
      commitEntries,
      bugFixShas,
      blameByPath,
      fileChurnData,
      squashOpts: this.squashOpts,
      concurrency: this.config.chunkConcurrency,
      maxAgeMonths: this.config.chunkMaxAgeMonths,
      chunkTimeoutMs: this.config.chunkTimeoutMs,
      maxFileLines: this.config.chunkMaxFileLines,
      useSharedLimiter: options?.concurrencySemaphore !== undefined,
    });
    options?.onWalkStats?.(outcome.stats);
    return outcome.overlays;
  }
}
