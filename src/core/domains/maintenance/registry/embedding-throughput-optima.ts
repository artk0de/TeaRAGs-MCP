/**
 * The registry-level embedding throughput optima section (bd tea-rags-mcp-auoxk).
 *
 * How fast an embedding configuration — provider + endpoint set + model — runs
 * at a given batch shape is a fact about the configuration, not about the
 * project that measured it: a small project can never close the concurrency
 * window a big one measures on the same endpoints. So the optima live in ONE
 * section of `registry.json`, every project seeds from it and writes to it.
 *
 * Two pure rules live here, both applied by `mergeRegistryDelta` inside the
 * cross-process CAS loop, so they always see the CURRENT disk value:
 *
 *  - `liftEmbeddingThroughputOptima` — the read-side migration of the per-entry
 *    records earlier builds wrote (`CollectionEntry.embeddingThroughputOptima`).
 *  - `applyEmbeddingThroughputOptimumWrites` — a run's writes, reconciled
 *    against the record on disk.
 */

import type {
  CollectionEntry,
  EmbeddingThroughputOptimum,
  EmbeddingThroughputOptimumWrite,
} from "../../../contracts/types/registry.js";

export type EmbeddingThroughputOptimaSection = Record<string, EmbeddingThroughputOptimum>;

/**
 * A key of the pre-y1ynz `url|model` form: it starts with the endpoint URL
 * itself, where every current key starts with the provider name — and a
 * provider name never contains `://`. Nothing has read such a key since y1ynz
 * keyed optima by provider (bd tea-rags-mcp-cyw2r), so it is never lifted.
 */
const LEGACY_EMBEDDING_THROUGHPUT_OPTIMUM_KEY = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Which of two per-entry records of the same identity the lift keeps: an
 * aggregate measurement over a per-batch (or pre-cyw2r) one — their rates are
 * not comparable — then the higher chars/s, then the newer settle.
 */
function preferredLiftedOptimum(
  a: EmbeddingThroughputOptimum,
  b: EmbeddingThroughputOptimum,
): EmbeddingThroughputOptimum {
  const aAggregate = a.measurement === "aggregate";
  if (aAggregate !== (b.measurement === "aggregate")) return aAggregate ? a : b;
  if (a.charsPerSecond !== b.charsPerSecond) return a.charsPerSecond > b.charsPerSecond ? a : b;
  return b.settledAt > a.settledAt ? b : a;
}

/**
 * The section with every identity it lacks lifted from the per-entry records
 * of earlier builds. A key the section already holds is never touched — once
 * lifted, per-entry records are not read again. Pure and idempotent: lifting a
 * lifted section changes nothing.
 */
export function liftEmbeddingThroughputOptima(
  section: EmbeddingThroughputOptimaSection | undefined,
  collections: Readonly<Record<string, CollectionEntry>>,
): EmbeddingThroughputOptimaSection {
  const out: EmbeddingThroughputOptimaSection = { ...section };
  const lifted: EmbeddingThroughputOptimaSection = {};
  for (const entry of Object.values(collections)) {
    for (const [key, optimum] of Object.entries(entry.embeddingThroughputOptima ?? {})) {
      if (Object.hasOwn(out, key) || LEGACY_EMBEDDING_THROUGHPUT_OPTIMUM_KEY.test(key)) continue;
      const held = lifted[key];
      lifted[key] = held === undefined ? optimum : preferredLiftedOptimum(held, optimum);
    }
  }
  return { ...out, ...lifted };
}

/**
 * Whether a run's write replaces the record currently on disk.
 *
 * The run's tuner already applied the cyw2r merge rule against the record it
 * was SEEDED with (`storedOptimum`). When that is still the record on disk, its
 * verdict stands — including the case where the run re-measured the stored
 * point and found the server slower. When another process wrote the identity
 * in the meantime, the run's evidence says nothing about that newer record, so
 * only a comparable, at-least-as-fast measurement replaces it: an aggregate
 * write wins over a per-batch record or a slower aggregate one, and a per-batch
 * write — persisted only where nothing was stored — never displaces a record.
 */
function writeSupersedes(
  current: EmbeddingThroughputOptimum | undefined,
  write: EmbeddingThroughputOptimumWrite,
): boolean {
  if (current === undefined) return true;
  if (isSameOptimum(current, write.storedOptimum)) return true;
  if (write.optimum.measurement !== "aggregate") return false;
  if (current.measurement !== "aggregate") return true;
  return write.optimum.charsPerSecond >= current.charsPerSecond;
}

/** Field-wise: JSON drops an undefined `measurement`, which a structural deep-equal would mis-compare. */
function isSameOptimum(a: EmbeddingThroughputOptimum, b: EmbeddingThroughputOptimum | undefined): boolean {
  if (b === undefined) return false;
  return (
    a.batchSize === b.batchSize &&
    a.concurrency === b.concurrency &&
    a.charsPerSecond === b.charsPerSecond &&
    a.settledAt === b.settledAt &&
    a.measurement === b.measurement
  );
}

/** The section with a run's writes applied per key; every other key is kept. */
export function applyEmbeddingThroughputOptimumWrites(
  section: EmbeddingThroughputOptimaSection,
  writes: readonly EmbeddingThroughputOptimumWrite[],
): EmbeddingThroughputOptimaSection {
  const out: EmbeddingThroughputOptimaSection = { ...section };
  for (const write of writes) {
    if (writeSupersedes(out[write.key], write)) out[write.key] = write.optimum;
  }
  return out;
}
