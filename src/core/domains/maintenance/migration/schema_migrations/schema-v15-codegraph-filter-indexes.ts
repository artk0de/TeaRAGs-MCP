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
    return { applied };
  }
}
