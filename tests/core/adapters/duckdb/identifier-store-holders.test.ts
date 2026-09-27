/**
 * bd tea-rags-mcp-bjfa0 — a naming convention is held by several OWNERS, not by
 * several rows of one: taxdome's `existing` (3 locals) all sit in one method,
 * `FindOrCreate#create_or_merge_on_race!`, and demanded `tax_preparation` be
 * renamed. The aggregates count each group's distinct owners on request.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { IdentifierRow } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function local(ownerSymbolId: string, name: string, line: number, extra: Partial<IdentifierRow> = {}): IdentifierRow {
  return { ownerSymbolId, kind: "local", name, line, typeName: "TaxPreparation", typeSource: "binding", ...extra };
}

describe("DuckDbGraphClient — distinct holders behind an identifier aggregate", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-identifier-holders-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.replaceIdentifiersBulk([
      {
        relPath: "app/services/find_or_create.rb",
        rows: [
          local("FindOrCreate#merge", "existing", 3, { boundMember: "find_by", boundReceiver: "TaxPreparation" }),
          local("FindOrCreate#merge", "existing", 7, { boundMember: "find_by", boundReceiver: "TaxPreparation" }),
          local("FindOrCreate#merge", "existing", 9, { boundMember: "find_by", boundReceiver: "TaxPreparation" }),
        ],
      },
      {
        relPath: "app/services/sync.rb",
        rows: [
          local("Sync#a", "tax_preparation", 2, { boundMember: "find_by", boundReceiver: "TaxPreparation" }),
          local("Sync#b", "tax_preparation", 2, { boundMember: "find_by", boundReceiver: "TaxPreparation" }),
        ],
      },
    ]);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("the type aggregate counts each group's distinct owners with countHolders", async () => {
    const rows = await db.aggregateIdentifiersByType({ types: ["TaxPreparation"], countHolders: true });
    expect(Object.fromEntries(rows.map((r) => [r.name, [r.n, r.holders]]))).toEqual({
      existing: [3, 1],
      tax_preparation: [2, 2],
    });
  });

  it("the callee aggregate counts them too", async () => {
    const rows = await db.aggregateIdentifiersByCallee({
      callees: [{ member: "find_by", receiver: "TaxPreparation" }],
      countHolders: true,
    });
    expect(Object.fromEntries(rows.map((r) => [r.name, [r.n, r.holders]]))).toEqual({
      existing: [3, 1],
      tax_preparation: [2, 2],
    });
  });

  it("the name aggregate counts them too", async () => {
    const rows = await db.aggregateIdentifiersByName({ names: ["existing", "tax_preparation"], countHolders: true });
    expect(Object.fromEntries(rows.map((r) => [r.name, [r.n, r.holders]]))).toEqual({
      existing: [3, 1],
      tax_preparation: [2, 2],
    });
  });

  it("without countHolders no row carries holders", async () => {
    const byType = await db.aggregateIdentifiersByType({ types: ["TaxPreparation"] });
    const byCallee = await db.aggregateIdentifiersByCallee({ callees: [{ member: "find_by" }] });
    const byName = await db.aggregateIdentifiersByName({ names: ["existing"] });
    expect([...byType, ...byCallee, ...byName].every((r) => !("holders" in r))).toBe(true);
  });
});
