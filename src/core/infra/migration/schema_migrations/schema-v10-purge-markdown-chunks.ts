/**
 * Schema V10: Purge markdown chunks for re-chunking.
 *
 * Markdown chunker was upgraded (h3 splitting, breadcrumbs, oversized code block
 * fallback). Existing markdown chunks use the old strategy and must be re-indexed.
 * Deleting them from Qdrant + invalidating snapshot entries causes incremental
 * reindex to treat markdown files as "modified" → re-chunk with new strategy.
 */

import type { IndexStore, Migration, SnapshotStore, StepResult } from "../types.js";

export class SchemaV10PurgeMarkdownChunks implements Migration {
  readonly name = "schema-v10-purge-markdown-chunks";
  readonly version = 10;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
    private readonly snapshotStore?: SnapshotStore,
  ) {}

  async apply(): Promise<StepResult> {
    const applied: string[] = [];

    // 1. Delete markdown chunks from Qdrant
    await this.store.deletePointsByFilter(this.collection, {
      must: [{ key: "language", match: { value: "markdown" } }],
    });
    applied.push("deleted markdown chunks from Qdrant");

    // 2. Invalidate markdown entries in snapshot → reindex treats them as "modified"
    if (this.snapshotStore) {
      const count = await this.snapshotStore.invalidateByExtensions([".md", ".markdown"]);
      applied.push(`invalidated ${count} markdown file(s) in snapshot`);
    }

    return { applied };
  }
}
