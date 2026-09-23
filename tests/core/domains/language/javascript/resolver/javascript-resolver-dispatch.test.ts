import Parser from "tree-sitter";
import JsLang from "tree-sitter-javascript";
import { describe, expect, it } from "vitest";

import type {
  CallContext,
  CallRef,
  DispatchEdge,
  DispatchFanoutOutcome,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageFactoryDescriptor } from "../../../../../../src/core/contracts/types/language.js";
import { JavaScriptLanguage } from "../../../../../../src/core/domains/language/javascript/index.js";
import { JavascriptCallResolver } from "../../../../../../src/core/domains/language/javascript/resolver/index.js";
import { CallEdgeResolutionRunner } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

// resolveDispatch returns DispatchFanoutOutcome; unwrap (throwing on
// `ambiguous` keeps the assertion strict — these fixtures never exceed a cap).
const edgesOf = (outcome: DispatchFanoutOutcome): DispatchEdge[] => {
  if (outcome.kind !== "edges") throw new Error(`expected edges outcome, got ${outcome.kind}`);
  return outcome.edges;
};

const topLevel = (symbolId: string, relPath: string) => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId,
  relPath,
  scope: [],
});

/**
 * Mirror of the TypeScript resolver's "TSCallResolver.resolveDispatch" block
 * (bd tea-rags-mcp-n0zj) for JavaScript (bd tea-rags-mcp-hkj8): table fan-out,
 * static key, S2, unresolved drop, unknown table, import-disambiguated table,
 * the bounded callback-param join, and import-narrowed candidate names.
 */
