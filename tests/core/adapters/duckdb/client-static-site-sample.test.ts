import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type { StaticSiteSampleRow } from "../../../../src/core/contracts/types/codegraph-residual.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

function row(siteKey: string, over: Partial<StaticSiteSampleRow> = {}): StaticSiteSampleRow {
  return {
    siteKey,
    sourceRelPath: "a.rb",
    language: "ruby",
    methodSymbolId: "Billing#run",
    methodStartLine: 10,
    methodEndLine: 20,
    line: 12,
    column: 6,
    receiverText: "account",
    receiverKind: "localVar",
    member: "users",
    outcome: "resolved",
    targetSymbolId: "Firm#users",
    reason: null,
    owners: 2,
    candidates: ["Firm#users", "Team#users"],
    menuOverflow: false,
    priority: 0.125,
    ...over,
  };
}

describe("DuckDbGraphClient — static site sample persistence", () => {
  let tmp: string;
  let client: DuckDbGraphClient;

  const readRows = async (): Promise<Record<string, unknown>[]> =>
    client.queryAll("SELECT * FROM cg_static_site_sample ORDER BY source_rel_path, site_key");

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-static-sample-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("upsertFile persists the sample with every column", async () => {
    await client.upsertFile(
      { relPath: "a.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], staticSiteSample: [row("k1")] },
    );

    expect(await readRows()).toEqual([
      {
        source_rel_path: "a.rb",
        site_key: "k1",
        language: "ruby",
        method_symbol_id: "Billing#run",
        method_start_line: 10,
        method_end_line: 20,
        line: 12,
        call_column: 6,
        receiver_text: "account",
        receiver_kind: "localVar",
        member: "users",
        outcome: "resolved",
        target_symbol_id: "Firm#users",
        reason: null,
        owners: 2,
        candidates: JSON.stringify(["Firm#users", "Team#users"]),
        menu_overflow: false,
        priority: 0.125,
      },
    ]);
  });

  it("a re-walk without the field clears the file's sample and keeps other files'", async () => {
    await client.upsertFile(
      { relPath: "a.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], staticSiteSample: [row("k1")] },
    );
    await client.upsertFile(
      { relPath: "b.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], staticSiteSample: [row("k2", { sourceRelPath: "b.rb" })] },
    );

    await client.upsertFile({ relPath: "a.rb", language: "ruby" }, { fileEdges: [], methodEdges: [] });

    expect((await readRows()).map((r) => r.site_key)).toEqual(["k2"]);
  });

  it("removeFile drops the file's sample", async () => {
    await client.upsertFile(
      { relPath: "a.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], staticSiteSample: [row("k1")] },
    );

    await client.removeFile("a.rb");

    expect(await readRows()).toEqual([]);
  });
});
