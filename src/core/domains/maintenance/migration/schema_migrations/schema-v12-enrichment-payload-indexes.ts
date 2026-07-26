import type { IndexStore, Migration, StepResult } from "../types.js";

/**
 * Add payload indexes on enrichment `enrichedAt` fields so `is_empty`
 * filters used by EnrichmentRecovery.countUnenriched remain fast even
 * when Qdrant is in yellow (background optimization) state.
 *
 * Fields are hardcoded to current providers at the time this migration
 * was authored. Additional providers ship their own follow-up
 * migrations — see docs/superpowers/specs/2026-04-23-qdrant-yellow-handling-design.md.
 */
export class SchemaV12EnrichmentPayloadIndexes implements Migration {
  readonly name = "schema-v12-enrichment-payload-indexes";
  readonly version = 12;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
  ) {}

  async apply(): Promise<StepResult> {
    await this.store.ensureIndex(this.collection, "git.file.enrichedAt", "datetime");
    await this.store.ensureIndex(this.collection, "git.chunk.enrichedAt", "datetime");
    return {
      applied: ["git.file.enrichedAt:datetime", "git.chunk.enrichedAt:datetime"],
    };
  }
}
