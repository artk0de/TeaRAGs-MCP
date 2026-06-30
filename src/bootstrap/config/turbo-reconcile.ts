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
 * Returns the names of the collections it migrated (the ones it PATCHed) so the
 * caller can surface a one-time migration progress phase; an empty array means
 * everything was already turbo (the steady state after the first migration).
 */
export async function reconcileTurbo(qdrant: TurboReconcileTarget, collectionNames?: string[]): Promise<string[]> {
  const names = collectionNames ?? (await qdrant.listCollections());
  const migrated: string[] = [];
  for (const name of names) {
    const config = await qdrant.getQuantizationConfig(name);
    if (!isTurboBits4(config)) {
      await qdrant.updateCollectionQuantization(name);
      migrated.push(name);
    }
  }
  return migrated;
}

/** Collection health status read by the TurboQuant migration progress poll. */
export type QuantizationCollectionStatus = "green" | "yellow" | "red" | "unknown";

/** Minimal QdrantManager surface the migration poll reads — just collection health. */
export interface QuantizationMigrationTarget {
  getCollectionStatus: (name: string) => Promise<QuantizationCollectionStatus>;
}

/** Terminal result of the migration poll: settled to green, or still optimizing at the cap. */
export type QuantizationMigrationResult = "settled" | "background";

export interface WaitForQuantizationOptions {
  /** Max number of polls before giving up and letting the optimizer finish in the background. */
  maxPolls: number;
  /** Delay between polls (ms). */
  intervalMs: number;
  /** Injected sleep (DI for tests — defaults to a real `setTimeout`). */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Polls a migrating collection's health status until it returns to "green"
 * (the optimizer pass that rebuilds the quantized vectors finished) or the poll
 * cap is hit. The cap keeps this non-blocking: a long optimizer pass resolves
 * "background" and the caller proceeds — search keeps working on the stored
 * float vectors meanwhile. Never throws: `getCollectionStatus` swallows its own
 * errors (it returns "unknown", which is simply not green, so the poll retries).
 */
export async function waitForQuantization(
  target: QuantizationMigrationTarget,
  name: string,
  options: WaitForQuantizationOptions,
): Promise<QuantizationMigrationResult> {
  const sleep = options.sleep ?? (async (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let poll = 0; poll < options.maxPolls; poll++) {
    if ((await target.getCollectionStatus(name)) === "green") return "settled";
    await sleep(options.intervalMs);
  }
  return "background";
}

/** Stage of a TurboQuant migration surfaced to the CLI progress renderer. */
export type TurboMigrationStage = "start" | "done" | "background";

/** One progress event emitted while a collection's TurboQuant optimizer pass runs. */
export interface TurboMigrationEvent {
  collection: string;
  stage: TurboMigrationStage;
  /** Wall-clock of the migration so far — set on the terminal done/background events. */
  elapsedMs?: number;
}

/** Sink the migration poll pushes progress events to (wired to the CLI IPC channel). */
export type TurboMigrationListener = (event: TurboMigrationEvent) => void;

/**
 * Drives the TurboQuant migration progress: for each freshly-migrated collection
 * emits a "start" event, polls until its optimizer pass settles to green (or the
 * cap is hit), then emits a terminal "done"/"background" event with the elapsed
 * time. Non-blocking by construction — each per-collection poll is capped, so a
 * long optimizer pass yields "background" and the caller proceeds to indexing.
 */
export async function reportTurboMigration(
  target: QuantizationMigrationTarget,
  migrated: string[],
  listener: TurboMigrationListener,
  options: WaitForQuantizationOptions,
  now: () => number = Date.now,
): Promise<void> {
  for (const collection of migrated) {
    const startedAt = now();
    listener({ collection, stage: "start" });
    const result = await waitForQuantization(target, collection, options);
    listener({ collection, stage: result === "settled" ? "done" : "background", elapsedMs: now() - startedAt });
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
