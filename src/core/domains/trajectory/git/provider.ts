/**
 * GitEnrichmentProvider — implements EnrichmentProvider for git trajectory metrics.
 *
 * Wires file-reader + chunk-reader + caches.
 * Owns both the isomorphic-git pack cache (for readBlob/readCommit)
 * and the HEAD-based enrichment result cache.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { blameFile, resolveRepoRoot, type CatFileBatchReader } from "../../../adapters/git/client.js";
import type { BlameLine, CommitInfo, FileChurnData } from "../../../adapters/git/types.js";
import type { TrajectoryGitConfig } from "../../../contracts/types/config.js";
import type {
  ChunkLookupEntry,
  ChunkSignalOptions,
  ChunkSignalOverlay,
  EnrichmentProvider,
  FileSignalOptions,
  FileSignalOverlay,
  FileSignalTransform,
  FilterDescriptor,
  WorkerEnrichmentDescriptor,
} from "../../../contracts/types/provider.js";
import type { RerankPreset } from "../../../contracts/types/reranker.js";
import { gitFilters } from "./filters.js";
import { GitEnrichmentCache } from "./infra/cache.js";
import { buildChunkChurnMap } from "./infra/chunk-reader.js";
import { buildFileSignalMap, buildFileSignalsForPaths } from "./infra/file-reader.js";
import { buildBugFixShaSet } from "./infra/merge-branch-resolver.js";
import type { SquashOptions } from "./infra/metrics.js";
import { assembleFileSignals } from "./infra/metrics/file-assembler.js";
import { gitPayloadSignalDescriptors } from "./payload-signals.js";
import { gitDerivedSignals } from "./rerank/derived-signals/index.js";
import { GIT_PRESETS } from "./rerank/presets/index.js";

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

  readonly fileSignalTransform: FileSignalTransform;

  private readonly enrichmentCache = new GitEnrichmentCache();
  private readonly isoGitCache: Record<string, unknown> = {};
  private lastFileResult: Map<string, FileChurnData> | null = null;

  async buildFileSignals(root: string, options?: { paths?: string[] }): Promise<Map<string, FileSignalOverlay>> {
    // Fast check: skip if not a git repo
    if (!existsSync(join(root, ".git"))) {
      return new Map();
    }

    let rawData: Map<string, FileChurnData>;

    if (options?.paths) {
      rawData = await buildFileSignalsForPaths(root, options.paths, this.config.logTimeoutMs);
    } else {
      rawData = await buildFileSignalMap(
        root,
        this.enrichmentCache,
        this.config.logMaxAgeMonths,
        this.config.logTimeoutMs,
      );
    }

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
    await this.populateBlameMap(root, rawData);

    // Return raw FileChurnData — coordinator/applier will call computeFileSignals
    // with actual line count when applying per-file
    const result = new Map<string, FileSignalOverlay>();
    for (const [path, churnData] of rawData) {
      result.set(path, churnData as unknown as FileSignalOverlay);
    }
    return result;
  }

  /** Per-batch streaming: same computation as buildFileSignals, scoped to the
   *  batch's paths. Populates blameByRelPath/lastFileResult for the batch so
   *  the matching buildChunkSignals call (same batch) sees per-range ownership.
   *  Arrow-property so `this` survives being passed as a coordinator callback. */
  streamFileBatch = async (
    root: string,
    batchPaths: string[],
    _options?: FileSignalOptions,
  ): Promise<Map<string, FileSignalOverlay>> => {
    return this.buildFileSignals(root, { paths: batchPaths });
  };

  /** git streams file+chunk signals per batch — nothing is deferred, so the
   *  file finalize is an empty no-op (and defersChunkEnrichment stays unset). */
  finalizeSignals = async (): Promise<Map<string, FileSignalOverlay>> => new Map();

  /** Run `git blame HEAD` per file in parallel batches and store results in
   *  the WeakMap for later transform-time lookup. Failures fall back to empty
   *  arrays — assembleFileSignals will produce unknown ownership.
   *
   *  Accumulates into `this.blameByRelPath` across calls — buildFileSignals
   *  may be invoked multiple times per indexing run (initial pass + backfill,
   *  reindex_changes, etc.). chunk enrichment runs AFTER all file passes via
   *  buildChunkSignals, so the chunk-level blame map must retain entries from
   *  every prior pass. Replacing the map would erase blame for files indexed
   *  in earlier batches and produce "unknown" chunk ownership. */
  private async populateBlameMap(root: string, rawData: Map<string, FileChurnData>): Promise<void> {
    const concurrency = Math.max(this.config.chunkConcurrency, 1);
    const entries = Array.from(rawData.entries());
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (cursor < entries.length) {
        const i = cursor++;
        const [relPath, churnData] = entries[i];
        const lines = await blameFile(root, relPath, this.config.logTimeoutMs);
        this.blameByChurnData.set(churnData, lines);
        this.blameByRelPath.set(relPath, lines);
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  }

  async buildChunkSignals(
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    options?: ChunkSignalOptions,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    const rawResult = await buildChunkChurnMap(
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
    );

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
}