describe("JavascriptCallResolver.resolveDispatch", () => {
  function tableWith(fns: string[]): InMemoryGlobalSymbolTable {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile(
      "src/walkers.js",
      fns.map((fn) => topLevel(fn, "src/walkers.js")),
    );
    return symbolTable;
  }
  const resolver = new JavascriptCallResolver();

  it("fans a dynamic key out to ALL entries of an S1 table (2 edges, source = caller)", () => {
    const ctx: CallContext = {
      callerFile: "src/dispatch.js",
      callerScope: [],
      imports: [],
      symbolTable: tableWith(["fnA", "fnB"]),
      dispatchTables: { T: [{ relPath: "src/dispatch.js", table: { entries: { a: { w: "fnA" }, b: { w: "fnB" } } } }] },
    };
    const call: CallRef = {
      callText: "f(1)",
      receiver: null,
      member: "w",
      startLine: 1,
      dispatch: { table: "T", field: "w", key: null },
    };
    const edges = edgesOf(resolver.resolveDispatch(call, ctx));
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual(["fnA", "fnB"]);
    expect(edges.every((e) => e.sourceSymbolId === null)).toBe(true);
    expect(edges.every((e) => e.targetRelPath === "src/walkers.js")).toBe(true);
  });

  it("resolves a static string-literal key to the ONE matching entry (1 edge)", () => {
    const ctx: CallContext = {
      callerFile: "src/dispatch.js",
      callerScope: [],
      imports: [],
      symbolTable: tableWith(["fnA", "fnB"]),
      dispatchTables: { T: [{ relPath: "src/dispatch.js", table: { entries: { a: { w: "fnA" }, b: { w: "fnB" } } } }] },
    };
    const edges = edgesOf(
      resolver.resolveDispatch(
        {
          callText: 'T["a"].w(1)',
          receiver: null,
          member: "w",
          startLine: 1,
          dispatch: { table: "T", field: "w", key: "a" },
        },
        ctx,
      ),
    );
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["fnA"]);
  });

  it("resolves an S2 direct-function table (field null → entry IS the function)", () => {
    const ctx: CallContext = {
      callerFile: "src/dispatch.js",
      callerScope: [],
      imports: [],
      symbolTable: tableWith(["fnA", "fnB"]),
      dispatchTables: { H: [{ relPath: "src/dispatch.js", table: { entries: { a: "fnA", b: "fnB" } } }] },
    };
    const edges = edgesOf(
      resolver.resolveDispatch(
        {
          callText: "H[k](1)",
          receiver: null,
          member: "H",
          startLine: 1,
          dispatch: { table: "H", field: null, key: null },
        },
        ctx,
      ),
    );
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual(["fnA", "fnB"]);
  });

  it("dedupes a dynamic key over entries naming the same function to ONE edge", () => {
    const ctx: CallContext = {
      callerFile: "src/dispatch.js",
      callerScope: [],
      imports: [],
      symbolTable: tableWith(["fnA"]),
      dispatchTables: { H: [{ relPath: "src/dispatch.js", table: { entries: { a: "fnA", b: "fnA" } } }] },
    };
    const edges = edgesOf(
      resolver.resolveDispatch(
        {
          callText: "H[k](1)",
          receiver: null,
          member: "H",
          startLine: 1,
          dispatch: { table: "H", field: null, key: null },
        },
        ctx,
      ),
    );
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["fnA"]);
  });

  it("drops an unresolved candidate name (keeps the resolvable ones)", () => {
    const ctx: CallContext = {
      callerFile: "src/dispatch.js",
      callerScope: [],
      imports: [],
      symbolTable: tableWith(["fnA"]), // fnMissing is NOT in the table
      dispatchTables: {
        T: [{ relPath: "src/dispatch.js", table: { entries: { a: { w: "fnA" }, b: { w: "fnMissing" } } } }],
      },
    };
    const edges = edgesOf(
      resolver.resolveDispatch(
        {
          callText: "f(1)",
          receiver: null,
          member: "w",
          startLine: 1,
          dispatch: { table: "T", field: "w", key: null },
        },
        ctx,
      ),
    );
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["fnA"]);
  });

  it("never lands a candidate on a non-ECMAScript namesake", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("app/handlers.rb", [topLevel("fnA", "app/handlers.rb")]);
    const ctx: CallContext = {
      callerFile: "src/dispatch.js",
      callerScope: [],
      imports: [],
      symbolTable,
      dispatchTables: { H: [{ relPath: "src/dispatch.js", table: { entries: { a: "fnA" } } }] },
    };
    const edges = edgesOf(
      resolver.resolveDispatch(
        {
          callText: "H[k](1)",
          receiver: null,
          member: "H",
          startLine: 1,
          dispatch: { table: "H", field: null, key: null },
        },
        ctx,
      ),
    );
    expect(edges).toEqual([]);
  });

  it("drops the whole call when the table name is unknown", () => {
    const ctx: CallContext = {
      callerFile: "src/dispatch.js",
      callerScope: [],
      imports: [],
      symbolTable: tableWith(["fnA"]),
      dispatchTables: { T: [{ relPath: "src/dispatch.js", table: { entries: { a: { w: "fnA" } } } }] },
    };
    const edges = edgesOf(
      resolver.resolveDispatch(
        {
          callText: "f(1)",
          receiver: null,
          member: "w",
          startLine: 1,
          dispatch: { table: "Z", field: "w", key: null },
        },
        ctx,
      ),
    );
    expect(edges).toEqual([]);
  });

  it("disambiguates a same-name table across files via the caller's import map", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/a.js", [topLevel("fnA", "src/a.js")]);
    symbolTable.upsertFile("src/b.js", [topLevel("fnB", "src/b.js")]);
    const ctx: CallContext = {
      callerFile: "src/dispatch.js",
      callerScope: [],
      imports: [{ importText: "./a", startLine: 1 }], // → src/a.js
      symbolTable,
      dispatchTables: {
        T: [
          { relPath: "src/a.js", table: { entries: { x: { w: "fnA" } } } },
          { relPath: "src/b.js", table: { entries: { y: { w: "fnB" } } } },
        ],
      },
    };
    const edges = edgesOf(
      resolver.resolveDispatch(
        {
          callText: "f(1)",
          receiver: null,
          member: "w",
          startLine: 1,
          dispatch: { table: "T", field: "w", key: null },
        },
        ctx,
      ),
    );
    // Caller imports src/a.js → the a-table wins; fnB never reached.
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["fnA"]);
  });

  it("prefers the caller's own in-file table when no import names one of the same-name tables", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/a.js", [topLevel("fnA", "src/a.js")]);
    symbolTable.upsertFile("src/dispatch.js", [topLevel("fnLocal", "src/dispatch.js")]);
    const ctx: CallContext = {
      callerFile: "src/dispatch.js",
      callerScope: [],
      imports: [],
      symbolTable,
      dispatchTables: {
        T: [
          { relPath: "src/a.js", table: { entries: { x: "fnA" } } },
          { relPath: "src/dispatch.js", table: { entries: { x: "fnLocal" } } },
        ],
      },
    };
    const edges = edgesOf(
      resolver.resolveDispatch(
        {
          callText: "T[k]()",
          receiver: null,
          member: "T",
          startLine: 1,
          dispatch: { table: "T", field: null, key: null },
        },
        ctx,
      ),
    );
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["fnLocal"]);
  });

  it("drops a same-name ambiguous table when no import edge disambiguates", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/a.js", [topLevel("fnA", "src/a.js")]);
    symbolTable.upsertFile("src/b.js", [topLevel("fnB", "src/b.js")]);
    const ctx: CallContext = {
      callerFile: "src/dispatch.js",
      callerScope: [],
      imports: [], // no import edge → ambiguous → drop
      symbolTable,
      dispatchTables: {
        T: [
          { relPath: "src/a.js", table: { entries: { x: { w: "fnA" } } } },
          { relPath: "src/b.js", table: { entries: { y: { w: "fnB" } } } },
        ],
      },
    };
    const edges = edgesOf(
      resolver.resolveDispatch(
        {
          callText: "f(1)",
          receiver: null,
          member: "w",
          startLine: 1,
          dispatch: { table: "T", field: "w", key: null },
        },
        ctx,
      ),
    );
    expect(edges).toEqual([]);
  });

  // ── Bounded inter-procedural join (callback params) ──
  function joinCtx(callbackParams: Record<string, number[]>): CallContext {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/collect.js", [topLevel("collectSymbols", "src/collect.js")]);
    symbolTable.upsertFile("src/names.js", [
      topLevel("jsNameOf", "src/names.js"),
      topLevel("rbNameOf", "src/names.js"),
    ]);
    return {
      callerFile: "src/dispatch.js",
      callerScope: [],
      imports: [],
      symbolTable,
      callbackParams,
      dispatchTables: {
        T: [{ relPath: "src/dispatch.js", table: { entries: { js: { n: "jsNameOf" }, rb: { n: "rbNameOf" } } } }],
      },
    };
  }
  const joinCall: CallRef = {
    callText: "collectSymbols(tree, T[k].n)",
    receiver: null,
    member: "collectSymbols",
    startLine: 1,
    dispatchArgs: [{ argIndex: 1, candidate: { table: "T", field: "n", key: null } }],
  };

  it("fans out from the CALLEE when a dispatch arg lands on a callback-param position", () => {
    const edges = edgesOf(resolver.resolveDispatch(joinCall, joinCtx({ collectSymbols: [1] })));
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual(["jsNameOf", "rbNameOf"]);
    expect(edges.every((e) => e.sourceSymbolId === "collectSymbols")).toBe(true);
  });

  it("emits NO join edge when the dispatch arg is at a non-callback position", () => {
    expect(edgesOf(resolver.resolveDispatch(joinCall, joinCtx({ collectSymbols: [0] })))).toEqual([]);
  });

  it("emits NO join edge when the callee has no callbackParams entry", () => {
    expect(edgesOf(resolver.resolveDispatch(joinCall, joinCtx({})))).toEqual([]);
  });

  it("emits NO join edge when the callee itself does not resolve", () => {
    const unresolvedCallee: CallRef = { ...joinCall, member: "missingCollector" };
    expect(edgesOf(resolver.resolveDispatch(unresolvedCallee, joinCtx({ missingCollector: [1] })))).toEqual([]);
  });

  it("narrows an ambiguous candidate name to the file the caller imports", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/handlers-a.js", [topLevel("handle", "src/handlers-a.js")]);
    symbolTable.upsertFile("src/handlers-b.js", [topLevel("handle", "src/handlers-b.js")]);
    const ctx: CallContext = {
      callerFile: "src/dispatch.js",
      callerScope: [],
      imports: [{ importText: "./handlers-a", startLine: 1 }], // → src/handlers-a.js only
      symbolTable,
      dispatchTables: { CMD: [{ relPath: "src/dispatch.js", table: { entries: { x: { run: "handle" } } } }] },
    };
    const edges = edgesOf(
      resolver.resolveDispatch(
        {
          callText: "CMD[k].run(x)",
          receiver: null,
          member: "run",
          startLine: 1,
          dispatch: { table: "CMD", field: "run", key: null },
        },
        ctx,
      ),
    );
    expect(edges.map((e) => e.targetRelPath)).toEqual(["src/handlers-a.js"]);
  });

  it("drops an ambiguous candidate name when no import disambiguates it", () => {
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/handlers-a.js", [topLevel("handle", "src/handlers-a.js")]);
    symbolTable.upsertFile("src/handlers-b.js", [topLevel("handle", "src/handlers-b.js")]);
    const ctx: CallContext = {
      callerFile: "src/dispatch.js",
      callerScope: [],
      imports: [], // no import edge → ambiguity is real → drop, never guess
      symbolTable,
      dispatchTables: { CMD: [{ relPath: "src/dispatch.js", table: { entries: { x: { run: "handle" } } } }] },
    };
    const edges = edgesOf(
      resolver.resolveDispatch(
        {
          callText: "CMD[k].run(x)",
          receiver: null,
          member: "run",
          startLine: 1,
          dispatch: { table: "CMD", field: "run", key: null },
        },
        ctx,
      ),
    );
    expect(edges).toEqual([]);
  });

  it("returns no edges for an ordinary call (no dispatch, no dispatchArgs)", () => {
    const ctx: CallContext = { callerFile: "src/x.js", callerScope: [], imports: [], symbolTable: tableWith(["fnA"]) };
    expect(
      edgesOf(resolver.resolveDispatch({ callText: "fnA()", receiver: null, member: "fnA", startLine: 1 }, ctx)),
    ).toEqual([]);
  });
});

