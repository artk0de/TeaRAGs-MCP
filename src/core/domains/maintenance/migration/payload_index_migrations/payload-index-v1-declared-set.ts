import type { PayloadFieldIndex } from "../../../../adapters/qdrant/payload-index.js";
import type { PayloadFieldIndexSchema } from "../../../../adapters/qdrant/schema-manager.js";
import type { Migration, PayloadIndexStore, StepResult } from "../types.js";

/**
 * The payload index set a build declares, in the two strengths the reconcile
 * distinguishes. Built by the api composition root (this domain may not import
 * trajectories or the explore domain).
 *
 *  - `required` — must exist on every collection, with the schema to create it
 *    with: the schema pipeline's own indexes plus every field rank_chunks can
 *    order by.
 *  - `known` — may exist: every key the full trajectory registry declares. An
 *    index outside `required ∪ known` is undeclared.
 */
export interface DeclaredPayloadIndexSet {
  required: ReadonlyMap<string, PayloadFieldIndexSchema>;
  known: ReadonlySet<string>;
}

/** What the collection's inventory lacks, and what it carries beyond the declaration. */
export interface PayloadIndexReconcilePlan {
  missing: { field: string; schema: PayloadFieldIndexSchema }[];
  undeclared: PayloadFieldIndex[];
}

function byField(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Compare an inventory against the declaration. Presence is by FIELD: an index
 * created with another data type (the legacy `integer` indexes of the pre-q34ic
 * name heuristic) serves the filter, and recreating it would rebuild an index
 * over every stored point for nothing.
 */
export function planPayloadIndexReconcile(
  inventory: readonly PayloadFieldIndex[],
  declared: DeclaredPayloadIndexSet,
): PayloadIndexReconcilePlan {
  const present = new Set(inventory.map((index) => index.field));
  const missing = [...declared.required]
    .filter(([field]) => !present.has(field))
    .map(([field, schema]) => ({ field, schema }))
    .sort((a, b) => byField(a.field, b.field));
  const undeclared = inventory
    .filter((index) => !declared.required.has(index.field) && !declared.known.has(index.field))
    .sort((a, b) => byField(a.field, b.field));
  return { missing, undeclared };
}

/**
 * Create every required payload index the collection lacks; name — never drop —
 * every index nothing declares (bd tea-rags-mcp-mimq0).
 *
 * Why the set drifted: outside the schema pipeline's mirrored lists, a payload
 * signal's index existed only as a side effect of `ScrollRankStrategy`'s
 * `ensureIndexFn`, which rank_chunks runs for the fields one query orders by.
 * A collection's index set was therefore its rank_chunks history since its
 * last physical rebuild — `--force` starts a new `_vN` with none of them — and
 * a filter on such a field (a raw `methodLines` range, a filter preset over
 * `git.chunk.churnRatio`) never creates one, so it scans the payload of every
 * candidate: 3.3–3.7 s per query on taxdome against ~1 ms indexed.
 *
 * Why never drop: dropping is a schema migration's decision
 * (`schema-v16-drop-undeclared-payload-indexes` is the one-shot precedent, and
 * its docblock says why a per-run drop is unsafe — an older install would drop
 * what a newer build declared). Creating is monotone, so it may run every run.
 */
export class PayloadIndexV1DeclaredSet implements Migration {
  readonly name = "payload-index-v1-declared-set";
  readonly version = 1;

  constructor(
    private readonly collection: string,
    private readonly store: PayloadIndexStore,
    private readonly declared: DeclaredPayloadIndexSet,
  ) {}

  async apply(): Promise<StepResult> {
    const physical = await this.store.resolvePhysicalCollection(this.collection);
    const plan = planPayloadIndexReconcile(await this.store.listPayloadIndexes(physical), this.declared);

    const applied: string[] = [];
    for (const { field, schema } of plan.missing) {
      await this.store.createPayloadIndex(physical, field, schema);
      applied.push(`created ${field}:${schema} on ${physical}`);
    }
    for (const index of plan.undeclared) {
      applied.push(`undeclared ${index.field}:${index.dataType} (${index.points} points) on ${physical} — kept`);
    }

    // Ungated: the pipeline's migration log is DEBUG-only, and a change to — or
    // a finding about — the user's collection schema should be visible without it.
    if (plan.missing.length > 0) {
      console.error(
        `[migration] ${this.name}: created ${plan.missing.length} missing payload index(es) on ${physical}: ${plan.missing
          .map(({ field }) => field)
          .join(", ")}`,
      );
    }
    if (plan.undeclared.length > 0) {
      console.error(
        `[migration] ${this.name}: kept ${plan.undeclared.length} payload index(es) on ${physical} that this build does not declare — a removed signal's index is dropped by a schema migration: ${plan.undeclared
          .map(({ field }) => field)
          .join(", ")}`,
      );
    }
    return { applied };
  }
}
