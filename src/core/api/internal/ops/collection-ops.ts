/**
 * Collection CRUD operations — business logic extracted from MCP handlers.
 */

import type { GraphDbClientPool } from "../../../adapters/duckdb/pool.js";
import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";
import type { QdrantCollectionMemoryUsage, QdrantManager, QdrantMemoryUsage } from "../../../adapters/qdrant/client.js";
import type { EmbeddingModelGuard } from "../../../adapters/qdrant/embedding-model-guard.js";
import { resolvePhysicalCollection } from "../../../infra/collection-name.js";
import type {
  CollectionInfo,
  CollectionMemoryBytes,
  CollectionMemoryMetrics,
  CreateCollectionRequest,
} from "../../public/dto/index.js";

export class CollectionOps {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
    private readonly quantizationScalar: boolean,
    private readonly turboQuant: boolean,
    private readonly modelGuard?: EmbeddingModelGuard,
    private readonly codegraphPool?: GraphDbClientPool,
  ) {}

  async create(request: CreateCollectionRequest): Promise<CollectionInfo> {
    // Ask the provider what its model really is before sizing the collection.
    // getDimensions() alone is the static model-table guess, and a collection
    // built on a wrong guess fails at the first add_documents — after this call
    // has already reported it created successfully, at the wrong width.
    const resolved = await this.embeddings.resolveModelInfo?.().catch(() => undefined);
    const vectorSize = resolved?.dimensions || this.embeddings.getDimensions();
    const enableHybrid = request.enableHybrid || false;

    await this.qdrant.createCollection(
      request.name,
      vectorSize,
      request.distance,
      enableHybrid,
      this.quantizationScalar,
      this.turboQuant,
    );

    this.modelGuard?.recordModel(request.name);

    return {
      name: request.name,
      vectorSize,
      pointsCount: 0,
      distance: request.distance || "Cosine",
      hybridEnabled: enableHybrid,
      status: "green",
      optimizerStatus: "ok",
    };
  }

  async list(): Promise<string[]> {
    return this.qdrant.listCollections();
  }

  async getInfo(name: string): Promise<CollectionInfo> {
    return this.qdrant.getCollectionInfo(name);
  }

  /**
   * The server's memory/storage report for a collection or alias, framed for
   * consumers — null when the server cannot report it (no endpoint, missing
   * collection, unreachable). Never throws: callers render or omit.
   */
  async getMemory(name: string): Promise<CollectionMemoryMetrics | null> {
    const usage = await this.qdrant.getCollectionMemoryUsage(name);
    return usage ? buildCollectionMemoryMetrics(name, usage) : null;
  }

  /**
   * Delete a collection in Qdrant AND drop the per-collection codegraph
   * DuckDB file (when codegraph is wired). Order matters: Qdrant first
   * — if it fails we keep the DuckDB file so a retry doesn't lose
   * symbol state that still has a live collection it shadows. After
   * Qdrant succeeds, codegraph cleanup is best-effort — failure to
   * unlink the DuckDB file is non-fatal and surfaces via the typed
   * `DuckDbCloseFailedError`.
   */
  async delete(name: string): Promise<void> {
    await this.qdrant.deleteCollection(name);
    if (this.codegraphPool) {
      // Qdrant deletes a concrete collection by name and never through an alias,
      // so a name that got past that delete names a collection, not an alias —
      // resolved against no aliases (bd tea-rags-mcp-39xca.1).
      await this.codegraphPool.removeCollection(resolvePhysicalCollection(name, []));
    }
  }
}

/**
 * Raw memory report → consumer frame. File sizes are renamed to what they are
 * (apparent, not allocated); payload field indexes fold into one row that keeps
 * each field, largest first, and the server's remaining structures fold into
 * one `other` row.
 */
function buildCollectionMemoryMetrics(collection: string, usage: QdrantCollectionMemoryUsage): CollectionMemoryMetrics {
  const byField = usage.payloadIndexes
    .map(({ name, usage: fieldUsage }) => ({ field: name, bytes: toMemoryBytes(fieldUsage) }))
    .sort((a, b) => b.bytes.apparentDiskBytes - a.bytes.apparentDiskBytes);
  return {
    collection,
    total: toMemoryBytes(usage.total),
    vectors: usage.vectors.map(({ name, storage, index, quantized }) => ({
      name,
      storage: toMemoryBytes(storage),
      index: toMemoryBytes(index),
      ...(quantized ? { quantized: toMemoryBytes(quantized) } : {}),
    })),
    sparseVectors: usage.sparseVectors.map(({ name, storage, index }) => ({
      name,
      storage: toMemoryBytes(storage),
      index: toMemoryBytes(index),
    })),
    payload: toMemoryBytes(usage.payload),
    payloadIndexes: { count: byField.length, total: sumMemoryBytes(byField.map((f) => f.bytes)), byField },
    other: sumMemoryBytes(usage.other.map((o) => toMemoryBytes(o.usage))),
  };
}

function toMemoryBytes(usage: QdrantMemoryUsage): CollectionMemoryBytes {
  return {
    apparentDiskBytes: usage.diskBytes,
    ramBytes: usage.ramBytes,
    cachedBytes: usage.cachedBytes,
    expectedCacheBytes: usage.expectedCacheBytes,
  };
}

function sumMemoryBytes(parts: CollectionMemoryBytes[]): CollectionMemoryBytes {
  return parts.reduce(
    (sum, part) => ({
      apparentDiskBytes: sum.apparentDiskBytes + part.apparentDiskBytes,
      ramBytes: sum.ramBytes + part.ramBytes,
      cachedBytes: sum.cachedBytes + part.cachedBytes,
      expectedCacheBytes: sum.expectedCacheBytes + part.expectedCacheBytes,
    }),
    { apparentDiskBytes: 0, ramBytes: 0, cachedBytes: 0, expectedCacheBytes: 0 },
  );
}
