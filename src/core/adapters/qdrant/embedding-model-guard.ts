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

import type { EmbeddingCallOptions, EmbeddingProvider } from "../../adapters/embeddings/base.js";
import {
  EmbeddingModelMismatchError,
  isEmbeddingProviderUnavailable,
  isProviderRecoveryWaitSpent,
  type EmbeddingError,
} from "../../adapters/embeddings/errors.js";
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
  /** Set when the create path's canary embed found the provider down. See `EmbeddingCanaryEmbed`. */
  providerOutage?: EmbeddingError;
}

/**
 * One canary embed: the canary, or why there is none. `providerOutage` is set
 * for a provider that is unreachable (`isEmbeddingProviderUnavailable`) or gave
 * up after spending its recovery wait (`isProviderRecoveryWaitSpent`); any
 * other failure leaves both fields unset.
 */
interface EmbeddingCanaryEmbed {
  canary?: EmbeddingCanaryRecord;
  providerOutage?: EmbeddingError;
}

/**
 * What one caller of `ensureMatch` needs beyond the verdict.
 * `maxRecoveryWaitMs` bounds the canary embed's wait for a down provider (see
 * `EmbeddingCallOptions`): a search passes `READ_PATH_EMBEDDING_RECOVERY_WAIT_MS`.
 */
export interface EmbeddingModelGuardCallOptions extends EmbeddingCallOptions {
  /**
   * The caller embeds right after this check (indexing, adding documents, a
   * query-embedding search). A provider that is DOWN — it gave up after
   * spending its recovery wait on the canary — is then thrown here instead of
   * swallowed, so the caller fails once instead of paying that wait a second
   * time on its own embed. So is one the canary found unreachable within a
   * budget no shorter than the caller's own `maxRecoveryWaitMs`: the caller's
   * embed would fail the same way. Callers that read the index without
   * embedding leave it off: an outage does not concern them.
   */
  failOnProviderOutage?: boolean;
  /**
   * The caller compares no freshly embedded vector against the index
   * (`rank_chunks`, `find_symbol`): weight drift cannot corrupt its answer, so
   * only the model NAME is checked — from a cached verdict, else from the
   * marker. Nothing is embedded, created or cached; the canary waits for the
   * first caller that embeds. Embedding it here made every cold call of such a
   * tool wait out the provider's endpoint failover (bd tea-rags-mcp-xi2r9, B3).
   */
  nameOnly?: boolean;
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
  /**
   * The canary embed found the provider down. Never cached: it goes to the
   * callers of THIS check only, and a later check measures the provider anew.
   */
  providerOutage?: EmbeddingError;
}

/**
 * What a settled check hands its callers: the verdict, an outage if it saw one,
 * and the recovery budget its canary embed ran with (undefined = configured).
 */
