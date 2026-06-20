import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import type {
  InheritanceEdgeRow,
  RelPath,
  SymbolDefinition,
  SymbolId,
} from "../../../../src/core/contracts/types/codegraph.js";
import { DATABASE_MIGRATIONS } from "../../../../src/core/infra/migration/database/migrations/index.js";
import { runMigrations } from "../../../../src/core/infra/migration/database/runner.js";

// bd tea-rags-mcp-2jet-E — query-time CHA cone expansion. The resolver capped a
// large cone to ONE `poly-base` edge to the base declaration `Agent#check`;
// `get_callees` / `get_callers` must re-derive the overriding subtypes through
// the reverse inheritance index at query time so a polymorphic call surfaces
// every concrete target, not just the base.
describe("DuckDbGraphClient — poly-base query-time expansion (2jet-E)", () => {
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

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-polybase-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);

    // Base Agent#check; two overriding subtypes Sub1, Sub2 each declaring check;
    // a third subtype Sub3 that does NOT override check (inherits the base) —
    // expansion must not synthesize a Sub3#check that has no symbol.
    await db.upsertSymbols("agent.rb", [sym("agent.rb", "Agent#check", ["Agent"])]);
    await db.upsertSymbols("sub1.rb", [sym("sub1.rb", "Sub1#check", ["Sub1"])]);
    await db.upsertSymbols("sub2.rb", [sym("sub2.rb", "Sub2#check", ["Sub2"])]);
    await db.upsertSymbols("sub3.rb", [sym("sub3.rb", "Sub3#other", ["Sub3"])]);
    await db.upsertFile({ relPath: "agent.rb", language: "ruby" }, { fileEdges: [], methodEdges: [] });
    await db.upsertFile(
      { relPath: "sub1.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], inheritance: [inh("Sub1", "Agent")] },
    );
    await db.upsertFile(
      { relPath: "sub2.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], inheritance: [inh("Sub2", "Agent")] },
    );
    await db.upsertFile(
      { relPath: "sub3.rb", language: "ruby" },
      { fileEdges: [], methodEdges: [], inheritance: [inh("Sub3", "Agent")] },
    );

    // Caller#run dispatches polymorphically on an Agent receiver — the resolver
    // persisted ONE poly-base edge to the base declaration.
    await db.upsertSymbols("caller.rb", [sym("caller.rb", "Caller#run", ["Caller"])]);
    await db.upsertFile(
      { relPath: "caller.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "Caller#run",
            targetSymbolId: "Agent#check",
            targetRelPath: "agent.rb",
            callExpression: "agent.check",
            edgeKind: "poly-base",
            confidence: 1,
          },
        ],
      },
    );
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("getCallees expands a poly-base edge to the overriding subtypes", async () => {
    const callees = await db.getCallees("Caller#run");
    const targets = callees.map((c) => c.targetSymbolId).sort();
    // Base decl + the two real overriders; Sub3 (no override) is NOT synthesized.
    expect(targets).toEqual(["Agent#check", "Sub1#check", "Sub2#check"]);
    const sub1 = callees.find((c) => c.targetSymbolId === "Sub1#check");
    expect(sub1?.targetRelPath).toBe("sub1.rb");
    expect(sub1?.callExpression).toBe("agent.check");
  });

  it("getCallees leaves a plain exact edge untouched", async () => {
    await db.upsertSymbols("plain.rb", [sym("plain.rb", "Plain#go", ["Plain"])]);
    await db.upsertFile(
      { relPath: "plain.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "Plain#go",
            targetSymbolId: "Agent#check",
            targetRelPath: "agent.rb",
            callExpression: "x.check",
            // no edgeKind → persisted exact
          },
        ],
      },
    );
    const callees = await db.getCallees("Plain#go");
    expect(callees.map((c) => c.targetSymbolId)).toEqual(["Agent#check"]);
  });

  it("getCallers of a subtype override surfaces callers that targeted the poly-base", async () => {
    // Caller#run targeted Agent#check via poly-base; a query for callers of the
    // concrete override Sub1#check must include Caller#run (symmetric expansion).
    const callers = await db.getCallers("Sub1#check");
    expect(callers.map((c) => c.sourceSymbolId)).toContain("Caller#run");
  });

  it("getCallers of the base still returns the direct poly-base caller", async () => {
    const callers = await db.getCallers("Agent#check");
    expect(callers.map((c) => c.sourceSymbolId)).toContain("Caller#run");
  });

  it("dedupes a caller that appears both directly and via poly-base expansion", async () => {
    // Caller#run already has a poly-base edge to Agent#check (from beforeEach).
    // Now also add a DIRECT edge from Caller#run to Sub1#check with the SAME
    // callExpression. getCallers("Sub1#check") will surface Caller#run in
    // both the direct query AND the poly-base expansion path (because Sub1
    // inherits Agent). dedupeCallerEdges must collapse them to one result.
    await db.upsertFile(
      { relPath: "caller.rb", language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "Caller#run",
            targetSymbolId: "Agent#check",
            targetRelPath: "agent.rb",
            callExpression: "agent.check",
            edgeKind: "poly-base",
            confidence: 1,
          },
          {
            sourceSymbolId: "Caller#run",
            targetSymbolId: "Sub1#check",
            targetRelPath: "sub1.rb",
            callExpression: "agent.check",
          },
        ],
      },
    );
    const callers = await db.getCallers("Sub1#check" as SymbolId);
    const fromCaller = callers.filter((c) => c.sourceSymbolId === "Caller#run");
    // Must appear exactly once — not duplicated even though two query paths surface it.
    expect(fromCaller).toHaveLength(1);
  });
});

