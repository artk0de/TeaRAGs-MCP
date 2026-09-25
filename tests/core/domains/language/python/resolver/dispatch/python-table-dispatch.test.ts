/**
 * `PythonCallResolver.resolveDispatch` over dict dispatch tables (bd
 * tea-rags-mcp-pbwd, epic 542x) — the Python port of the TypeScript
 * `TSCallResolver.resolveDispatch` suite, with Ruby's edge vocabulary
 * (`RubyTableDispatchResolver`): a static key narrows to ONE `exact` edge at
 * 1.0, a dynamic key fans to every entry as `registry` edges sharing unit
 * confidence. Driven through the production resolver so the composition order
 * (table first, then the cone) is what the assertions see.
 */
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  DispatchEdge,
  DispatchFanoutOutcome,
  DispatchTableDef,
  ImportRef,
  ModuleReexport,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { PythonCallResolver } from "../../../../../../../src/core/domains/language/python/resolver/python-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

interface Def {
  readonly symbolId: string;
  readonly scope?: readonly string[];
}

function tableWith(files: Record<string, readonly Def[]>): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of Object.entries(files)) {
    table.upsertFile(
      relPath,
      defs.map((def) => ({
        symbolId: def.symbolId,
        fqName: def.symbolId,
        shortName: def.symbolId.split(/[#.]/).pop() ?? def.symbolId,
        relPath,
        scope: [...(def.scope ?? [])],
      })),
    );
  }
  return table;
}

function edgesOf(outcome: DispatchFanoutOutcome): DispatchEdge[] {
  return outcome.kind === "edges" ? outcome.edges : [];
}

function ctxFor(parts: {
  readonly files: Record<string, readonly Def[]>;
  readonly tables: Record<string, DispatchTableDef[]>;
  readonly callerFile?: string;
  readonly imports?: ImportRef[];
  readonly moduleReexports?: Record<string, readonly ModuleReexport[]>;
  readonly callbackParams?: Record<string, number[]>;
}): CallContext {
  return {
    callerFile: parts.callerFile ?? "pkg/app.py",
    callerScope: ["go"],
    callerSymbolId: "go",
    imports: parts.imports ?? [],
    symbolTable: tableWith(parts.files),
    dispatchTables: parts.tables,
    moduleReexports: parts.moduleReexports ?? {},
    callbackParams: parts.callbackParams,
  };
}

const dispatchCall = (table: string, key: string | null, field: string | null = null): CallRef => ({
  callText: `${table}[k](1)`,
  receiver: null,
  member: field ?? table,
  startLine: 9,
  dispatch: { table, field, key },
});

describe("PythonCallResolver.resolveDispatch — dict tables (pbwd)", () => {
  const resolver = new PythonCallResolver();

  it("fans a dynamic key to EVERY entry of an in-file S2 table, 1/N registry edges from the caller", () => {
    const ctx = ctxFor({
      files: { "pkg/app.py": [{ symbolId: "on_a" }, { symbolId: "on_b" }, { symbolId: "go" }] },
      tables: { HANDLERS: [{ relPath: "pkg/app.py", table: { entries: { a: "on_a", b: "on_b" } } }] },
    });
    const edges = edgesOf(resolver.resolveDispatch(dispatchCall("HANDLERS", null), ctx));
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual(["on_a", "on_b"]);
    expect(edges.every((e) => e.sourceSymbolId === null)).toBe(true);
    expect(edges.every((e) => e.edgeKind === "registry" && e.confidence === 0.5)).toBe(true);
  });

  it("narrows a static string key to the ONE matching entry as an exact 1.0 edge", () => {
    const ctx = ctxFor({
      files: { "pkg/app.py": [{ symbolId: "on_a" }, { symbolId: "on_b" }] },
      tables: { HANDLERS: [{ relPath: "pkg/app.py", table: { entries: { a: "on_a", b: "on_b" } } }] },
    });
    const edges = edgesOf(resolver.resolveDispatch(dispatchCall("HANDLERS", "a"), ctx));
    expect(edges).toEqual([
      { sourceSymbolId: null, targetRelPath: "pkg/app.py", targetSymbolId: "on_a", edgeKind: "exact", confidence: 1 },
    ]);
  });

  it("selects the S1 field of each entry", () => {
    const ctx = ctxFor({
      files: { "pkg/app.py": [{ symbolId: "fn_a" }, { symbolId: "fn_b" }, { symbolId: "other" }] },
      tables: {
        T: [{ relPath: "pkg/app.py", table: { entries: { a: { w: "fn_a", v: "other" }, b: { w: "fn_b" } } } }],
      },
    });
    const edges = edgesOf(resolver.resolveDispatch(dispatchCall("T", null, "w"), ctx));
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual(["fn_a", "fn_b"]);
  });

  it("resolves a method-valued entry (`Cls.method`) the way a direct call would", () => {
    const ctx = ctxFor({
      files: {
        "pkg/app.py": [
          { symbolId: "Handlers" },
          { symbolId: "Handlers.on_a", scope: ["Handlers"] },
          { symbolId: "Handlers.on_b", scope: ["Handlers"] },
        ],
      },
      tables: {
        T: [{ relPath: "pkg/app.py", table: { entries: { a: "Handlers.on_a", b: "Handlers.on_b" } } }],
      },
    });
    const edges = edgesOf(resolver.resolveDispatch(dispatchCall("T", null), ctx));
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual(["Handlers.on_a", "Handlers.on_b"]);
  });

  it("resolves an in-file entry bound by the file's own import", () => {
    const ctx = ctxFor({
      files: { "pkg/app.py": [{ symbolId: "go" }], "pkg/handlers.py": [{ symbolId: "on_a" }] },
      imports: [{ importText: ".handlers", startLine: 1, importedNames: ["on_a"], importedBindings: { on_a: "on_a" } }],
      tables: { T: [{ relPath: "pkg/app.py", table: { entries: { a: "on_a" } } }] },
    });
    const edges = edgesOf(resolver.resolveDispatch(dispatchCall("T", "a"), ctx));
    expect(edges.map((e) => [e.targetRelPath, e.targetSymbolId])).toEqual([["pkg/handlers.py", "on_a"]]);
  });

  it("resolves an IMPORTED table's entries from the file that declares the table", () => {
    const ctx = ctxFor({
      files: {
        "pkg/app.py": [{ symbolId: "go" }],
        "pkg/registry.py": [],
        "pkg/handlers.py": [
          { symbolId: "on_a" },
          { symbolId: "Handlers" },
          { symbolId: "Handlers.on_b", scope: ["Handlers"] },
        ],
      },
      imports: [{ importText: ".registry", startLine: 1, importedNames: ["T"], importedBindings: { T: "T" } }],
      moduleReexports: {
        "pkg/registry.py": [
          { exportedName: "on_a", sourceModule: ".handlers", sourceName: "on_a" },
          { exportedName: "Handlers", sourceModule: ".handlers", sourceName: "Handlers" },
        ],
      },
      tables: { T: [{ relPath: "pkg/registry.py", table: { entries: { a: "on_a", b: "Handlers.on_b" } } }] },
    });
    const edges = edgesOf(resolver.resolveDispatch(dispatchCall("T", null), ctx));
    expect(edges.map((e) => [e.targetRelPath, e.targetSymbolId]).sort()).toEqual([
      ["pkg/handlers.py", "Handlers.on_b"],
      ["pkg/handlers.py", "on_a"],
    ]);
  });

  it("resolves an IMPORTED table's module-qualified entries through the table file's module import", () => {
    // ugnest's scenario registry: `from pkg import active, demo` then
    // `SCENARIOS = {"active": active.seed, "demo": demo.seed}` in the package,
    // read as `SCENARIOS[name]` from another module.
    const ctx = ctxFor({
      files: {
        "pkg/app.py": [{ symbolId: "go" }],
        "pkg/registry.py": [],
        "pkg/active.py": [{ symbolId: "seed" }],
        "pkg/demo.py": [{ symbolId: "seed" }],
      },
      imports: [
        {
          importText: ".registry",
          startLine: 1,
          importedNames: ["SCENARIOS"],
          importedBindings: { SCENARIOS: "SCENARIOS" },
        },
      ],
      moduleReexports: {
        "pkg/registry.py": [
          { exportedName: "active", sourceModule: ".", sourceName: "active" },
          { exportedName: "demo", sourceModule: ".", sourceName: "demo" },
        ],
      },
      tables: {
        SCENARIOS: [{ relPath: "pkg/registry.py", table: { entries: { active: "active.seed", demo: "demo.seed" } } }],
      },
    });
    const edges = edgesOf(resolver.resolveDispatch(dispatchCall("SCENARIOS", null), ctx));
    expect(edges.map((e) => [e.targetRelPath, e.targetSymbolId]).sort()).toEqual([
      ["pkg/active.py", "seed"],
      ["pkg/demo.py", "seed"],
    ]);
  });

  it("drops an unresolvable entry and keeps the resolvable ones", () => {
    const ctx = ctxFor({
      files: { "pkg/app.py": [{ symbolId: "on_a" }] },
      tables: { T: [{ relPath: "pkg/app.py", table: { entries: { a: "on_a", b: "on_missing" } } }] },
    });
    const edges = edgesOf(resolver.resolveDispatch(dispatchCall("T", null), ctx));
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["on_a"]);
    expect(edges[0].confidence).toBe(1);
  });

  it("dedupes entries that name the same callable", () => {
    const ctx = ctxFor({
      files: { "pkg/app.py": [{ symbolId: "on_a" }] },
      tables: { T: [{ relPath: "pkg/app.py", table: { entries: { a: "on_a", b: "on_a" } } }] },
    });
    expect(edgesOf(resolver.resolveDispatch(dispatchCall("T", null), ctx))).toHaveLength(1);
  });

  it("drops the whole call when the table name is unknown", () => {
    const ctx = ctxFor({
      files: { "pkg/app.py": [{ symbolId: "on_a" }] },
      tables: { T: [{ relPath: "pkg/app.py", table: { entries: { a: "on_a" } } }] },
    });
    expect(edgesOf(resolver.resolveDispatch(dispatchCall("Z", null), ctx))).toEqual([]);
  });

  it("disambiguates a same-name table across files through the caller's import binding", () => {
    const ctx = ctxFor({
      files: { "pkg/app.py": [], "pkg/a.py": [{ symbolId: "fn_a" }], "pkg/b.py": [{ symbolId: "fn_b" }] },
      imports: [{ importText: ".a", startLine: 1, importedNames: ["T"], importedBindings: { T: "T" } }],
      tables: {
        T: [
          { relPath: "pkg/a.py", table: { entries: { x: "fn_a" } } },
          { relPath: "pkg/b.py", table: { entries: { y: "fn_b" } } },
        ],
      },
    });
    expect(edgesOf(resolver.resolveDispatch(dispatchCall("T", null), ctx)).map((e) => e.targetSymbolId)).toEqual([
      "fn_a",
    ]);
  });

  it("drops a same-name table no import binding disambiguates", () => {
    const ctx = ctxFor({
      files: { "pkg/app.py": [], "pkg/a.py": [{ symbolId: "fn_a" }], "pkg/b.py": [{ symbolId: "fn_b" }] },
      tables: {
        T: [
          { relPath: "pkg/a.py", table: { entries: { x: "fn_a" } } },
          { relPath: "pkg/b.py", table: { entries: { y: "fn_b" } } },
        ],
      },
    });
    expect(edgesOf(resolver.resolveDispatch(dispatchCall("T", null), ctx))).toEqual([]);
  });

  describe("bounded inter-procedural join (callback params)", () => {
    const joinCall: CallRef = {
      callText: "run(tree, T[k])",
      receiver: null,
      member: "run",
      startLine: 9,
      dispatchArgs: [{ argIndex: 1, candidate: { table: "T", field: null, key: null } }],
    };
    const joinCtx = (callbackParams: Record<string, number[]>): CallContext =>
      ctxFor({
        files: { "pkg/app.py": [{ symbolId: "run" }, { symbolId: "on_a" }, { symbolId: "on_b" }] },
        tables: { T: [{ relPath: "pkg/app.py", table: { entries: { a: "on_a", b: "on_b" } } }] },
        callbackParams,
      });

    it("fans out from the CALLEE when a candidate set lands on a callback-param position", () => {
      const edges = edgesOf(resolver.resolveDispatch(joinCall, joinCtx({ run: [1] })));
      expect(edges.map((e) => e.targetSymbolId).sort()).toEqual(["on_a", "on_b"]);
      expect(edges.every((e) => e.sourceSymbolId === "run")).toBe(true);
    });

    it("emits NO join edge at a non-callback position", () => {
      expect(edgesOf(resolver.resolveDispatch(joinCall, joinCtx({ run: [0] })))).toEqual([]);
    });

    it("emits NO join edge when the callee has no callbackParams entry", () => {
      expect(edgesOf(resolver.resolveDispatch(joinCall, joinCtx({})))).toEqual([]);
    });
  });
});
