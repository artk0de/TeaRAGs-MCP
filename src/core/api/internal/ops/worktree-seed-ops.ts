/**
 * WorktreeSeedOps — seeds a new working tree's first index from a registered
 * sibling working tree of the same repository (bd tea-rags-mcp-k8gac).
 *
 * The explicit `tea-rags worktree create` already reuses a sibling's index: it
 * clones the six-artifact footprint (Qdrant points by snapshot, the codegraph
 * database, the file-hash snapshot re-pathed, stats, quarantine), and the next
 * incremental sync re-embeds only the files whose content hash differs from the
 * cloned snapshot. So the only thing missing for a plain first
 * `index-codebase` / `index_codebase` was the automatic half — deciding THAT a
 * sibling may seed and WHICH — and this class is that half. It clones through
 * the same saga (`cloneCollectionFootprint`); the index run that called it then
 * runs its ordinary incremental path over the result.
 *
 * A sibling seeds only when all of these hold, checked cheapest first:
 * 1. its stamps match the current run (`checkWorktreeSeedCompatibility`);
 * 2. the caller could CLAIM it — no index run or background enrichment is
 *    working on it, here or in another process — and the claim is held until
 *    the clone is done, so a run cannot start writing into the snapshot being
 *    taken and no half-enriched state is copied;
 * 3. under that claim, its collection exists, its last index completed, and it
 *    has a file snapshot the incremental sync can diff against;
 * 4. its vectors pass this run's weights canary (`EmbeddingModelGuard`).
 * A refused sibling hands over to the next; every refusal is reported.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { EmbeddingModelGuard } from "../../../adapters/qdrant/embedding-model-guard.js";
import { INDEXING_METADATA_ID } from "../../../contracts/constants.js";
import type { CollectionAlias } from "../../../contracts/types/collection-identity.js";
import type { CollectionEntry } from "../../../contracts/types/registry.js";
import type {
  WorktreeSeedCandidateRejection,
  WorktreeSeedRejectionReason,
  WorktreeSeedSourceRef,
} from "../../../contracts/types/worktree.js";
import {
  parseMarkerPayload,
  type WorktreeSeedPending,
} from "../../../domains/ingest/pipeline/indexing-marker-codec.js";
import { worktreeSeedPendingMarkerPatch } from "../../../domains/ingest/pipeline/indexing-marker.js";
import { ShardedSnapshotManager } from "../../../domains/ingest/sync/snapshot/sharded-snapshot.js";
import {
  cloneCollectionFootprint,
  type CollectionFootprintFactory,
  type ResolvedCollection,
} from "../../../domains/maintenance/footprint/index.js";
import {
  checkWorktreeSeedCompatibility,
  findWorktreeSeedCandidates,
  type WorktreeSeedBuildIdentity,
} from "../../../domains/maintenance/worktree/worktree-seed-source.js";
import { versionedPhysicalCollectionName } from "../../../infra/collection-name.js";
import type { StatsCache } from "../../../infra/stats-cache.js";

export interface WorktreeSeedOpsDeps {
  registry: { list: () => CollectionEntry[] };
  qdrant: QdrantManager;
  statsCache: Pick<StatsCache, "load">;
  footprintFactory: Pick<CollectionFootprintFactory, "build">;
  /** Where per-collection snapshots live — the source's file count is read from its snapshot. */
  snapshotDir: string;
  /** Weights canary; omitted → only the model NAME is compared (by the stamp gate). */
  modelGuard?: Pick<EmbeddingModelGuard, "ensureMatch">;
}

/** Lets go of a claimed sibling. */
export type WorktreeSeedSourceRelease = () => Promise<void>;

export interface WorktreeSeedRequest {
  /** Validated absolute path of the working tree being indexed. */
  targetPath: string;
  /** The logical collection the run writes for `targetPath`; it does not exist yet. */
  targetCollection: CollectionAlias;
  build: WorktreeSeedBuildIdentity;
  /**
   * What the seeded collection will owe until its stamp and git rebuild are
   * done. The clone records it on the target's marker BEFORE the target is
   * addressable, so a process that dies anywhere after that — mid-saga, or
   * between the saga and the seeded incremental — leaves a clone the next run
   * resumes instead of one it mistakes for a settled index.
   */
  pending: WorktreeSeedPending;
  /**
   * Take the sibling the way an index run takes its own collection, for the
   * clone's duration. `undefined` means it is busy. Owned by the caller: the
   * in-process claim set and the indexing lock live with `IndexingOps`.
   */
  claimSource: (sourceCollection: string) => Promise<WorktreeSeedSourceRelease | undefined>;
}

export type WorktreeSeedAttempt =
  | {
      status: "seeded";
      source: WorktreeSeedSourceRef;
      /** Files the cloned snapshot lists — the set the incremental sync diffs against. */
      sourceFiles: number;
      rejected: WorktreeSeedCandidateRejection[];
    }
  | {
      status: "skipped";
      reason: "no-sibling" | "no-compatible-sibling";
      rejected: WorktreeSeedCandidateRejection[];
    };

