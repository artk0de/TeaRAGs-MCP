/**
 * EnrichmentRecovery — detects chunks missing enrichedAt timestamps and re-enriches them.
 *
 * Scrolls Qdrant for chunks where `{providerKey}.{level}.enrichedAt` is empty/missing,
 * groups them by file, and calls the provider to re-enrich.
 */

import type { QdrantManager } from "../../../../adapters/qdrant/client.js";
import type { ChunkLookupEntry } from "../../../../types.js";
import { isDebug } from "../infra/runtime.js";
import type { ChunkItem } from "../types.js";
import type { EnrichmentApplier } from "./applier.js";
import type { EnrichmentProvider } from "./types.js";

export interface RecoveryResult {
  recoveredFiles: number;
  recoveredChunks: number;
  remainingUnenriched: number;
}

interface UnenrichedPoint {
  id: string | number;
  relativePath: string;
  startLine?: number;
  endLine?: number;
}

const SCROLL_LIMIT = 10_000;

export interface RecoveryOptions {
  scrollPageSize?: number;
}

export class EnrichmentRecovery {
  private readonly scrollPageSize: number | undefined;

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly applier: EnrichmentApplier,
    options?: RecoveryOptions,
  ) {
    this.scrollPageSize = options?.scrollPageSize;
  }

  /**
   * Re-enrich file-level signals for chunks missing `{providerKey}.file.enrichedAt`.
   */
  async recoverFileLevel(
    collectionName: string,
    absolutePath: string,
    provider: EnrichmentProvider,
    enrichedAt: string,
  ): Promise<RecoveryResult> {
    const unenriched = await this.scrollUnenriched(collectionName, provider.key, "file");

    if (unenriched.length === 0) {
      return { recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 };
    }

    try {
      const root = provider.resolveRoot(absolutePath);
      const uniquePaths = [...new Set(unenriched.map((p) => p.relativePath))];

      const signals = await provider.buildFileSignals(root, { paths: uniquePaths });

      // Build ChunkItem-like objects for applyFileSignals
      const items = unenriched.map((point) => ({
        chunkId: String(point.id),
        chunk: {
          metadata: {
            filePath: root.endsWith("/") ? `${root}${point.relativePath}` : `${root}/${point.relativePath}`,
          },
          startLine: point.startLine ?? 0,
          endLine: point.endLine ?? 0,
          content: "",
        },
      }));

      await this.applier.applyFileSignals(
        collectionName,
        provider.key,
        signals,
        root,
        items as unknown as ChunkItem[],
        provider.fileSignalTransform,
        enrichedAt,
      );

      const remaining = await this.countUnenriched(collectionName, provider.key, "file");

      return {
        recoveredFiles: uniquePaths.length,
        recoveredChunks: unenriched.length,
        remainingUnenriched: remaining,
      };
    } catch (error) {
      if (isDebug()) {
        console.error(`[EnrichmentRecovery:${provider.key}] recoverFileLevel failed:`, error);
      }
      return {
        recoveredFiles: 0,
        recoveredChunks: 0,
        remainingUnenriched: unenriched.length,
      };
    }
  }

  /**
   * Re-enrich chunk-level signals for chunks missing `{providerKey}.chunk.enrichedAt`.
   */
  async recoverChunkLevel(
    collectionName: string,
    absolutePath: string,
    provider: EnrichmentProvider,
    enrichedAt: string,
  ): Promise<RecoveryResult> {
    const unenriched = await this.scrollUnenriched(collectionName, provider.key, "chunk");

    if (unenriched.length === 0) {
      return { recoveredFiles: 0, recoveredChunks: 0, remainingUnenriched: 0 };
    }

    try {
      const root = provider.resolveRoot(absolutePath);

      // Build chunkMap: Map<relativePath, ChunkLookupEntry[]>
      const chunkMap = new Map<string, { chunkId: string; startLine: number; endLine: number }[]>();
      for (const point of unenriched) {
        const existing = chunkMap.get(point.relativePath) ?? [];
        existing.push({
          chunkId: String(point.id),
          startLine: point.startLine ?? 0,
          endLine: point.endLine ?? 0,
        });
        chunkMap.set(point.relativePath, existing);
      }

      const allChunkIds = new Set<string>();
      for (const entries of chunkMap.values()) {
        for (const entry of entries) allChunkIds.add(entry.chunkId);
      }

      const chunkSignals = await provider.buildChunkSignals(
        root,
        chunkMap as unknown as Map<string, ChunkLookupEntry[]>,
      );
      const applied = await this.applier.applyChunkSignals(
        collectionName,
        provider.key,
        chunkSignals,
        enrichedAt,
        allChunkIds,
      );

      const remaining = await this.countUnenriched(collectionName, provider.key, "chunk");

      return {
        recoveredFiles: chunkMap.size,
        recoveredChunks: applied,
        remainingUnenriched: remaining,
      };
    } catch (error) {
      if (isDebug()) {
        console.error(`[EnrichmentRecovery:${provider.key}] recoverChunkLevel failed:`, error);
      }
      return {
        recoveredFiles: 0,
        recoveredChunks: 0,
        remainingUnenriched: unenriched.length,
      };
    }
  }

  /**
   * Count chunks missing enrichedAt for the given provider key and level.
   * Uses Qdrant count API — lightweight, no payload transfer.
   */
  async countUnenriched(collectionName: string, providerKey: string, level: "file" | "chunk"): Promise<number> {
    const filter = this.buildUnenrichedFilter(providerKey, level);
    return this.qdrant.countPoints(collectionName, filter);
  }

  /**
   * Build the Qdrant filter for chunks missing `{providerKey}.{level}.enrichedAt`.
   */
  private buildUnenrichedFilter(providerKey: string, level: "file" | "chunk"): Record<string, unknown> {
    const enrichedAtField = `${providerKey}.${level}.enrichedAt`;
    return {
      must: [{ is_empty: { key: enrichedAtField } }],
      must_not: [
        { key: "_type", match: { value: "indexing_metadata" } },
        { key: "_type", match: { value: "schema_metadata" } },
      ],
    };
  }

  /**
   * Scroll Qdrant for chunks missing `{providerKey}.{level}.enrichedAt`.
   * Excludes the metadata point (INDEXING_METADATA_ID).
   */
  private async scrollUnenriched(
    collectionName: string,
    providerKey: string,
    level: "file" | "chunk",
  ): Promise<UnenrichedPoint[]> {
    const filter = this.buildUnenrichedFilter(providerKey, level);
    const points = await this.qdrant.scrollFiltered(collectionName, filter, SCROLL_LIMIT, this.scrollPageSize);

    const result: UnenrichedPoint[] = [];
    for (const point of points) {
      const relativePath = typeof point.payload?.relativePath === "string" ? point.payload.relativePath : null;
      if (!relativePath) continue;
      result.push({
        id: point.id,
        relativePath,
        startLine: typeof point.payload?.startLine === "number" ? point.payload.startLine : undefined,
        endLine: typeof point.payload?.endLine === "number" ? point.payload.endLine : undefined,
      });
    }
    return result;
  }
}
