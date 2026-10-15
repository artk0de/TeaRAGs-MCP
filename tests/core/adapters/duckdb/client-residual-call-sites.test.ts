import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { ResidualCallSiteRow } from "../../../../src/core/contracts/types/codegraph-residual.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function site(sourceRelPath: string, siteKey: string, over: Partial<ResidualCallSiteRow> = {}): ResidualCallSiteRow {
  return {
    siteKey,
    sourceRelPath,
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
    ...over,
  };
}

describe("DuckDbGraphClient — residual call-site persistence", () => {
  let tmp: string;
  let client: DuckDbGraphClient;

  interface Row {
    source_rel_path: string;
    site_key: string;
    method_symbol_id: string;
    method_start_line: number;
    method_end_line: number;
    line: number;
    call_column: number;
    receiver_text: string;
    member: string;
    kind: string;
    candidates: string;
    menu_hash: string;
    menu_overflow: boolean;
  }

  const readRows = async (): Promise<Row[]> =>
    client.queryAll<Row>("SELECT * FROM cg_residual_call_sites ORDER BY source_rel_path, site_key");

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-cli-residual-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("upsertFile persists residual rows with every column and JSON candidates", async () => {
    await client.upsertFile(
      { relPath: "a.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], residualCallSites: [site("a.rb", "k1", { menuOverflow: true })] },
    );

    const rows = await readRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      source_rel_path: "a.rb",
      site_key: "k1",
      method_symbol_id: "Billing#run",
      method_start_line: 10,
      method_end_line: 20,
      line: 12,
      call_column: 6,
      receiver_text: "account",
      member: "users",
      kind: "dynamic",
      menu_hash: "menu-1",
      menu_overflow: true,
    });
    expect(JSON.parse(rows[0].candidates)).toEqual(["Firm#users", "Team#users"]);
  });

  it("re-upserting a file replaces its slice", async () => {
    const node = { relPath: "a.rb", language: "ruby" };
    await client.upsertFile(node, {
      fileEdges: [],
      methodEdges: [],
      residualCallSites: [site("a.rb", "k1"), site("a.rb", "k2")],
    });
    await client.upsertFile(node, { fileEdges: [], methodEdges: [], residualCallSites: [site("a.rb", "k2")] });

    expect((await readRows()).map((r) => r.site_key)).toEqual(["k2"]);
  });

  it("an absent field clears the file's slice and leaves other files alone", async () => {
    await client.upsertFile(
      { relPath: "a.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], residualCallSites: [site("a.rb", "k1")] },
    );
    await client.upsertFile(
      { relPath: "b.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], residualCallSites: [site("b.rb", "k1")] },
    );
    await client.upsertFile({ relPath: "a.rb", language: "ruby" }, { fileEdges: [], methodEdges: [] });

    expect((await readRows()).map((r) => r.source_rel_path)).toEqual(["b.rb"]);
  });

  it("upsertFilesBulk persists slices per file and removeFiles retires them", async () => {
    await client.upsertFilesBulk([
      {
        node: { relPath: "a.rb", language: "ruby" },
        edges: { fileEdges: [], methodEdges: [], residualCallSites: [site("a.rb", "k1")] },
      },
      {
        node: { relPath: "b.rb", language: "ruby" },
        edges: { fileEdges: [], methodEdges: [], residualCallSites: [site("b.rb", "k1")] },
      },
    ]);
    expect(await readRows()).toHaveLength(2);

    await client.removeFiles(["a.rb"]);
    expect((await readRows()).map((r) => r.source_rel_path)).toEqual(["b.rb"]);
  });
});
