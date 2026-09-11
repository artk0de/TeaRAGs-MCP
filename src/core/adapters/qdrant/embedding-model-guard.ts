/**
 * EmbeddingModelGuard — prevents mixing vectors from different embedding models
 * in the same Qdrant collection.
 *
 * Two things can change under a collection: the model NAME (config edited) and
 * the model WEIGHTS (a tag like `:latest` republished upstream). The name is
 * compared against the marker; the weights are compared through a canary vector
 * — a fixed text embedded once at marker creation and re-embedded on every
 * later check. Same name, different vectors means the stored index was built by
 * a model that no longer exists.
 *
 * Caches the per-collection verdict in memory (one Qdrant read and one canary
 * embed per collection per MCP server lifetime). Backfills legacy collections
 * that lack the marker field or the canary.
 */

import type { EmbeddingProvider } from "../../adapters/embeddings/base.js";
import { EmbeddingModelMismatchError } from "../../adapters/embeddings/errors.js";
import { EMBEDDING_CANARY_MIN_COSINE, EMBEDDING_CANARY_TEXT, INDEXING_METADATA_ID } from "../../contracts/constants.js";
import { isDebug } from "../../infra/runtime.js";
import type { QdrantManager } from "./client.js";

/** Canary as stored in the marker payload: the text embedded, and its vector. */
interface EmbeddingCanaryRecord {
  text: string;
  vector: number[];
}

/** What the marker says about the model that built this collection. */
interface EmbeddingMarkerReading {
  /** Model name recorded in the marker; null when the guard disabled itself. */
  model: string | null;
  canary?: EmbeddingCanaryRecord;
}

/**
 * Cached per-collection outcome. Both mismatch kinds are sticky: the name check
 * re-derives from `model`, and the canary check cannot (re-embedding per call
 * would be a provider round-trip on every search), so its verdict is carried
 * here as the reason string to re-throw.
 */
interface EmbeddingModelVerdict {
  model: string | null;
  /** Canary mismatch description, or null when the canary passed / was skipped. */
  canaryMismatch: string | null;
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

/** Read a canary out of raw marker payload, ignoring anything malformed. */
function parseCanary(raw: unknown): EmbeddingCanaryRecord | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { text, vector } = raw as { text?: unknown; vector?: unknown };
  if (typeof text !== "string") return undefined;
  if (!Array.isArray(vector) || vector.some((v) => typeof v !== "number")) return undefined;
  return { text, vector: vector as number[] };
}

export class EmbeddingModelGuard {
  private readonly cache = new Map<string, EmbeddingModelVerdict>();

  constructor(
    private readonly qdrant: QdrantManager,
    private readonly currentModel: string,
    private readonly dimensions: number,
    /**
     * Optional: without it the guard compares names only. Supplied from
     * bootstrap so the canary can be embedded with the same provider that
     * embedded the corpus.
     */
    private readonly embeddings?: EmbeddingProvider,
  ) {}

  /**
   * Ensure the current embedding model matches the one that built the
   * collection — by name, and (when an embedding provider is wired) by canary
   * vector. Throws EmbeddingModelMismatchError on either mismatch. Backfills
   * the model name and the canary when missing (legacy collections).
   */
  async ensureMatch(collectionName: string): Promise<void> {
    // 1. Cache hit
    const cached = this.cache.get(collectionName);
    if (cached) {
      this.assertVerdict(cached);
      return;
    }

    // 2. Cache miss — read marker from Qdrant
    const marker = await this.readOrCreateMarker(collectionName);
    if (marker === undefined) return; // Qdrant read failed — guard disabled itself

    // 3. Name first: a wrong name is decided without a provider round-trip.
    if (marker.model && marker.model !== this.currentModel) {
      this.cache.set(collectionName, { model: marker.model, canaryMismatch: null });
      throw new EmbeddingModelMismatchError(marker.model, this.currentModel);
    }

    // 4. Same name — compare (or write) the canary, then cache and decide.
    const verdict: EmbeddingModelVerdict = {
      model: marker.model,
      canaryMismatch: await this.compareCanary(collectionName, marker.canary),
    };
    this.cache.set(collectionName, verdict);
    this.assertVerdict(verdict);
  }

  /** Re-derive the throw from a cached verdict, so a mismatch stays sticky. */
  private assertVerdict(verdict: EmbeddingModelVerdict): void {
    if (verdict.model && verdict.model !== this.currentModel) {
      throw new EmbeddingModelMismatchError(verdict.model, this.currentModel);
    }
    if (verdict.canaryMismatch) {
      throw new EmbeddingModelMismatchError(verdict.model ?? this.currentModel, verdict.canaryMismatch);
    }
  }