describe("DuckDbGraphClient — poly-base expansion with bare top-level target (L838)", () => {
  let dir: string;
  let db: DuckDbGraphClient;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "cg-polybase-bare-"));
    db = new DuckDbGraphClient({ path: join(dir, "g.duckdb") });
    await db.init();
    await runMigrations(db, DATABASE_MIGRATIONS);
  });

  afterEach(async () => {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("getCallees returns just the base edge when poly-base target has no member separator", async () => {
    // A poly-base edge whose targetSymbolId is a bare top-level name (no '#' or '.')
    // cannot be expanded — splitMethodSymbol returns null and expandPolyBaseCallees
    // returns [] immediately (L838). The base edge itself must still be returned.
    await db.upsertSymbols("top.rb" as RelPath, [
      {
        symbolId: "TopLevelFunction" as SymbolId,
        fqName: "TopLevelFunction",
        shortName: "TopLevelFunction",
        relPath: "top.rb" as RelPath,
        scope: [],
      },
    ]);
    await db.upsertSymbols("caller.rb" as RelPath, [
      {
        symbolId: "Caller#run" as SymbolId,
        fqName: "Caller#run",
        shortName: "run",
        relPath: "caller.rb" as RelPath,
        scope: ["Caller"],
      },
    ]);
    await db.upsertFile({ relPath: "top.rb" as RelPath, language: "ruby" }, { fileEdges: [], methodEdges: [] });
    await db.upsertFile(
      { relPath: "caller.rb" as RelPath, language: "ruby" },
      {
        fileEdges: [],
        methodEdges: [
          {
            sourceSymbolId: "Caller#run",
            targetSymbolId: "TopLevelFunction",
            targetRelPath: "top.rb",
            callExpression: "TopLevelFunction()",
            edgeKind: "poly-base",
            confidence: 1,
          },
        ],
      },
    );
    const callees = await db.getCallees("Caller#run" as SymbolId);
    // expandPolyBaseCallees bails early (no member separator on "TopLevelFunction").
    // The base poly-base edge must still be present, and no phantom expansion rows.
    expect(callees.map((c) => c.targetSymbolId)).toEqual(["TopLevelFunction"]);
  });
});
