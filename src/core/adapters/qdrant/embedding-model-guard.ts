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
import { cosine } from "../../infra/vector-math.js";
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
  /**
   * True when THIS call created the marker. Its canary was written from the
   * model in hand, so there is nothing to compare and nothing to embed twice.
   */
  createdNow?: boolean;
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

/** One completed check: what it decided, and whether that is worth remembering. */
interface EmbeddingModelCheckOutcome {
  verdict: EmbeddingModelVerdict;
  /**
   * False when the collection still owes a canary — a marker created while the
   * provider could not embed. Caching a clean verdict there would leave that
   * collection unguarded for the rest of the process; the next check retries.
   */
  cacheable: boolean;
}

/**
 * What to do about a model that kept its name and changed its weights. The
 * default mismatch hint cannot help here: its first option is to point
 * EMBEDDING_MODEL back at the stored name, which is already the configured one.
 */
const CANARY_MISMATCH_HINT =
  `The collection was built by a different build of the same model name — a republished tag.\n` +
  `1. Rebuild with the model you have now: tea-rags index-codebase --project <alias> --force\n` +
  `2. Or restore the weights the index was built with (pin a version tag instead of ":latest")`;

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

  /** Checks currently running, one per collection. See `startCheck`. */
  private readonly pending = new Map<string, Promise<EmbeddingModelVerdict | undefined>>();

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
    const cached = this.cache.get(collectionName);
    if (cached) {
      this.assertVerdict(cached);
      return;
    }

    // Cold: one check per collection, however many callers arrive. A cold start
    // fans several searches at the same collection, and each would otherwise
    // read the marker and embed the canary for itself.
    const verdict = await (this.pending.get(collectionName) ?? this.startCheck(collectionName));
    // undefined = the check was invalidated while in flight; it measured an
    // endpoint or an index state that no longer applies, so nothing to assert.
    if (verdict) this.assertVerdict(verdict);
  }

  /**
   * Run one check and register it as the in-flight one for this collection.
   *
   * The result is installed only while this check is still the registered one.
   * `invalidate` / `invalidateAll` drop the registration, so a check that began
   * before an endpoint failover cannot write its verdict behind the
   * invalidation that was meant to clear exactly that measurement.
   */
  private async startCheck(collectionName: string): Promise<EmbeddingModelVerdict | undefined> {
    const checked = this.decideVerdict(collectionName);
    const settled: Promise<EmbeddingModelVerdict | undefined> = checked.then(
      (outcome) => {
        if (this.pending.get(collectionName) !== settled) return undefined;
        this.pending.delete(collectionName);
        if (outcome.cacheable) this.cache.set(collectionName, outcome.verdict);
        return outcome.verdict;
      },
      (error: unknown) => {
        // Clear the registration before rethrowing, or every later call would
        // await this same rejected promise instead of retrying.
        if (this.pending.get(collectionName) === settled) this.pending.delete(collectionName);
        throw error;
      },
    );
    // Registered before the first await, so callers arriving in the same tick
    // find this check instead of starting their own.
    this.pending.set(collectionName, settled);
    return settled;
  }

  /** Decide the verdict for one collection. Reads the marker, then the canary. */
  private async decideVerdict(collectionName: string): Promise<EmbeddingModelCheckOutcome> {
    const marker = await this.readOrCreateMarker(collectionName);
    // Marker unreachable — the guard disabled itself for this collection. A
    // null model asserts nothing, and it is cached so the failure is reported
    // once rather than on every search.
    if (marker === undefined) return { verdict: { model: null, canaryMismatch: null }, cacheable: true };

    // Name first: a wrong name is decided without a provider round-trip.
    if (marker.model && marker.model !== this.currentModel) {
      return { verdict: { model: marker.model, canaryMismatch: null }, cacheable: true };
    }

    // A marker this call just created already carries the current model's
    // canary — unless the embed failed, and then the collection still owes one.
    if (marker.createdNow) {
      return {
        verdict: { model: marker.model, canaryMismatch: null },
        cacheable: marker.canary !== undefined || this.embeddings === undefined,
      };
    }

    return {
      verdict: {
        model: marker.model,
        canaryMismatch: await this.compareCanary(collectionName, marker.canary),
      },
      cacheable: true,
    };
  }

  /** Re-derive the throw from a cached verdict, so a mismatch stays sticky. */
  private assertVerdict(verdict: EmbeddingModelVerdict): void {
    if (verdict.model && verdict.model !== this.currentModel) {
      throw new EmbeddingModelMismatchError(verdict.model, this.currentModel);
    }
    if (verdict.canaryMismatch) {
      throw new EmbeddingModelMismatchError(
        verdict.model ?? this.currentModel,
        verdict.canaryMismatch,
        CANARY_MISMATCH_HINT,
      );
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
    const fresh = await this.embedCanary(collectionName);
    if (!fresh) return null;

    // No canary yet (legacy marker), or one written for a different text — the
    // stored vector says nothing about the current canary, so replace it.
    if (stored?.text !== EMBEDDING_CANARY_TEXT) {
      await this.writeCanary(collectionName, fresh);
      return null;
    }

    // A width change is a model change by itself, and cosine over ragged arrays
    // is NaN — which would compare false against the threshold and pass.
    const similarity = stored.vector.length === fresh.vector.length ? cosine(fresh.vector, stored.vector) : 0;
    if (similarity < EMBEDDING_CANARY_MIN_COSINE) {
      return `${this.currentModel} (same name, different weights: canary cosine ${similarity.toFixed(4)})`;
    }
    return null;
  }

  /**
   * Embed the canary with the configured provider. Returns undefined when there
   * is no provider, or when the embed failed — a provider that cannot embed
   * cannot prove drift either, and must not block indexing. The failure is
   * reported once per collection (the verdict is cached either way), exactly as
   * a failed marker read reports disabling the guard.
   */
  private async embedCanary(collectionName: string): Promise<EmbeddingCanaryRecord | undefined> {
    if (!this.embeddings) return undefined;
    try {
      const { embedding } = await this.embeddings.embed(EMBEDDING_CANARY_TEXT);
      return { text: EMBEDDING_CANARY_TEXT, vector: embedding };
    } catch (error) {
      console.error(`[ModelGuard] Canary check skipped for ${collectionName}:`, error);
      return undefined;
    }
  }

  /** Backfill the canary into an EXISTING marker. Never fatal. */
  private async writeCanary(collectionName: string, canary: EmbeddingCanaryRecord): Promise<void> {
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

      // The canary goes into the payload being written, not into a setPayload
      // right behind it: the marker is created once, and the model that fills
      // it in is the model in hand.
      const canary = await this.embedCanary(collectionName);
      const payload = {
        _type: "indexing_metadata",
        indexingComplete: true,
        embeddingModel: this.currentModel,
        ...(canary && { canary }),
      };

      if (collectionInfo.hybridEnabled) {
        await this.qdrant.addPointsWithSparse(collectionName, [
          {
            id: INDEXING_METADATA_ID,
            vector: zeroVector,
            sparseVector: { indices: [], values: [] },
            payload,
          },
        ]);
      } else {
        await this.qdrant.addPoints(collectionName, [
          {
            id: INDEXING_METADATA_ID,
            vector: zeroVector,
            payload,
          },
        ]);
      }

      if (isDebug()) {
        console.error(`[ModelGuard] Created marker with embeddingModel="${this.currentModel}" for ${collectionName}`);
      }
      return { model: this.currentModel, canary, createdNow: true };
    } catch (error) {
      if (error instanceof EmbeddingModelMismatchError) throw error;
      // Marker access failed — skip the guard so an unreachable Qdrant cannot
      // block search. Unconditional log: from here on this collection accepts
      // vectors from any model, and a debug-gated line would leave that
      // invisible on the default path.
      console.error(`[ModelGuard] Model-mixing guard disabled for ${collectionName}:`, error);
      // The caller caches the null-model verdict — a single writer, so an
      // invalidation that lands mid-check cannot be overwritten from here.
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
    // Drop any in-flight check too: this is first-hand knowledge, and a check
    // that started earlier must not land on top of it.
    this.pending.delete(collectionName);
    this.cache.set(collectionName, { model: this.currentModel, canaryMismatch: null });
  }

  /**
   * Invalidate cache entry (force reindex, clear index). Drops the in-flight
   * check with it, so one that started against the old state cannot install its
   * verdict afterwards.
   */
  invalidate(collectionName: string): void {
    this.cache.delete(collectionName);
    this.pending.delete(collectionName);
  }

  /**
   * Drop every cached verdict, and every check still running. Wired to the
   * provider's endpoint failover: the canary verdict is sticky, so a mismatch
   * measured against one endpoint would otherwise 409 every search for the rest
   * of the process even after the provider moved to an endpoint that agrees
   * with the index. The next `ensureMatch` re-embeds against whichever endpoint
   * is now in use.
   */
  invalidateAll(): void {
    this.cache.clear();
    this.pending.clear();
  }
}
