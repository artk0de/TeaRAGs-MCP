/**
 * `cg_identifiers.type_multiplicity` on the write path (bd tea-rags-mcp-4p3sb.26):
 * the row's multiplicity is persisted, an absent one is written as `one`, and a
 * change of multiplicity alone is a change the per-file diff rewrites.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { IdentifierRow } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function row(partial: Partial<IdentifierRow> & Pick<IdentifierRow, "name">): IdentifierRow {
  return { ownerSymbolId: "Svc#pick", kind: "param", line: 1, typeName: "Doc", typeSource: "annotation", ...partial };
}

describe("DuckDbGraphClient — cg_identifiers type multiplicity", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-identifiers-mult-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function multiplicities(): Promise<{ name: string; type_multiplicity: string }[]> {
    return db.queryAll("SELECT name, type_multiplicity FROM cg_identifiers ORDER BY name");
  }

  it("persists many, and writes one for a row that carries none", async () => {
    await db.replaceIdentifiersBulk([
      {
        relPath: "a.ts",
        rows: [row({ name: "candidates", typeMultiplicity: "many" }), row({ name: "fallback" })],
      },
    ]);
    expect(await multiplicities()).toEqual([
      { name: "candidates", type_multiplicity: "many" },
      { name: "fallback", type_multiplicity: "one" },
    ]);
  });

  it("rewrites a file whose rows changed in multiplicity alone", async () => {
    await db.replaceIdentifiersBulk([{ relPath: "a.ts", rows: [row({ name: "defs" })] }]);
    await db.replaceIdentifiersBulk([{ relPath: "a.ts", rows: [row({ name: "defs", typeMultiplicity: "many" })] }]);
    expect(await multiplicities()).toEqual([{ name: "defs", type_multiplicity: "many" }]);
  });
});
