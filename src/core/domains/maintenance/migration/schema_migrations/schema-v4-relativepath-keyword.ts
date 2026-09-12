import type { IndexStore, Migration, StepResult } from "../types.js";

/**
 * Version 4 held a keyword index on `relativePath`. It creates nothing now
 * (bd tea-rags-mcp-ivp12).
 *
 * Qdrant keeps ONE index per payload key, and v5 — the very next step of the
 * same run — gives `relativePath` a `text` index, which REPLACES this one. The
 * keyword index therefore never survived a migration to current schema on any
 * collection; building it was work thrown away, and its existence in the code
 * was read as "`match.value` on `relativePath` is served", which it is not.
 * Exact matching rides the text index as a text+value pair
 * (`adapters/qdrant/filters/text-indexed-exact.ts`).
 *
 * The version slot stays so the schema numbering and every stamped
 * `schemaVersion` keep their meaning; only the dead write is gone. It is kept
 * in lockstep with `SchemaManager.initializeSchema`, which stopped creating the
 * same index — `schema-manager-migrations-parity.test.ts` fails if the two ever
 * disagree about which indexes a collection ends up with.
 */
export class SchemaV4RelativePathKeyword implements Migration {
  readonly name = "schema-v4-relativepath-keyword";
  readonly version = 4;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
  ) {}

  async apply(): Promise<StepResult> {
    return Promise.resolve({ applied: [] });
  }
}