/** A refusal of one candidate, before it is tagged with which candidate. */
interface WorktreeSeedCandidateRefusal {
  reason: WorktreeSeedRejectionReason;
  detail: string;
}

export class WorktreeSeedOps {
  constructor(private readonly deps: WorktreeSeedOpsDeps) {}

  async seed(request: WorktreeSeedRequest): Promise<WorktreeSeedAttempt> {
    const candidates = findWorktreeSeedCandidates(this.deps.registry, {
      path: request.targetPath,
      collectionName: request.targetCollection,
    });
    if (candidates.length === 0) return { status: "skipped", reason: "no-sibling", rejected: [] };

    const rejected: WorktreeSeedCandidateRejection[] = [];
    for (const candidate of candidates) {
      const outcome = await this.trySeedFrom(candidate, request);
      if (typeof outcome === "number") {
        return { status: "seeded", source: sourceRefOf(candidate), sourceFiles: outcome, rejected };
      }
      rejected.push({ ...sourceRefOf(candidate), ...outcome });
    }
    return { status: "skipped", reason: "no-compatible-sibling", rejected };
  }

  /** The source's snapshot file count once its footprint is cloned, or why it was refused. */
  private async trySeedFrom(
    candidate: CollectionEntry,
    request: WorktreeSeedRequest,
  ): Promise<number | WorktreeSeedCandidateRefusal> {
    const incompatible = checkWorktreeSeedCompatibility(
      { entry: candidate, stats: this.deps.statsCache.load(candidate.collectionName) },
      request.build,
    );
    if (incompatible) return incompatible;

    const release = await request.claimSource(candidate.collectionName);
    if (!release) {
      return { reason: "source-busy", detail: "an index run or its background enrichment holds the sibling" };
    }
    try {
      return await this.cloneClaimed(candidate, request);
    } finally {
      await release();
    }
  }

  private async cloneClaimed(
    candidate: CollectionEntry,
    request: WorktreeSeedRequest,
  ): Promise<number | WorktreeSeedCandidateRefusal> {
    const notIndexed = await this.checkIndexed(candidate.collectionName);
    if (notIndexed) return notIndexed;

    const sourceFiles = await countSnapshotFiles(this.deps.snapshotDir, candidate.collectionName);
    if (sourceFiles === undefined) {
      return { reason: "source-not-indexed", detail: "the sibling has no file snapshot to diff against" };
    }

    try {
      await this.deps.modelGuard?.ensureMatch(candidate.collectionName);
    } catch (error) {
      return { reason: "embedding-model", detail: messageOf(error) };
    }

    try {
      const source = await this.resolveSource(candidate);
      const target: ResolvedCollection = {
        ...source,
        logicalName: request.targetCollection,
        // A seeded collection is brand new: its first generation, as for a worktree clone.
        physicalName: versionedPhysicalCollectionName(request.targetCollection, 1),
        path: request.targetPath,
      };
      await cloneCollectionFootprint(
        this.deps.footprintFactory,
        source,
        target,
        worktreeSeedPendingMarkerPatch(request.pending),
      );
    } catch (error) {
      return { reason: "clone-failed", detail: messageOf(error) };
    }
    return sourceFiles;
  }

  /** Read under the claim: a completed marker is only trustworthy once nobody can start a run. */
  private async checkIndexed(collectionName: string): Promise<WorktreeSeedCandidateRefusal | undefined> {
    if (!(await this.deps.qdrant.collectionExists(collectionName))) {
      return { reason: "source-not-indexed", detail: "the sibling's collection does not exist" };
    }
    const point = await this.deps.qdrant.getPoint(collectionName, INDEXING_METADATA_ID);
    if (!point?.payload || !parseMarkerPayload(point.payload).indexingComplete) {
      return { reason: "source-not-indexed", detail: "the sibling's last index did not complete" };
    }
    return undefined;
  }

  private async resolveSource(candidate: CollectionEntry): Promise<ResolvedCollection> {
    return {
      logicalName: candidate.collectionName,
      physicalName: await this.deps.qdrant.aliases.resolveActive(candidate.collectionName),
      path: candidate.path,
      embeddingModel: candidate.embeddingModel,
      embeddingDimensions: candidate.embeddingDimensions,
      qdrantUrl: candidate.qdrantUrl,
      codegraphEnabled: candidate.codegraphEnabled ?? false,
    };
  }
}

function sourceRefOf(entry: CollectionEntry): WorktreeSeedSourceRef {
  return { collectionName: entry.collectionName, project: entry.name ?? null, path: entry.path };
}

/** Files the collection's snapshot lists; `undefined` when it has none. */
async function countSnapshotFiles(snapshotDir: string, collectionName: string): Promise<number | undefined> {
  const snapshot = await new ShardedSnapshotManager(snapshotDir, collectionName).load();
  return snapshot ? snapshot.files.size : undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