interface EmbeddingModelCheckSettlement extends Pick<EmbeddingModelCheckOutcome, "verdict" | "providerOutage"> {
  canaryRecoveryWaitMs?: number;
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

/**
 * Does the outage a check saw concern a caller that embeds next? Yes when the
 * provider already spent its recovery wait (the caller would wait it out
 * again), or when the canary ran under a recovery budget no shorter than the
 * caller's own (the caller's embed would fail the same way). A caller allowed
 * to wait longer than the check did — indexing joining a search's check — still
 * gets its own wait.
 */
function outageConcernsCaller(
  settled: EmbeddingModelCheckSettlement,
  callerRecoveryWaitMs: number | undefined,
): settled is EmbeddingModelCheckSettlement & { providerOutage: EmbeddingError } {
  const outage = settled.providerOutage;
  if (!outage) return false;
  if (isProviderRecoveryWaitSpent(outage)) return true;
  const checkBudget = settled.canaryRecoveryWaitMs;
  return checkBudget !== undefined && callerRecoveryWaitMs !== undefined && callerRecoveryWaitMs <= checkBudget;
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

  /** Checks currently running, one per collection. See `startCheck`. */
  private readonly pending = new Map<string, Promise<EmbeddingModelCheckSettlement | undefined>>();

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
   * the model name and the canary when missing (legacy collections). With
   * `failOnProviderOutage`, also throws the provider's error when the canary
   * embed found the provider down.
   */
  async ensureMatch(collectionName: string, options?: EmbeddingModelGuardCallOptions): Promise<void> {
    // The provider decides its endpoint lazily, and a failover it decides
    // invalidates every check in flight. Deciding before a check registers
    // keeps the first check from being discarded by the decision its own
    // canary embed would trigger. A name-only caller embeds nothing and must
    // not force the decision.
    if (!options?.nameOnly) await this.embeddings?.resolveEndpoint?.();

    const cached = this.cache.get(collectionName);
    if (cached) {
      this.assertVerdict(cached);
      return;
    }
    if (options?.nameOnly) {
      await this.assertMarkerName(collectionName);
      return;
    }

    // Cold: one check per collection, however many callers arrive. A cold start
    // fans several searches at the same collection, and each would otherwise
    // read the marker and embed the canary for itself.
    const settled = await (this.pending.get(collectionName) ??
      this.startCheck(collectionName, options?.maxRecoveryWaitMs));
    // undefined = the check was invalidated while in flight; it measured an
    // endpoint or an index state that no longer applies, so nothing to assert.
    if (!settled) return;
    this.assertVerdict(settled.verdict);
    if (options?.failOnProviderOutage && outageConcernsCaller(settled, options.maxRecoveryWaitMs)) {
      throw settled.providerOutage;
    }
  }

  /**
   * Run one check and register it as the in-flight one for this collection.
   *
   * The result is installed only while this check is still the registered one.
   * `invalidate` / `invalidateAll` drop the registration, so a check that began
   * before an endpoint failover cannot write its verdict behind the
   * invalidation that was meant to clear exactly that measurement.
   */
  private async startCheck(
    collectionName: string,
    canaryRecoveryWaitMs: number | undefined,
  ): Promise<EmbeddingModelCheckSettlement | undefined> {
    const checked = this.decideVerdict(collectionName, canaryRecoveryWaitMs);
    const settled: Promise<EmbeddingModelCheckSettlement | undefined> = checked.then(
      (outcome) => {
        if (this.pending.get(collectionName) !== settled) return undefined;
        this.pending.delete(collectionName);
        if (outcome.cacheable) this.cache.set(collectionName, outcome.verdict);
        return { verdict: outcome.verdict, providerOutage: outcome.providerOutage, canaryRecoveryWaitMs };
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
  private async decideVerdict(
    collectionName: string,
    canaryRecoveryWaitMs: number | undefined,
  ): Promise<EmbeddingModelCheckOutcome> {
    const marker = await this.readOrCreateMarker(collectionName, canaryRecoveryWaitMs);
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
        providerOutage: marker.providerOutage,
      };
    }

    const { canaryMismatch, canaryRan, providerOutage } = await this.compareCanary(
      collectionName,
      marker.canary,
      canaryRecoveryWaitMs,
    );
    // A canary that could not run proved nothing either way: caching the clean
    // verdict would leave the collection unguarded against weight drift for the
    // rest of the process — and a read path that waits for no provider would
    // cache it on the first blip. The next check embeds it again.
    return {
      verdict: { model: marker.model, canaryMismatch },
      cacheable: canaryRan || this.embeddings === undefined,
      providerOutage,
    };
  }

  /**
   * `nameOnly`: the marker's model name against the current one. Nothing is
   * embedded, created or cached — a missing or unreadable marker asserts
   * nothing here, exactly as the full check's marker-catch would, and the full
   * check of the first caller that embeds still runs.
   */
  private async assertMarkerName(collectionName: string): Promise<void> {
    let model: unknown;
    try {
      model = (await this.qdrant.getPoint(collectionName, INDEXING_METADATA_ID))?.payload?.embeddingModel;
    } catch {
      return;
    }
    this.assertVerdict({ model: typeof model === "string" ? model : null, canaryMismatch: null });
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
   * Compare the stored canary against a freshly embedded one. `canaryMismatch`
   * is the mismatch description, or null when the canary passed, was written
   * for the first time, or could not be embedded — `canaryRan` tells the last
   * case apart.
   */
  private async compareCanary(
    collectionName: string,
    stored: EmbeddingCanaryRecord | undefined,
    canaryRecoveryWaitMs: number | undefined,
  ): Promise<{ canaryMismatch: string | null; canaryRan: boolean; providerOutage?: EmbeddingError }> {
    const { canary: fresh, providerOutage } = await this.embedCanary(collectionName, canaryRecoveryWaitMs);
    if (!fresh) return { canaryMismatch: null, canaryRan: false, providerOutage };

    // No canary yet (legacy marker), or one written for a different text — the
    // stored vector says nothing about the current canary, so replace it.
    if (stored?.text !== EMBEDDING_CANARY_TEXT) {
      await this.writeCanary(collectionName, fresh);
      return { canaryMismatch: null, canaryRan: true };
    }

    // A width change is a model change by itself, and cosine over ragged arrays
    // is NaN — which would compare false against the threshold and pass.
    const similarity = stored.vector.length === fresh.vector.length ? cosine(fresh.vector, stored.vector) : 0;
    if (similarity < EMBEDDING_CANARY_MIN_COSINE) {
      return {
        canaryMismatch: `${this.currentModel} (same name, different weights: canary cosine ${similarity.toFixed(4)})`,
        canaryRan: true,
      };
    }
    return { canaryMismatch: null, canaryRan: true };
  }

  /**
   * Embed the canary with the configured provider. No canary when there is no
   * provider, or when the embed failed — a provider that cannot embed cannot
   * prove drift either, and must not block indexing. The failure is reported
   * once per collection, exactly as a failed marker read reports disabling the
   * guard. Neither path caches a verdict the canary could not back: the next
   * check retries the embed (and, on the create path, backfills the canary).
   *
   * Never throws, so nothing new reaches the marker-catch through the create
   * path. An unreachable provider comes back as `providerOutage`: the guard
   * still does not block on it, but a caller that embeds next would fail the
   * same way — after waiting the budget out a second time, if the provider
   * already spent it — so `ensureMatch` hands the error to a
   * `failOnProviderOutage` caller it concerns (bd tea-rags-mcp-umatc).
   * `canaryRecoveryWaitMs` bounds the embed's wait (`EmbeddingCallOptions`).
   */
  private async embedCanary(
    collectionName: string,
    canaryRecoveryWaitMs: number | undefined,
  ): Promise<EmbeddingCanaryEmbed> {
    if (!this.embeddings) return {};
    try {
      const { embedding } = await (canaryRecoveryWaitMs === undefined
        ? this.embeddings.embed(EMBEDDING_CANARY_TEXT)
        : this.embeddings.embed(EMBEDDING_CANARY_TEXT, { maxRecoveryWaitMs: canaryRecoveryWaitMs }));
      return { canary: { text: EMBEDDING_CANARY_TEXT, vector: embedding } };
    } catch (error) {
      console.error(`[ModelGuard] Canary check skipped for ${collectionName}:`, error);
      return isProviderRecoveryWaitSpent(error) || isEmbeddingProviderUnavailable(error)
        ? { providerOutage: error }
        : {};
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
  private async readOrCreateMarker(
    collectionName: string,
    canaryRecoveryWaitMs: number | undefined,
  ): Promise<EmbeddingMarkerReading | undefined> {
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
      const { canary, providerOutage } = await this.embedCanary(collectionName, canaryRecoveryWaitMs);
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
      return { model: this.currentModel, canary, createdNow: true, providerOutage };
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
