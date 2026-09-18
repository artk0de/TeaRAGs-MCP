import { LAST_COMMIT_TIME_FILTER_INDEXES } from "../../../../adapters/qdrant/schema-manager.js";
import type { IndexStore, Migration, StepResult } from "../types.js";

/**
 * Index the last-commit timestamps (`git.{file,chunk}.lastModifiedAt`) the git
 * time filters range over, on collections that already exist.
 *
 * Since 9mwny the age filters compile to a `lastModifiedAt` range computed from
 * query-time now instead of the enrichment-time `ageDays` stamp, and nothing
 * indexed the new key — while the old one (`git.chunk.ageDays`) usually carried
 * the integer index rank_chunks creates lazily. Unindexed, the filter does not
 * fail: it silently becomes a full payload scan (costs measured on
 * {@link LAST_COMMIT_TIME_FILTER_INDEXES}).
 *
 * Idempotent and resumable: `ensureIndex` checks for an existing index first,
 * and the pipeline stamps v17 only after both indexes exist, so a run that
 * fails between them re-runs in full and creates only what is missing. A
 * failure propagates as the adapter's typed Qdrant error; `Migrator` wraps it in
 * `MigrationStepError` naming this step.
 */
export class SchemaV17LastCommitTimeIndexes implements Migration {
  readonly name = "schema-v17-last-commit-time-indexes";
  readonly version = 17;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
  ) {}

  async apply(): Promise<StepResult> {
    const applied: string[] = [];
    for (const { path, schema } of LAST_COMMIT_TIME_FILTER_INDEXES) {
      await this.store.ensureIndex(this.collection, path, schema);
      applied.push(`${path}:${schema}`);
    }
    return { applied };
  }
}
