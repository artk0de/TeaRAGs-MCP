import { RECENT_AUTHORS_FILTER_INDEXES } from "../../../../adapters/qdrant/schema-manager.js";
import type { IndexStore, Migration, StepResult } from "../types.js";

/**
 * Index the recent-window author list (`git.file.recentAuthors`) the
 * `contributor` typed filter matches on, on collections that already exist.
 *
 * The typed param compiles to a `match.any` over that key — the complete
 * "everything X touched" answer `recentAuthor` (the dominant committer only)
 * misses (bd tea-rags-mcp-y1870). Unindexed, the filter does not fail: it
 * silently becomes a full payload scan, the same defect v17 fixed for the
 * last-commit timestamps.
 *
 * Idempotent and resumable: `ensureIndex` checks for an existing index first,
 * and the pipeline stamps v18 only after the index exists, so a run that fails
 * re-runs in full and creates only what is missing. A failure propagates as the
 * adapter's typed Qdrant error; `Migrator` wraps it in `MigrationStepError`
 * naming this step. The payload field itself is written by the git enrichment
 * that already ran — this migration only creates the index, no payload reindex
 * and no re-embedding.
 */
export class SchemaV18RecentAuthorsIndex implements Migration {
  readonly name = "schema-v18-recent-authors-index";
  readonly version = 18;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
  ) {}

  async apply(): Promise<StepResult> {
    const applied: string[] = [];
    for (const { path, schema } of RECENT_AUTHORS_FILTER_INDEXES) {
      await this.store.ensureIndex(this.collection, path, schema);
      applied.push(`${path}:${schema}`);
    }
    return { applied };
  }
}
