import type { Migration, StepResult, EnrichmentStore } from "../types.js";

const BATCH_SIZE = 100;

export class SchemaV9EnrichedAtBackfill implements Migration {
  readonly name = "schema-v9-enrichedat-backfill";
  readonly version = 9;

  constructor(
    private readonly collection: string,
    private readonly store: EnrichmentStore,
    private readonly providerKey: string,
  ) {}

  async apply(): Promise<StepResult> {
    if (await this.store.isMigrated(this.collection)) {
      return { applied: [] };
    }

    const points = await this.store.scrollAllChunks(this.collection);
    const now = new Date().toISOString();
    const operations: { payload: Record<string, unknown>; points: (string | number)[] }[] = [];

    for (const point of points) {
      const gitPayload = point.payload?.[this.providerKey] as Record<string, unknown> | undefined;
      const fileSignals = gitPayload?.file as Record<string, unknown> | undefined;
      const chunkSignals = gitPayload?.chunk as Record<string, unknown> | undefined;

      if (fileSignals?.commitCount !== undefined) {
        operations.push({
          payload: { [`${this.providerKey}.file.enrichedAt`]: now },
          points: [point.id],
        });
      }
      if (chunkSignals?.commitCount !== undefined) {
        operations.push({
          payload: { [`${this.providerKey}.chunk.enrichedAt`]: now },
          points: [point.id],
        });
      }
    }

    if (operations.length > 0) {
      for (let i = 0; i < operations.length; i += BATCH_SIZE) {
        await this.store.batchSetPayload(this.collection, operations.slice(i, i + BATCH_SIZE));
      }
    }

    await this.store.markMigrated(this.collection);
    return {
      applied: [`enrichedAt backfill: ${operations.length} operations for provider ${this.providerKey}`],
    };
  }
}
