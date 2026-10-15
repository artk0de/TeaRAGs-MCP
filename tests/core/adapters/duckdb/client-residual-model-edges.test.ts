import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { ModelEdgeRow, ResidualCallSiteRow } from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const SITE: ResidualCallSiteRow = {
  siteKey: "k1",
  sourceRelPath: "app/billing.rb",
  methodSymbolId: "Billing#run",
  methodStartLine: 10,
  methodEndLine: 20,
  line: 12,
  column: 6,
  receiverText: "account",
  member: "users",
  kind: "dynamic",
  candidates: ["Firm#users", "Team#users"],
  menuHash: "menu-1",
  menuOverflow: false,
};

const EDGE: ModelEdgeRow = {
  siteKey: "k1",
  sourceRelPath: "app/billing.rb",
  sourceSymbolId: "Billing#run",
  targetSymbolId: "Firm#users",
  model: "kev",
  p: 0.9,
};

interface EdgeRow {
  source_rel_path: string;
  call_expression: string;
  target_rel_path: string;
  target_symbol_id: string | null;
  edge_kind: string;
  origin: string | null;
  model: string | null;
  p: number | null;
  site_key: string | null;
}

describe("DuckDbGraphClient — residual ops", () => {
  let tmp: string;
  let client: DuckDbGraphClient;

  const readEdges = async (): Promise<EdgeRow[]> =>
    client.queryAll<EdgeRow>(
      `SELECT source_rel_path, call_expression, target_rel_path, target_symbol_id, edge_kind, origin, model, p, site_key
         FROM cg_symbols_edges_method ORDER BY source_rel_path, call_expression, target_symbol_id`,
    );

  const writeBilling = async (
    methodEdges: {
      targetSymbolId: string;
      targetRelPath: string;
      callExpression: string;
    }[] = [],
  ) =>
    client.upsertFile(
      { relPath: "app/billing.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: methodEdges.map((e) => ({
          sourceSymbolId: "Billing#run",
          ...e,
        })),
        residualCallSites: [SITE],
      },
    );

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-cli-model-edges-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
    await client.upsertSymbols("app/models/firm.rb", [
      {
        symbolId: "Firm#users",
        fqName: "Firm#users",
        shortName: "users",
        relPath: "app/models/firm.rb",
        scope: ["Firm"],
      },
    ]);
    await client.upsertSymbols("app/models/team.rb", [
      {
        symbolId: "Team#users",
        fqName: "Team#users",
        shortName: "users",
        relPath: "app/models/team.rb",
        scope: ["Team"],
      },
    ]);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("reads residual rows back with the menu decoded", async () => {
    await writeBilling();

    expect(await client.readResidualCallSites()).toEqual([SITE]);
  });

  it("applies a model edge with its provenance, target file and call text from the residual row", async () => {
    await writeBilling();

    await client.applyModelEdges("kev", [EDGE]);

    expect(await readEdges()).toEqual([
      {
        source_rel_path: "app/billing.rb",
        call_expression: "account.users",
        target_rel_path: "app/models/firm.rb",
        target_symbol_id: "Firm#users",
        edge_kind: "exact",
        origin: "model",
        model: "kev",
        p: 0.9,
        site_key: "k1",
      },
    ]);
  });

  it("replaces the model's edges and leaves static edges alone", async () => {
    await writeBilling([
      {
        targetSymbolId: "Team#users",
        targetRelPath: "app/models/team.rb",
        callExpression: "team.users",
      },
    ]);
    await client.applyModelEdges("kev", [EDGE]);

    await client.applyModelEdges("kev", [{ ...EDGE, targetSymbolId: "Team#users", p: 0.8 }]);

    expect((await readEdges()).map((e) => [e.call_expression, e.target_symbol_id, e.origin])).toEqual([
      ["account.users", "Team#users", "model"],
      ["team.users", "Team#users", null],
    ]);
  });

  it("skips an edge whose site is not a current residual row or whose target is unknown", async () => {
    await writeBilling();

    await client.applyModelEdges("kev", [
      { ...EDGE, siteKey: "gone" },
      { ...EDGE, targetSymbolId: "Nowhere#users" },
    ]);

    expect(await readEdges()).toEqual([]);
  });

  it("an untouched file keeps its model edges when another file is re-walked", async () => {
    await writeBilling();
    await client.applyModelEdges("kev", [EDGE]);

    await client.upsertFile({ relPath: "app/team.rb", language: "ruby" }, { fileEdges: [], methodEdges: [] });

    expect((await readEdges()).map((e) => e.origin)).toEqual(["model"]);
  });

  it("a re-walked source file loses its model edges", async () => {
    await writeBilling();
    await client.applyModelEdges("kev", [EDGE]);

    await writeBilling();

    expect(await readEdges()).toEqual([]);
  });

  it("a re-walk that proves the model's edge statically turns it back into a static edge", async () => {
    await writeBilling();
    await client.applyModelEdges("kev", [EDGE]);

    await writeBilling([
      {
        targetSymbolId: "Firm#users",
        targetRelPath: "app/models/firm.rb",
        callExpression: "account.users",
      },
    ]);
    await client.applyModelEdges("kev", []);

    expect((await readEdges()).map((e) => [e.target_symbol_id, e.origin, e.model, e.p, e.site_key])).toEqual([
      ["Firm#users", null, null, null, null],
    ]);
  });

  it("markDerivedStale marks the derived tables stale", async () => {
    expect(await client.hasStaleDerivedTables()).toBe(false);

    await client.markDerivedStale();
    await client.markDerivedStale();

    expect(await client.hasStaleDerivedTables()).toBe(true);
  });
});
