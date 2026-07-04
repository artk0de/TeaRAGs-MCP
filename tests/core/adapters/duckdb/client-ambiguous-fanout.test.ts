import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/infra/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

// bd tea-rags-mcp-f2jsb / j0pki — the client persists over-cap dynamic
// fan-outs as `cg_ambiguous_fanout` aggregate rows (per-file DELETE+INSERT
// lifecycle, same as the edge tables) and carries the `ambiguous_fanout`
// run-stats bucket through recordRunStats/getRunStats.
describe("DuckDbGraphClient — ambiguous fan-out persistence (j0pki)", () => {
  let tmp: string;
  let client: DuckDbGraphClient;

  interface AmbiguousFanoutRow {
    source_symbol_id: string;
    source_rel_path: string;
    call_expression: string;
    member: string;
    candidate_count: number | bigint;
  }

  const readAmbiguousRows = async (): Promise<AmbiguousFanoutRow[]> =>
    client.queryAll<AmbiguousFanoutRow>(
      "SELECT source_symbol_id, source_rel_path, call_expression, member, candidate_count FROM cg_ambiguous_fanout ORDER BY source_symbol_id, call_expression",
    );

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-cli-ambig-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("upsertFile persists ambiguousFanouts rows keyed by the source file", async () => {
    await client.upsertFile(
      { relPath: "app/services/runner.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        ambiguousFanouts: [
          { sourceSymbolId: "Runner#go", callExpression: "x.firm", member: "firm", candidateCount: 240 },
          { sourceSymbolId: "Runner#go", callExpression: "y.user", member: "user", candidateCount: 31 },
        ],
      },
    );

    const rows = await readAmbiguousRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      source_symbol_id: "Runner#go",
      source_rel_path: "app/services/runner.rb",
      call_expression: "x.firm",
      member: "firm",
    });
    expect(Number(rows[0].candidate_count)).toBe(240);
    expect(rows[1]).toMatchObject({ call_expression: "y.user", member: "user" });
    expect(Number(rows[1].candidate_count)).toBe(31);
  });

  it("re-upserting a file replaces its ambiguous rows (per-file DELETE lifecycle)", async () => {
    await client.upsertFile(
      { relPath: "a.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        ambiguousFanouts: [{ sourceSymbolId: "A#m", callExpression: "x.firm", member: "firm", candidateCount: 20 }],
      },
    );
    // Re-walk of the same file with the fan-out resolved away — the stale
    // aggregate row must not survive.
    await client.upsertFile({ relPath: "a.rb", language: "ruby" }, { fileEdges: [], methodEdges: [] });
    expect(await readAmbiguousRows()).toHaveLength(0);

    // And a re-upsert with a NEW record replaces rather than accumulates.
    await client.upsertFile(
      { relPath: "a.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        ambiguousFanouts: [{ sourceSymbolId: "A#m", callExpression: "z.firm", member: "firm", candidateCount: 21 }],
      },
    );
    const rows = await readAmbiguousRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].call_expression).toBe("z.firm");
  });

  it("dedupes repeated (sourceSymbolId, callExpression) records within one upsert", async () => {
    // The same call shape can repeat inside one method body (two branches);
    // the PK is aggregate-existence semantics, not occurrence count.
    await client.upsertFile(
      { relPath: "b.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        ambiguousFanouts: [
          { sourceSymbolId: "B#m", callExpression: "x.firm", member: "firm", candidateCount: 18 },
          { sourceSymbolId: "B#m", callExpression: "x.firm", member: "firm", candidateCount: 18 },
        ],
      },
    );
    expect(await readAmbiguousRows()).toHaveLength(1);
  });

  it("recordRunStats round-trips ambiguousFanout through getRunStats, defaulting absent to 0", async () => {
    await client.recordRunStats([
      {
        language: "ruby",
        receiverKind: "dynamic",
        attempted: 10,
        resolved: 4,
        externalSkipped: 1,
        unresolvable: 0,
        noInProjectDef: 2,
        ambiguousFanout: 3,
      },
      // Pre-013 shaped row: no ambiguousFanout — must persist and read back as 0.
      {
        language: "typescript",
        receiverKind: "constant",
        attempted: 5,
        resolved: 5,
        externalSkipped: 0,
        unresolvable: 0,
      },
    ]);

    const rows = await client.getRunStats();
    const ruby = rows.find((r) => r.language === "ruby" && r.receiverKind === "dynamic");
    expect(ruby).toMatchObject({ attempted: 10, resolved: 4, ambiguousFanout: 3 });
    const ts = rows.find((r) => r.language === "typescript");
    expect(ts?.ambiguousFanout).toBe(0);
  });

  it("removeFile deletes the file's ambiguous rows (same cascade as edge tables)", async () => {
    await client.upsertFile(
      { relPath: "app/services/runner.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        ambiguousFanouts: [
          { sourceSymbolId: "Runner#go", callExpression: "x.firm", member: "firm", candidateCount: 240 },
        ],
      },
    );
    await client.upsertFile(
      { relPath: "app/services/other.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [],
        ambiguousFanouts: [
          { sourceSymbolId: "Other#go", callExpression: "y.user", member: "user", candidateCount: 31 },
        ],
      },
    );

    await client.removeFile("app/services/runner.rb");

    const rows = await readAmbiguousRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].source_rel_path).toBe("app/services/other.rb");
  });

  // bd tea-rags-mcp-z3bcv (f2jsb A4) — lazy ambiguous-group expansion read
  // path: get_callers optionally surfaces the aggregates whose `member`
  // matches the target's member segment, WITHOUT materializing edges.
  describe("getAmbiguousCallersByMember (A4 lazy expansion)", () => {
    const seedTwoFiles = async (): Promise<void> => {
      await client.upsertFile(
        { relPath: "app/services/runner.rb", language: "ruby" },
        {
          fileEdges: [],
          methodEdges: [],
          ambiguousFanouts: [
            { sourceSymbolId: "Runner#go", callExpression: "x.firm", member: "firm", candidateCount: 240 },
            { sourceSymbolId: "Runner#go", callExpression: "y.user", member: "user", candidateCount: 31 },
          ],
        },
      );
      await client.upsertFile(
        { relPath: "app/services/other.rb", language: "ruby" },
        {
          fileEdges: [],
          methodEdges: [],
          ambiguousFanouts: [
            { sourceSymbolId: "Other#zap", callExpression: "a.firm", member: "firm", candidateCount: 18 },
            { sourceSymbolId: "Aaa#first", callExpression: "b.firm", member: "firm", candidateCount: 7 },
          ],
        },
      );
    };

    it("returns only member-matched rows, ordered by (sourceSymbolId, callExpression)", async () => {
      await seedTwoFiles();
      const rows = await client.getAmbiguousCallersByMember("firm");
      expect(rows).toEqual([
        {
          sourceSymbolId: "Aaa#first",
          sourceRelPath: "app/services/other.rb",
          callExpression: "b.firm",
          candidateCount: 7,
        },
        {
          sourceSymbolId: "Other#zap",
          sourceRelPath: "app/services/other.rb",
          callExpression: "a.firm",
          candidateCount: 18,
        },
        {
          sourceSymbolId: "Runner#go",
          sourceRelPath: "app/services/runner.rb",
          callExpression: "x.firm",
          candidateCount: 240,
        },
      ]);
      // candidateCount must land as a plain JS number, not a driver bigint.
      expect(rows.every((r) => typeof r.candidateCount === "number")).toBe(true);
    });

    it("caps the result at the supplied limit (ordered prefix)", async () => {
      await seedTwoFiles();
      const rows = await client.getAmbiguousCallersByMember("firm", 2);
      expect(rows.map((r) => r.sourceSymbolId)).toEqual(["Aaa#first", "Other#zap"]);
    });

    it("empty member returns [] (never matches a persisted aggregate)", async () => {
      await seedTwoFiles();
      expect(await client.getAmbiguousCallersByMember("")).toEqual([]);
    });

    it("unknown member returns []", async () => {
      await seedTwoFiles();
      expect(await client.getAmbiguousCallersByMember("nope")).toEqual([]);
    });
  });
});
