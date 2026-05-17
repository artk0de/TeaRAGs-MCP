/**
 * BatchDeleteExecutor — single-path delete invoker for L2 fallback.
 *
 * Owns the qdrant boundary (filter construction + `deletePointsByFilter`
 * call). Isolates DeletionRetryHelper from QdrantManager types so the
 * helper stays a pure retry+accumulation primitive.
 *
 * Per-path scope: the L2 fallback in performDeletion deletes one path at
 * a time via a payload-filtered delete (no id list available at this
 * point; chunks are addressed by `relativePath`). Plan referred to this
 * as "deleteBatch" — the batch is a single-element id list because the
 * helper's contract iterates per id.
 */

import type { QdrantManager } from "../../../adapters/qdrant/client.js";

export class BatchDeleteExecutor {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly collection: string,
  ) {}

  /**
   * Delete chunks for the supplied paths via payload-filtered delete.
   * Throws on qdrant failure — the retry helper observes the throw and
   * marks the id as failed in the DeletionOutcome.
   */
  async deleteBatch(relativePaths: string[]): Promise<void> {
    for (const relativePath of relativePaths) {
      const filter = {
        must: [{ key: "relativePath", match: { value: relativePath } }],
      };
      await this.qdrant.deletePointsByFilter(this.collection, filter);
    }
  }
}
