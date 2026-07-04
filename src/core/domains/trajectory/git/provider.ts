/**
 * GitEnrichmentProvider — implements EnrichmentProvider for git trajectory metrics.
 *
 * Wires file-reader + chunk-reader + caches.
 * Owns both the isomorphic-git pack cache (for readBlob/readCommit)
 * and the HEAD-based enrichment result cache.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  blameFile,
  createCatFileBatchCheck,
  getHead,
  resolveRepoRoot,
  type CatFileBatchCheckReader,
  type CatFileBatchReader,
} from "../../../adapters/vcs/git/git-cli/client.js";
import type { BlameLine, CommitInfo, FileChurnData } from "../../../adapters/vcs/types.js";
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
import { ChunkChurnWalkThread } from "./infra/churn-walk/thread.js";
import { GitCommitDiscoveryStore } from "./infra/commit-discovery-store.js";
import { GitCommitDiscovery } from "./infra/commit-discovery.js";
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

/** Subset of TrajectoryGitConfig used by the provider at runtime. */
export type GitProviderConfig = Pick<
  TrajectoryGitConfig,
  "logMaxAgeMonths" | "logTimeoutMs" | "chunkConcurrency" | "chunkMaxAgeMonths" | "chunkTimeoutMs" | "chunkMaxFileLines"
>;

const DEFAULT_PROVIDER_CONFIG: GitProviderConfig = {
  logMaxAgeMonths: 12,
  logTimeoutMs: 60000,
  chunkConcurrency: 10,
  chunkMaxAgeMonths: 6,
  chunkTimeoutMs: 120000,
  chunkMaxFileLines: 10000,
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
  readonly data: Map<string, FileChurnData>;
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
  /** ONE persistent `git cat-file --batch-check` process per run/root — the
   *  OID lookups that key the blame cache ride it (EDR-immune: no fresh
   *  spawns). Closed at the finalize seam. */
  private oidReader: CatFileBatchCheckReader | null = null;
  private oidReaderRoot: string | null = null;

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

    let rawData: Map<string, FileChurnData>;

    if (options?.paths) {
      // Whole-set path (backfill / recovery): a fresh per-path history walk.
      // Kept separate from streamFileBatch so backfill/recovery semantics are
      // unchanged — they do not share the run-scoped streaming discovery.
      rawData = await buildFileSignalsForPaths(root, options.paths, this.config.logTimeoutMs);
    } else {
      rawData = await buildFileSignalMap(
        root,
        this.enrichmentCache,
        this.config.logMaxAgeMonths,
        this.config.logTimeoutMs,
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
    this.persistBlameCache();
    this.blameCache = null;
    this.blameCacheRoot = null;
    await this.oidReader?.close().catch(() => undefined);
    this.oidReader = null;
    this.oidReaderRoot = null;
    return new Map();
  };

  /**
   * Lazily build (or reuse) the run-scoped repo-wide discovery keyed by
   * (root, HEAD). Reused across every streaming batch of a run; a HEAD move
   * (new run) rebuilds. Dropped at the finalize seam (finalizeSignals).
   */
  private async getRunDiscovery(root: string): Promise<Map<string, FileChurnData>> {
    const headSha = await getHead(root).catch(() => "");
    if (this.fileDiscovery?.root === root && this.fileDiscovery.headSha === headSha) {
      return this.fileDiscovery.data;
    }
    const data = await buildFileSignalDiscovery(root, this.config.logTimeoutMs);
    this.fileDiscovery = { root, headSha, data };
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
    new GitCommitDiscovery(repoRoot, {
      maxAgeMonths: this.config.chunkMaxAgeMonths,
      timeoutMs: this.config.chunkTimeoutMs,
      store: new GitCommitDiscoveryStore(),
    });

  /** bd tea-rags-mcp-iqpuu: factory for the run-scoped off-thread churn-walk
   *  thread — the provider owns the walk implementation, ChunkPhase owns the
   *  instance lifecycle (lazy create at first chunk dispatch, closed at
   *  drain). Arrow-property so `this` survives callback passing (precedent:
   *  createCommitDiscovery). */
  createChunkChurnWalkThread = (): ChunkChurnWalkThread => new ChunkChurnWalkThread();

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

    const concurrency = Math.max(this.config.chunkConcurrency, 1);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < missEntries.length) {
        const i = cursor++;
        const [relPath, churnData] = missEntries[i];
        const lines = await blameFile(root, relPath, this.config.logTimeoutMs);
        this.blameByChurnData.set(churnData, lines);
        this.blameByRelPath.set(relPath, lines);
        const oid = oidByPath.get(relPath);
        // Cache only non-empty results: [] can be a transient blame failure
        // (blameFile swallows errors) — pinning it would freeze the failure.
        if (oid && lines.length > 0) {
          cache.set(relPath, { oid, lines });
          this.blameCacheDirty = true;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, missEntries.length) }, worker));

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
      if (this.oidReaderRoot !== root || !this.oidReader) {
        await this.oidReader?.close().catch(() => undefined);
        this.oidReader = createCatFileBatchCheck(root);
        this.oidReaderRoot = root;
      }
      const reader = this.oidReader;
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
    // duck type is structurally ChunkChurnWalkThread — cast at the boundary
    // (precedent: blobReader below).
    const walkThread = options?.churnWalkThread as unknown as ChunkChurnWalkThread | undefined;
    let rawResult: Map<string, Map<string, ChunkChurnOverlay>>;
    if (walkThread && options?.commitDiscovery && options.skipCache) {
      rawResult = await this.walkChunkChurnOffThread(root, chunkMap, walkThread, options.commitDiscovery, options);
    } else {
      rawResult = await buildChunkChurnMap(
        root,
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
        // one. The duck-typed contract shape is structurally CatFileBatchReader.
        options?.blobReader as CatFileBatchReader | undefined,
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
    walkThread: ChunkChurnWalkThread,
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