describe("JavaScript lookup-table dispatch end to end (walker → run state → runner, bd tea-rags-mcp-hkj8)", () => {
  function parse(src: string) {
    const parser = new Parser();
    parser.setLanguage(JsLang);
    return parser.parse(src);
  }

  it("persists caller→candidate edges for `H[k]()` and callee→candidate edges for a callback-param join", () => {
    const language = new JavaScriptLanguage();
    const handlersSrc = [
      "function onGet() {}",
      "function onPost() {}",
      "function run(req, handler) {",
      "  handler(req);",
      "}",
      "",
    ].join("\n");
    const dispatchSrc = [
      "const { onGet, onPost, run } = require('./handlers');", // 1
      "const ROUTES = { get: onGet, post: onPost };", //          2
      "function route(method, req) {", //                        3
      "  ROUTES[method](req);", //                                4
      "  run(req, ROUTES[method]);", //                           5
      "}", //                                                     6
      "",
    ].join("\n");
    const handlers = language.walker.walk({
      tree: parse(handlersSrc),
      code: handlersSrc,
      relPath: "src/handlers.js",
      language: "javascript",
      chunks: [
        { symbolId: "onGet", startLine: 1, endLine: 1, scope: [] },
        { symbolId: "onPost", startLine: 2, endLine: 2, scope: [] },
        { symbolId: "run", startLine: 3, endLine: 5, scope: [] },
      ],
    });
    const dispatch = language.walker.walk({
      tree: parse(dispatchSrc),
      code: dispatchSrc,
      relPath: "src/dispatch.js",
      language: "javascript",
      chunks: [{ symbolId: "route", startLine: 3, endLine: 6, scope: [] }],
    });

    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/handlers.js", [
      topLevel("onGet", "src/handlers.js"),
      topLevel("onPost", "src/handlers.js"),
      topLevel("run", "src/handlers.js"),
    ]);
    symbolTable.upsertFile("src/dispatch.js", [topLevel("route", "src/dispatch.js")]);

    const runState = new CodegraphRunState();
    for (const [name, table] of Object.entries(dispatch.dispatchTables ?? {})) {
      runState.dispatchTables[name] = [{ relPath: dispatch.relPath, table }];
    }
    Object.assign(runState.callbackParams, handlers.callbackParams);
    const factory = {
      supported: () => ["javascript"],
      create: () => language,
    } as unknown as LanguageFactoryDescriptor;

    const edges = new CallEdgeResolutionRunner(factory, runState)
      .resolve(dispatch, symbolTable)
      .methodEdges.map((e) => `${e.sourceSymbolId}->${e.targetSymbolId}`)
      .sort();
    expect(edges).toEqual([
      // `ROUTES[method](req)` fans out from the caller.
      "route->onGet",
      "route->onPost",
      // `run(req, ROUTES[method])`: the normal callee edge, plus the join —
      // `run` invokes param 1, so the candidates are reached FROM `run`.
      "route->run",
      "run->onGet",
      "run->onPost",
    ]);
  });
});
