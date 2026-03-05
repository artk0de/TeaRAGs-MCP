/**
 * GitEnrichmentProvider — implements EnrichmentProvider for git trajectory metrics.
 *
 * Wires file-reader + chunk-reader + caches.
 * Owns both the isomorphic-git pack cache (for readBlob/readCommit)
 * and the HEAD-based enrichment result cache.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import { resolveRepoRoot } from "../../adapters/git/client.js";
import type { FileChurnData } from "../../adapters/git/types.js";
import type {
  ChunkLookupEntry,
  ChunkSignalOverlay,
  EnrichmentProvider,
  FileSignalOverlay,
  FileSignalTransform,
  FilterDescriptor,
} from "../../contracts/types/provider.js";
import type { RerankPreset } from "../../contracts/types/reranker.js";
import { gitFilters } from "./filters.js";
import { GitEnrichmentCache } from "./infra/cache.js";
import { buildChunkChurnMap } from "./infra/chunk-reader.js";
import { buildFileSignalMap, buildFileSignalsForPaths } from "./infra/file-reader.js";
import type { SquashOptions } from "./infra/metrics.js";
import { assembleFileSignals } from "./infra/metrics/file-assembler.js";
import { gitPayloadSignalDescriptors } from "./payload-signals.js";
import { gitDerivedSignals } from "./rerank/derived-signals/index.js";
import { GIT_PRESETS } from "./rerank/presets/index.js";

export class GitEnrichmentProvider implements EnrichmentProvider {
  readonly key = "git";

  // ── Query-side contract ──
  readonly signals = gitPayloadSignalDescriptors;
  readonly derivedSignals = gitDerivedSignals;
  readonly filters: FilterDescriptor[] = gitFilters;
  readonly presets: RerankPreset[] = GIT_PRESETS;

  private readonly squashOpts?: SquashOptions;

  constructor(squashOpts?: SquashOptions) {
    this.squashOpts = squashOpts;
    this.fileSignalTransform = (data, maxEndLine) =>
      assembleFileSignals(
        data as unknown as FileChurnData,
        maxEndLine,
        this.squashOpts,
      ) as unknown as FileSignalOverlay;
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
      rawData = await buildFileSignalsForPaths(root, options.paths);
    } else {
      rawData = await buildFileSignalMap(root, this.enrichmentCache);
    }

    this.lastFileResult = rawData;

    // Return raw FileChurnData — coordinator/applier will call computeFileSignals
    // with actual line count when applying per-file
    const result = new Map<string, FileSignalOverlay>();
    for (const [path, churnData] of rawData) {
      result.set(path, churnData as unknown as FileSignalOverlay);
    }
    return result;
  }

  async buildChunkSignals(
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    const concurrency = parseInt(
      process.env.TRAJECTORY_GIT_CHUNK_CONCURRENCY ?? process.env.GIT_CHUNK_CONCURRENCY ?? "10",
      10,
    );
    const maxAgeMonths = parseFloat(
      process.env.TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS ?? process.env.GIT_CHUNK_MAX_AGE_MONTHS ?? "6",
    );

    const rawResult = await buildChunkChurnMap(
      root,
      chunkMap,
      this.enrichmentCache,
      this.isoGitCache,
      concurrency,
      maxAgeMonths,
      this.lastFileResult ?? undefined,
      this.squashOpts,
    );

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
