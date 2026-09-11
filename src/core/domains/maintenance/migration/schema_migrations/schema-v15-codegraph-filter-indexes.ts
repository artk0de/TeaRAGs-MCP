import { CODEGRAPH_FILTER_INDEXES } from "../../../../adapters/qdrant/schema-manager.js";
import type { IndexStore, Migration, StepResult } from "../types.js";

/**
 * Index the nested codegraph payload paths the typed filter params
 * (`minFanIn`, `isHub`, `maxInstability`, …) resolve to, on collections that
 * already exist.
 *
 * `initializeSchema` has created these since `078778abf`, but only for NEW
 * collections — every collection indexed before that commit carries none of
 * them, and no migration ever added them. Unindexed, a codegraph filter does
 * not fail: Qdrant falls back to reading the payload of every candidate point,
 * so the filter silently costs a full scan.
 *
 * The list is mirrored in the adapter layer for the reason documented on
 * {@link CODEGRAPH_FILTER_INDEXES} — the paths must stay byte-identical to the
 * keys `codegraphFilters` emits.
 *
 * It also ensures `parentSymbolId`, which has the same hole from the other
 * side: `schema-v11` creates that text index, and a collection created after
 * v11 landed is stamped past it, so v11 never re-runs and the index is missing
 * on exactly the collections v11 cannot reach. `domains/explore/strategies/
 * symbol.ts` filters on the field, so unindexed it is another silent full scan.
 * The class keeps its codegraph name because renaming it would ripple through
 * the barrel, the migrator and the test file for no behavioural gain.
 */
export class SchemaV15CodegraphFilterIndexes implements Migration {
  readonly name = "schema-v15-codegraph-filter-indexes";
  readonly version = 15;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
  ) {}

  async apply(): Promise<StepResult> {
    const applied: string[] = [];
    for (const { path, schema } of CODEGRAPH_FILTER_INDEXES) {
      await this.store.ensureIndex(this.collection, path, schema);
      applied.push(`${path}:${schema}`);
    }

    // Idempotent by construction: the adapter's ensurePayloadIndex checks
    // hasPayloadIndex first, so a collection that already ran v11 pays a lookup
    // and nothing else.
    await this.store.ensureIndex(this.collection, "parentSymbolId", "text");
    applied.push("parentSymbolId:text");

    return { applied };
  }
}
