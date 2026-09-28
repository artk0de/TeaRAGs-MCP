/**
 * Codegraph payload key vocabulary — the single spelling of the
 * `codegraph.symbols` namespace on a stored point.
 *
 * Two domains that may not import each other address the same payload by
 * these strings: the codegraph trajectory emits the keys (`codegraphFilters`,
 * the provider `key`, preset `requires`), and the migration domain indexes
 * the same paths (`schema-v15-codegraph-filter-indexes`). Before this module
 * each side maintained its own copy — the trajectory built the prefix by hand
 * in `filters.ts`, and the full list is mirrored in the adapter layer because
 * neither adapters nor migrations may import the domain descriptors — so a
 * spelling change on one side broke the other at runtime, never at compile
 * time: a renamed leaf makes every codegraph filter match nothing, and an
 * index no filter addresses is dead weight. Contracts is the only layer both
 * sides may import (same reason as `STATS_ACCUMULATOR_KEYS`).
 *
 * The adapter's `CODEGRAPH_FILTER_INDEXES`
 * (`src/core/adapters/qdrant/schema-manager.ts`) stays a literal mirror for
 * `initializeSchema` — adapters may not import a domain either — and is kept
 * byte-identical to {@link CODEGRAPH_SYMBOLS_FILTER_INDEXES} by
 * `tests/core/adapters/qdrant/codegraph-filter-index-parity.test.ts` and
 * `tests/core/adapters/qdrant/schema-manager-migrations-parity.test.ts`.
 *
 * The values are frozen: they name fields already persisted on every indexed
 * collection, so changing one is a payload migration, not an edit here.
 */

import type { FilterLevel } from "./types/provider.js";

/** Provider / trajectory key of the codegraph symbols enrichment. */
export const CODEGRAPH_SYMBOLS_PROVIDER_KEY = "codegraph.symbols";

/** The addressable Qdrant path of one codegraph payload leaf (`fanIn`, `isHub`, …). */
export function codegraphSymbolsPayloadKey(level: FilterLevel, suffix: string): string {
  return `${CODEGRAPH_SYMBOLS_PROVIDER_KEY}.${level}.${suffix}`;
}

/** Qdrant payload field-schema type an index accepts (the adapter's `IndexSchema`). */
type PayloadIndexSchema = "keyword" | "integer" | "float" | "bool" | "datetime";

/**
 * Every codegraph payload path a typed filter or filter preset can address,
 * with the index schema that makes the condition's own comparison usable — a
 * `range` filter on a path indexed as `keyword` is not served by that index.
 *
 * Paths are built, never spelled, so the namespace exists once. Order is
 * load-bearing: `schema-v15-codegraph-filter-indexes` reports `applied` in
 * this order and its test compares against the adapter mirror verbatim.
 */
export const CODEGRAPH_SYMBOLS_FILTER_INDEXES: readonly {
  readonly path: string;
  readonly schema: PayloadIndexSchema;
}[] = [
  { path: codegraphSymbolsPayloadKey("file", "fanIn"), schema: "integer" },
  { path: codegraphSymbolsPayloadKey("file", "fanOut"), schema: "integer" },
  { path: codegraphSymbolsPayloadKey("file", "connectionCount"), schema: "integer" },
  { path: codegraphSymbolsPayloadKey("file", "transitiveImpact"), schema: "integer" },
  { path: codegraphSymbolsPayloadKey("file", "instability"), schema: "float" },
  { path: codegraphSymbolsPayloadKey("file", "isHub"), schema: "bool" },
  { path: codegraphSymbolsPayloadKey("file", "isLeaf"), schema: "bool" },
  { path: codegraphSymbolsPayloadKey("chunk", "fanIn"), schema: "integer" },
  { path: codegraphSymbolsPayloadKey("chunk", "fanOut"), schema: "integer" },
  { path: codegraphSymbolsPayloadKey("chunk", "pageRank"), schema: "float" },
];