  /**
   * Compare the stored canary against a freshly embedded one. Returns the
   * mismatch description, or null when the canary passed, was written for the
   * first time, or could not be embedded.
   */
  private async compareCanary(
    collectionName: string,
    stored: EmbeddingCanaryRecord | undefined,
  ): Promise<string | null> {
    if (!this.embeddings) return null;

    let vector: number[];
    try {
      vector = (await this.embeddings.embed(EMBEDDING_CANARY_TEXT)).embedding;
    } catch (error) {
      // A provider that cannot embed cannot prove drift either. Skip rather than
      // block indexing — but say so, exactly as a failed marker read does: from
      // here on this collection accepts vectors from a republished model.
      console.error(`[ModelGuard] Canary check skipped for ${collectionName}:`, error);
      return null;
    }

    // No canary yet (legacy marker), or one written for a different text — the
    // stored vector says nothing about the current canary, so replace it.
    if (stored?.text !== EMBEDDING_CANARY_TEXT) {
      await this.writeCanary(collectionName, vector);
      return null;
    }

    // A width change is a model change by itself, and cosine over ragged arrays
    // is NaN — which would compare false against the threshold and pass.
    const similarity = stored.vector.length === vector.length ? cosine(vector, stored.vector) : 0;
    if (similarity < EMBEDDING_CANARY_MIN_COSINE) {
      return `${this.currentModel} (same name, different weights: canary cosine ${similarity.toFixed(4)})`;
    }
    return null;
  }

  /** Backfill the canary into an existing marker. Never fatal. */
  private async writeCanary(collectionName: string, vector: number[]): Promise<void> {
    const canary: EmbeddingCanaryRecord = { text: EMBEDDING_CANARY_TEXT, vector };
    try {
      await this.qdrant.setPayload(collectionName, { canary }, { points: [INDEXING_METADATA_ID] });
      if (isDebug()) {
        console.error(`[ModelGuard] Backfilled embedding canary for ${collectionName}`);
      }
    } catch (error) {
      // Same reasoning as the read path: an unwritable marker must not block
      // search. The collection simply stays unguarded against weight drift.
      console.error(`[ModelGuard] Failed to store the embedding canary for ${collectionName}:`, error);
    }
  }

  /** Read or create the embedding model marker. Returns undefined if Qdrant is unreachable. */
  private async readOrCreateMarker(collectionName: string): Promise<EmbeddingMarkerReading | undefined> {
    try {
      const point = await this.qdrant.getPoint(collectionName, INDEXING_METADATA_ID);

      if (point?.payload) {
        const canary = parseCanary(point.payload.canary);
        const model = point.payload.embeddingModel;
        if (typeof model === "string") return { model, canary };

        // Marker exists but no embeddingModel — backfill via setPayload
        await this.qdrant.setPayload(
          collectionName,
          { embeddingModel: this.currentModel },
          { points: [INDEXING_METADATA_ID] },
        );

        if (isDebug()) {
          console.error(`[ModelGuard] Backfilled embeddingModel="${this.currentModel}" for ${collectionName}`);
        }
        return { model: this.currentModel, canary };
      }

      // No marker point at all — create one with zero vector. Its width comes
      // from the collection, not from `this.dimensions`: the constructor value is
      // the model registry's guess, frozen at bootstrap, and a wrong guess makes
      // this very upsert fail — which disables the guard (see the catch below).
      const collectionInfo = await this.qdrant.getCollectionInfo(collectionName);
      const zeroVector = new Array<number>(collectionInfo.vectorSize || this.dimensions).fill(0);

      if (collectionInfo.hybridEnabled) {
        await this.qdrant.addPointsWithSparse(collectionName, [
          {
            id: INDEXING_METADATA_ID,
            vector: zeroVector,
            sparseVector: { indices: [], values: [] },
            payload: {
              _type: "indexing_metadata",
              indexingComplete: true,
              embeddingModel: this.currentModel,
            },
          },
        ]);
      } else {
        await this.qdrant.addPoints(collectionName, [
          {
            id: INDEXING_METADATA_ID,
            vector: zeroVector,
            payload: {
              _type: "indexing_metadata",
              indexingComplete: true,
              embeddingModel: this.currentModel,
            },
          },
        ]);
      }

      if (isDebug()) {
        console.error(`[ModelGuard] Created marker with embeddingModel="${this.currentModel}" for ${collectionName}`);
      }
      return { model: this.currentModel };
    } catch (error) {
      if (error instanceof EmbeddingModelMismatchError) throw error;
      // Marker access failed — skip the guard so an unreachable Qdrant cannot
      // block search. Unconditional log: from here on this collection accepts
      // vectors from any model, and a debug-gated line would leave that
      // invisible on the default path.
      console.error(`[ModelGuard] Model-mixing guard disabled for ${collectionName}:`, error);
      this.cache.set(collectionName, { model: null, canaryMismatch: null });
      return undefined;
    }
  }

  /**
   * Record model for a newly created collection (cache only — marker written by
   * storeIndexingMarker). The canary is deliberately left unverified here: this
   * process just created the collection with this very model, so there is no
   * drift to detect, and reading the marker back mid-index would race the
   * marker writer. The first run that sees the collection cold backfills it.
   */
  recordModel(collectionName: string): void {
    this.cache.set(collectionName, { model: this.currentModel, canaryMismatch: null });
  }

  /** Invalidate cache entry (force reindex, clear index). */
  invalidate(collectionName: string): void {
    this.cache.delete(collectionName);
  }
}
