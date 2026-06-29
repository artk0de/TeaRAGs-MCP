/**
 * Startup TurboQuant reconcile. Existing collections were created before
 * TurboQuant was enabled (or with scalar quantization); on startup we PATCH any
 * collection that is not already turbo-bits4 to turbo quantization. Qdrant
 * rebuilds the quantized vectors from the stored float vectors in the
 * background — no re-embedding / reindex. The reconcile is idempotent: a
 * collection already on turbo-bits4 is skipped.
 */

/** Minimal QdrantManager surface the reconcile depends on (ISP — keeps it unit-testable). */
export interface TurboReconcileTarget {
  listCollections: () => Promise<string[]>;
  getQuantizationConfig: (name: string) => Promise<unknown>;
  updateCollectionQuantization: (name: string) => Promise<void>;
}

/** Pure predicate: true iff the live quantization config is TurboQuant bits4. */
export function isTurboBits4(quantizationConfig: unknown): boolean {
  if (typeof quantizationConfig !== "object" || quantizationConfig === null) return false;
  const { turbo } = quantizationConfig as { turbo?: { bits?: unknown } };
  return typeof turbo === "object" && turbo !== null && turbo.bits === "bits4";
}

/**
 * Reconciles every collection to TurboQuant bits4. When `collectionNames` is
 * omitted the list is read from the manager. Only collections whose live config
 * is not already turbo-bits4 are PATCHed, so repeated startups are no-ops.
 */
export async function reconcileTurbo(qdrant: TurboReconcileTarget, collectionNames?: string[]): Promise<void> {
  const names = collectionNames ?? (await qdrant.listCollections());
  for (const name of names) {
    const config = await qdrant.getQuantizationConfig(name);
    if (!isTurboBits4(config)) {
      await qdrant.updateCollectionQuantization(name);
    }
  }
}

/** Desired strict-mode guardrails — either field may be unset (then it is not enforced). */
export interface StrictModeDesired {
  maxResidentMemoryPercent?: number;
  searchMaxBatchsize?: number;
}

/** Minimal QdrantManager surface the strict-mode reconcile depends on (ISP — keeps it unit-testable). */
export interface StrictModeReconcileTarget {
  listCollections: () => Promise<string[]>;
  getStrictModeConfig: (name: string) => Promise<unknown>;
  updateCollectionStrictMode: (name: string, strictMode: StrictModeDesired) => Promise<void>;
}

/**
 * Pure predicate: true iff the live strict-mode config already satisfies every
 * field the `desired` config sets. A live config missing a desired field (or an
 * absent config entirely) is not applied, so the reconcile will PATCH it.
 */
export function isStrictModeApplied(strictModeConfig: unknown, desired: StrictModeDesired): boolean {
  if (typeof strictModeConfig !== "object" || strictModeConfig === null) return false;
  const live = strictModeConfig as { max_resident_memory_percent?: unknown; search_max_batchsize?: unknown };
  if (desired.maxResidentMemoryPercent !== undefined && live.max_resident_memory_percent !== desired.maxResidentMemoryPercent) {
    return false;
  }
  if (desired.searchMaxBatchsize !== undefined && live.search_max_batchsize !== desired.searchMaxBatchsize) {
    return false;
  }
  return true;
}

/**
 * Reconciles every collection to the desired strict-mode guardrails. Skips
 * entirely when `desired` is empty (both fields unset). Only collections whose
 * live config does not already satisfy `desired` are PATCHed (server-side
 * config, no reindex), so repeated startups are no-ops.
 */
export async function reconcileStrictMode(
  qdrant: StrictModeReconcileTarget,
  desired: StrictModeDesired,
  collectionNames?: string[],
): Promise<void> {
  if (desired.maxResidentMemoryPercent === undefined && desired.searchMaxBatchsize === undefined) return;
  const names = collectionNames ?? (await qdrant.listCollections());
  for (const name of names) {
    const config = await qdrant.getStrictModeConfig(name);
    if (!isStrictModeApplied(config, desired)) {
      await qdrant.updateCollectionStrictMode(name, desired);
    }
  }
}
