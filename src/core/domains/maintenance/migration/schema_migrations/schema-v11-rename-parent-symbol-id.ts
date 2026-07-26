/**
 * Schema V11: Rename parentName → parentSymbolId.
 *
 * Code was renamed in Task 1, but existing indexed data still has
 * the old `parentName` field. This migration copies the value to
 * `parentSymbolId`, deletes the old key, and creates a text index.
 */

import type { IndexStore, Migration, StepResult } from "../types.js";

type V11Store = IndexStore & Required<Pick<IndexStore, "scrollAllPayload" | "batchSetPayload" | "deletePayloadKeys">>;

export class SchemaV11RenameParentSymbolId implements Migration {
  readonly name = "schema-v11-rename-parent-symbol-id";
  readonly version = 11;

  constructor(
    private readonly collection: string,
    private readonly store: V11Store,
  ) {}

  async apply(): Promise<StepResult> {
    const applied: string[] = [];

    // 1. Scroll all points
    const points = await this.store.scrollAllPayload(this.collection);

    // 2. Batch set parentSymbolId for points that have parentName
    const ops = points
      .filter((p) => typeof p.payload.parentName === "string")
      .map((p) => ({
        points: [p.id],
        payload: { parentSymbolId: p.payload.parentName as string },
      }));

    if (ops.length > 0) {
      await this.store.batchSetPayload(this.collection, ops);
      applied.push(`renamed parentName → parentSymbolId on ${ops.length} points`);
    } else {
      applied.push("no points with parentName — skip rename");
    }

    // 3. Delete old parentName field
    await this.store.deletePayloadKeys(this.collection, ["parentName"]);
    applied.push("deleted parentName field");

    // 4. Create text index on parentSymbolId
    await this.store.ensureIndex(this.collection, "parentSymbolId", "text");
    applied.push("created text index on parentSymbolId");

    return { applied };
  }
}
