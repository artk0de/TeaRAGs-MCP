import { backfillRelativePathExact } from "../../../../adapters/qdrant/relative-path-exact-backfill.js";
import {
  RELATIVE_PATH_EXACT_KEY,
  RELATIVE_PATH_EXACT_SCHEMA_VERSION,
} from "../../../../contracts/relative-path-exact.js";
import type { IndexStore, Migration, StepResult } from "../types.js";

type V20Store = IndexStore & Required<Pick<IndexStore, "scrollPayloadPages" | "batchSetPayload">>;

/**
 * Give every existing point the keyword-indexed twin of `relativePath` (bd
 * tea-rags-mcp-ejio7; contract `contracts/relative-path-exact.ts`), then index
 * it.
 *
 * Path-membership consumers switch to one keyword MatchAny only once the
 * collection is stamped at this version (the gate,
 * `adapters/qdrant/relative-path-exact-capability.ts`), and the pipeline stamps
 * only after `apply()` returned — so the stamp is the claim "every point that
 * has a path carries the twin". The stamp is a waited upsert, and Qdrant
 * applies updates in submission order, so it also lands after every queued
 * `set_payload` below is visible.
 *
 * The backfill itself — the missing-twin filter, paging, grouping by path,
 * idempotence, skipping points without a path — is
 * `adapters/qdrant/relative-path-exact-backfill.ts#backfillRelativePathExact`,
 * which the capability gate also runs to heal points a build older than the
 * twin wrote after this migration stamped the collection.
 *
 * Backfill first, index second: the index is built once over the backfilled
 * values rather than updated per write. The order is not load-bearing for
 * correctness — the gate reads the stamp, not the index.
 */
export class SchemaV20RelativePathExactKeyword implements Migration {
  readonly name = "schema-v20-relative-path-exact-keyword";
  readonly version = RELATIVE_PATH_EXACT_SCHEMA_VERSION;

  constructor(
    private readonly collection: string,
    private readonly store: V20Store,
  ) {}

  async apply(): Promise<StepResult> {
    const backfilled = await backfillRelativePathExact(this.store, this.collection);

    await this.store.ensureIndex(this.collection, RELATIVE_PATH_EXACT_KEY, "keyword");
    return {
      applied: [`${RELATIVE_PATH_EXACT_KEY} backfilled on ${backfilled} points`, `${RELATIVE_PATH_EXACT_KEY}:keyword`],
    };
  }
}
