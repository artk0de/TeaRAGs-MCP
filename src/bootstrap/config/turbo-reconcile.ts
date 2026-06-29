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
  listCollections(): Promise<string[]>;
  getQuantizationConfig(name: string): Promise<unknown>;
  updateCollectionQuantization(name: string): Promise<void>;
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
