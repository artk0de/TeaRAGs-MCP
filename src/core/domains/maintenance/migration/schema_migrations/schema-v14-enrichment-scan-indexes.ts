import { ENRICHMENT_SCAN_INDEXES } from "../../../../adapters/qdrant/schema-manager.js";
import type { IndexStore, Migration, StepResult } from "../types.js";

/**
 * Index every payload field the enrichment run's own scans filter on, so those
 * scans stop degrading to a full payload scan.
 *
 * Supersedes `schema-v12-enrichment-payload-indexes`, which covered two of the
 * nine fields (`git.{file,chunk}.enrichedAt`) and left the other terminal state
 * (`skippedAs`), the whole `codegraph.symbols` provider, and the `_type`
 * exclusions shared by both filters unindexed. `ensureIndex` is idempotent, so
 * re-declaring v12's pair here costs nothing on a collection that already has
 * them.
 *
 * The measured cost of NOT having them, and why the list is mirrored in the
 * adapter layer rather than derived from the providers, is documented on
 * {@link ENRICHMENT_SCAN_INDEXES}.
 */
export class SchemaV14EnrichmentScanIndexes implements Migration {
  readonly name = "schema-v14-enrichment-scan-indexes";
  readonly version = 14;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
  ) {}

  async apply(): Promise<StepResult> {
    const applied: string[] = [];
    for (const { path, schema } of ENRICHMENT_SCAN_INDEXES) {
      await this.store.ensureIndex(this.collection, path, schema);
      applied.push(`${path}:${schema}`);
    }
    return { applied };
  }
}
