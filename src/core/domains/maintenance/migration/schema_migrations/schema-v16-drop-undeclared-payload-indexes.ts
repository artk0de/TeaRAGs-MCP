import { SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS } from "../../../../adapters/qdrant/schema-manager.js";
import type { IndexStore, Migration, StepResult } from "../types.js";

type PayloadIndexReconcilingStore = IndexStore & Required<Pick<IndexStore, "listPayloadIndexes" | "dropPayloadIndex">>;

/**
 * Drop every payload field index whose key nothing in this build declares.
 *
 * Why the orphans exist: until xf01b (`49a96c00b`, shipped in 1.42.0)
 * `RankModule#resolvePayloadField` built every level-qualified order_by key as
 * `git.<source>`, so the codegraph derived signals ordered by
 * `git.file.fanIn`, `git.chunk.pageRank`, … — keys no point carries — and
 * `ScrollRankStrategy`'s `ensureIndexFn` created a payload index on each before
 * scrolling (`float`, by its name heuristic, even for the bool `isHub`). Nothing
 * ever removed them: on the self-index seven of them cost ~20 MB of disk each,
 * and every upsert kept maintaining them (bd tea-rags-mcp-q34ic).
 *
 * "Declared" is the union of two sets, never the running composition's:
 *  - {@link SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS} — the schema pipeline's own
 *    indexes, including bookkeeping keys no payload descriptor names;
 *  - `trajectoryPayloadKeys` — the physical key of every payload signal the
 *    FULL trajectory registry declares, injected by the api composition root
 *    (this domain may not import trajectories). A key a disabled trajectory
 *    owns is still declared, so a run with codegraph off drops nothing of
 *    codegraph's.
 * An index that holds no value is NOT a drop criterion — `git.file.skippedAs`
 * is empty on most collections and the recovery scan filters on it.
 *
 * Why a one-shot schema migration and not a reconcile on every index run: the
 * version gate makes only a build carrying this migration an authority over
 * which indexes may exist, and only once. A per-run reconcile would let an
 * OLDER install (the auto-updater spawns the global one, a parallel session
 * runs its own worktree) drop an index a NEWER build declared — and the newer
 * build's already-stamped migration would never re-create it, turning its
 * filter into a silent full scan.
 */
export class SchemaV16DropUndeclaredPayloadIndexes implements Migration {
  readonly name = "schema-v16-drop-undeclared-payload-indexes";
  readonly version = 16;

  private readonly declaredKeys: ReadonlySet<string>;

  constructor(
    private readonly collection: string,
    private readonly store: PayloadIndexReconcilingStore,
    trajectoryPayloadKeys: ReadonlySet<string>,
  ) {
    // An empty set is a failed build of the declared keys, not a statement that
    // nothing is declared: every trajectory-owned index would read as an orphan.
    // SchemaMigrator does not register the migration without keys; reaching this
    // is a wiring bug.
    if (trajectoryPayloadKeys.size === 0) {
      throw new Error("schema-v16 needs the declared trajectory payload keys — refusing to reconcile against none");
    }
    this.declaredKeys = new Set([...SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS, ...trajectoryPayloadKeys]);
  }

  async apply(): Promise<StepResult> {
    const undeclared = (await this.store.listPayloadIndexes(this.collection))
      .filter((index) => !this.declaredKeys.has(index.field))
      .sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : 0));

    if (undeclared.length === 0) return { applied: ["no undeclared payload indexes"] };

    const applied: string[] = [];
    for (const index of undeclared) {
      await this.store.dropPayloadIndex(this.collection, index.field);
      applied.push(`dropped ${index.field}:${index.dataType} (${index.points} points)`);
    }

    // Ungated: the pipeline's migration log is DEBUG-only, and a change to the
    // user's collection schema should be visible without it.
    console.error(
      `[migration] ${this.name}: dropped ${undeclared.length} undeclared payload index(es) on ${this.collection}: ${undeclared
        .map((index) => index.field)
        .join(", ")}`,
    );
    return { applied };
  }
}
