import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type {
  InheritanceEdgeRow,
  MethodEdgeKind,
  SymbolDefinition,
} from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/domains/maintenance/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

// bd tea-rags-mcp-afdpc — the call tree reads a whole BFS frontier per level.
// The bulk reads must answer, per symbol, exactly what the one-symbol reads
// answer: same edges, poly-base expansion in both directions included.
describe("DuckDbGraphClient — frontier bulk edge reads (afdpc)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  const sym = (relPath: string, symbolId: string, scope: string[]): SymbolDefinition => ({
    symbolId,
    fqName: symbolId,
    shortName: symbolId.split("#").pop() ?? symbolId,
    relPath,
    scope,
  });
  const inh = (s: string, a: string): InheritanceEdgeRow => ({
    sourceFqName: s,
    sourceSymbolId: s,
    ancestorFqName: a,
    ancestorSymbolId: a,
    kind: "super",
    ordinal: 0,
  });
  const edge = (
    targetSymbolId: string | null,
    targetRelPath: string,
    callExpression: string,
    edgeKind?: MethodEdgeKind,
  ) => ({
    sourceSymbolId: "",
    targetSymbolId,
    targetRelPath,
    callExpression,
    ...(edgeKind && { edgeKind, confidence: 1 }),
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-bulk-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
    await db.upsertSymbols("agent.rb", [sym("agent.rb", "Agent#check", ["Agent"])]);
    await db.upsertSymbols("sub1.rb", [sym("sub1.rb", "Sub1#check", ["Sub1"])]);
    await db.upsertSymbols("sub2.rb", [sym("sub2.rb", "Sub2#check", ["Sub2"])]);
    await db.upsertSymbols("helper.rb", [sym("helper.rb", "Helper#h", ["Helper"])]);
    await db.upsertFile({ relPath: "agent.rb", language: "ruby" }, { fileEdges: [], methodEdges: [] });
    await db.upsertFile({ relPath: "helper.rb", language: "ruby" }, { fileEdges: [], methodEdges: [] });
    for (const sub of ["Sub1", "Sub2"]) {
      await db.upsertFile(
        { relPath: `${sub.toLowerCase()}.rb`, language: "ruby" },
        { fileEdges: [], methodEdges: [], inheritance: [inh(sub, "Agent")] },
      );
    }
    await db.upsertSymbols("caller.rb", [sym("caller.rb", "Caller#run", ["Caller"])]);
    await db.upsertFile(
      { relPath: "caller.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [
          { ...edge("Agent#check", "agent.rb", "agent.check", "poly-base"), sourceSymbolId: "Caller#run" },
          { ...edge("Helper#h", "helper.rb", "helper.h"), sourceSymbolId: "Caller#run" },
          { ...edge("Helper#h", "helper.rb", "helper.h2"), sourceSymbolId: "Caller#run" },
          { ...edge(null, "lib.rb", "File.read"), sourceSymbolId: "Caller#run" },
        ],
      },
    );
    await db.upsertSymbols("other.rb", [sym("other.rb", "Other#go", ["Other"])]);
    await db.upsertFile(
      { relPath: "other.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [{ ...edge("Sub1#check", "sub1.rb", "s.check"), sourceSymbolId: "Other#go" }],
      },
    );
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const key = (e: object) => JSON.stringify(e);

  it("getCalleesBulk answers every source as getCallees does, poly-base subtypes included", async () => {
    const sources = ["Caller#run", "Other#go", "Helper#h"];
    const bulk = await db.getCalleesBulk(sources);
    for (const id of sources) {
      const single = (await db.getCallees(id)).map(key).sort();
      expect((bulk.get(id) ?? []).map(key).sort()).toEqual(single);
    }
    expect(bulk.get("Caller#run")?.map((e) => e.targetSymbolId)).toContain("Sub2#check");
  });

  it("getCallersBulk answers every target as getCallers does, poly-base callers included", async () => {
    const targets = ["Sub1#check", "Agent#check", "Helper#h", "Nobody#x"];
    const bulk = await db.getCallersBulk(targets);
    for (const id of targets) {
      const single = (await db.getCallers(id)).map(key).sort();
      expect((bulk.get(id) ?? []).map(key).sort()).toEqual(single);
    }
    expect(
      bulk
        .get("Sub1#check")
        ?.map((e) => e.sourceSymbolId)
        .sort(),
    ).toEqual(["Caller#run", "Other#go"]);
  });

  it("an empty frontier reads nothing", async () => {
    expect((await db.getCalleesBulk([])).size).toBe(0);
    expect((await db.getCallersBulk([])).size).toBe(0);
  });
});
