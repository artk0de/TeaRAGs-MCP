import {
  PayloadIndexV1DeclaredSet,
  planPayloadIndexReconcile,
  type DeclaredPayloadIndexSet,
} from "./payload_index_migrations/index.js";
import type { Migration, MigrationRunner, PayloadIndexStore } from "./types.js";

const LATEST = 1;

/**
 * MigrationRunner reconciling a collection's payload field indexes with the set
 * this build declares (bd tea-rags-mcp-mimq0).
 *
 * The version is derived from the DATA, as `StatsMigrator` does, and never
 * stored: the declared set moves whenever a signal is added, and a collection
 * rebuilt by `--force` starts over, so no stamp could truthfully say
 * "reconciled". `LATEST` means nothing is missing and nothing is undeclared;
 * anything else re-runs the one idempotent step. The clean steady state costs
 * one alias read and one collection-info read per run.
 */
export class PayloadIndexMigrator implements MigrationRunner {
  private readonly migrations: Migration[];

  readonly latestVersion = LATEST;

  constructor(
    private readonly collection: string,
    private readonly store: PayloadIndexStore,
    private readonly declared: DeclaredPayloadIndexSet,
  ) {
    // An empty set is a failed build of the declaration, not a statement that
    // nothing is required: every index would read as undeclared.
    if (declared.required.size === 0) {
      throw new Error(
        "payload-index reconcile needs the required payload index set — refusing to reconcile against none",
      );
    }
    this.migrations = [new PayloadIndexV1DeclaredSet(collection, store, declared)];
  }

  async getVersion(): Promise<number> {
    const physical = await this.store.resolvePhysicalCollection(this.collection);
    const plan = planPayloadIndexReconcile(await this.store.listPayloadIndexes(physical), this.declared);
    return plan.missing.length === 0 && plan.undeclared.length === 0 ? LATEST : LATEST - 1;
  }

  async setVersion(_version: number): Promise<void> {
    // Version is implicit in the collection's payload_schema.
  }

  getMigrations(): Migration[] {
    return this.migrations;
  }
}
