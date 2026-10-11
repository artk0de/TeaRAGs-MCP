import {
  backfillRelativePathExact,
  ensureRelativePathExactIndexComplete,
  probeRelativePathExactPresence,
} from "../../../../adapters/qdrant/relative-path-exact-backfill.js";
import {
  RELATIVE_PATH_EXACT_KEY,
  RELATIVE_PATH_EXACT_SCHEMA_VERSION,
} from "../../../../contracts/relative-path-exact.js";
import type { IndexStore, Migration, StepResult } from "../types.js";

type V20Store = IndexStore &
  Required<
    Pick<
      IndexStore,
      "scrollPayloadPages" | "batchSetPayload" | "listPayloadIndexes" | "createPayloadIndex" | "countPoints"
    >
  >;

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
 * The index is then checked for completeness and re-created once when short
 * (`ensureRelativePathExactIndexComplete`): an index created while the
 * optimizer rebuilds segments can miss some of them, and `ensureIndex` skips an
 * index that merely exists. A still-short index does not fail the migration;
 * the gate re-checks it before it serves and answers no until it is complete.
 * Completeness is judged against the LIVE count of points carrying the twin
 * (a presence count taken before the backfill, plus the points it wrote), not
 * against `relativePath`'s `payload_schema` points, which dead versions inflate.
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
    const { withBoth } = await probeRelativePathExactPresence(this.store, this.collection);
    const { backfilled, unconfirmedWrites } = await backfillRelativePathExact(this.store, this.collection);

    await this.store.ensureIndex(this.collection, RELATIVE_PATH_EXACT_KEY, "keyword");
    const complete = await ensureRelativePathExactIndexComplete(
      {
        listPayloadIndexes: async (collection) => this.store.listPayloadIndexes(collection),
        recreateKeywordIndex: async (collection, field) => this.store.createPayloadIndex(collection, field, "keyword"),
      },
      this.collection,
      withBoth + backfilled,
    );
    return {
      applied: [
        `${RELATIVE_PATH_EXACT_KEY} backfilled on ${backfilled} points${unconfirmedWrites > 0 ? ` (${unconfirmedWrites} writes unconfirmed by Qdrant; the gate heals the rest on first use)` : ""}`,
        `${RELATIVE_PATH_EXACT_KEY}:keyword${complete ? "" : " (index still incomplete after re-create)"}`,
      ],
    };
  }
}
