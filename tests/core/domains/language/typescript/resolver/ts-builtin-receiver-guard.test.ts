import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  TSGlobalShortNameSymbolResolutionStrategy,
  TSImportNarrowedFallbackSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../src/core/domains/language/typescript/resolver/strategies/index.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { tsOptions: { baseUrl: ".", paths: {} }, mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const tableWith = (...files: [string, NamedSymbol[]][]): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "src/caller.ts",
  callerScope: [],
  imports: [],
  ...over,
});

/** The project defines exactly one symbol per builtin-colliding short name. */
const collidingTable = (): InMemoryGlobalSymbolTable =>
  tableWith(
    ["src/decoder.ts", [sym("DaemonFrameDecoder#push", "push", "src/decoder.ts", ["DaemonFrameDecoder"])]],
    ["src/memo.ts", [sym("CommitDiffMemo#set", "set", "src/memo.ts", ["CommitDiffMemo"])]],
    ["src/registry.ts", [sym("TrajectoryRegistry#has", "has", "src/registry.ts", ["TrajectoryRegistry"])]],
    ["src/renderer.ts", [sym("JsonProgressRenderer#error", "error", "src/renderer.ts", ["JsonProgressRenderer"])]],
  );

/**
 * bd tea-rags-mcp-6b3gj — pre-resolution builtin-receiver guard.
 *
 * INVARIANT: a bare member name is never matched against the global symbol
 * table when the call provably (or, for an untyped receiver, near-certainly)
 * targets the JS runtime. `targetsExternalImport` already knew how to say so,
 * but only ran on calls that had ALREADY failed resolution — so a phantom edge
 * (`arr.push()` → an unrelated project `push`) was emitted before the
 * classifier ever saw the call. The guard runs BEFORE the match and CONTINUEs,
 * leaving the call to the later type-checker passes and, failing those, to the
 * external classifier.
 */
describe("TSGlobalShortNameSymbolResolutionStrategy — builtin-receiver guard (bd tea-rags-mcp-6b3gj)", () => {
  const strat = new TSGlobalShortNameSymbolResolutionStrategy(cfg);

  it("continues instead of matching a project `error` for an ambient global receiver (console.error(msg))", () => {
    const call: CallRef = { callText: "console.error(msg)", receiver: "console", member: "error", startLine: 4 };
    const outcome = strat.attempt(call, ctx({ symbolTable: collidingTable() }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues for a receiver whose bound type is a builtin (const m = new Map(); m.set(k, v))", () => {
    const call: CallRef = { callText: "m.set(k, v)", receiver: "m", member: "set", startLine: 9 };
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable: collidingTable(), localBindings: { m: [{ line: 2, type: "Map" }] } }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues for a `this.field` whose declared type is a builtin (this.pending.set(k, v))", () => {
    const call: CallRef = { callText: "this.pending.set(k, v)", receiver: "this.pending", member: "set", startLine: 9 };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable: collidingTable(),
        callerScope: ["Service"],
        classFieldTypes: { Service: { pending: "Map" } },
      }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues for a `ReadonlySet`-annotated receiver — a Set instance under a read-only view (KEYWORDS.has(w))", () => {
    const call: CallRef = { callText: "KEYWORDS.has(w)", receiver: "KEYWORDS", member: "has", startLine: 9 };
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable: collidingTable(), localBindings: { KEYWORDS: [{ line: 2, type: "ReadonlySet" }] } }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues for a `ReadonlyMap`-annotated receiver (index.get(k))", () => {
    const call: CallRef = { callText: "index.get(k)", receiver: "index", member: "get", startLine: 9 };
    const symbolTable = tableWith(["src/store.ts", [sym("Store#get", "get", "src/store.ts", ["Store"])]]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, localBindings: { index: [{ line: 2, type: "ReadonlyMap" }] } }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues for an UNTYPED receiver whose member is builtin-only vocabulary (const out = []; out.push(x))", () => {
    const call: CallRef = { callText: "out.push(x)", receiver: "out", member: "push", startLine: 9 };
    const outcome = strat.attempt(call, ctx({ symbolTable: collidingTable() }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues for an UNTYPED module-level constant asked for membership (KEYWORDS.has(w))", () => {
    const call: CallRef = { callText: "KEYWORDS.has(w)", receiver: "KEYWORDS", member: "has", startLine: 9 };
    const outcome = strat.attempt(call, ctx({ symbolTable: collidingTable() }));
    expect(outcome.kind).toBe("continue");
  });

  it("STILL resolves `has` on a receiver typed as a project registry (const r = new Registry(); r.has(k))", () => {
    const call: CallRef = { callText: "r.has(k)", receiver: "r", member: "has", startLine: 9 };
    const symbolTable = tableWith(["src/registry.ts", [sym("Registry#has", "has", "src/registry.ts", ["Registry"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, localBindings: { r: [{ line: 2, type: "Registry" }] } }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/registry.ts", targetSymbolId: "Registry#has" },
    });
  });

  it("STILL resolves `get`/`set` on an untyped receiver — deliberately outside the vocabulary (cfg.set(k, v))", () => {
    const call: CallRef = { callText: "cfg.set(k, v)", receiver: "cfg", member: "set", startLine: 9 };
    const symbolTable = tableWith(["src/config.ts", [sym("Config#set", "set", "src/config.ts", ["Config"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/config.ts", targetSymbolId: "Config#set" },
    });
  });

  it("continues for a receiver bound to an external package import (fs.readFile(p) via node:fs)", () => {
    const call: CallRef = { callText: "fs.readFile(p)", receiver: "fs", member: "readFile", startLine: 9 };
    const symbolTable = tableWith(["src/io.ts", [sym("readFile", "readFile", "src/io.ts", [])]]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, imports: [{ importText: "node:fs", startLine: 1, importedNames: ["fs"] }] }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("STILL resolves when the receiver's bound type is a project class (const s = new Stack(); s.push(x))", () => {
    const call: CallRef = { callText: "s.push(x)", receiver: "s", member: "push", startLine: 9 };
    const symbolTable = tableWith(["src/stack.ts", [sym("Stack#push", "push", "src/stack.ts", ["Stack"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, localBindings: { s: [{ line: 2, type: "Stack" }] } }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/stack.ts", targetSymbolId: "Stack#push" },
    });
  });

  it("STILL resolves an untyped receiver whose member is NOT builtin vocabulary (svc.handle(req))", () => {
    const call: CallRef = { callText: "svc.handle(req)", receiver: "svc", member: "handle", startLine: 9 };
    const symbolTable = tableWith(["src/svc.ts", [sym("Service#handle", "handle", "src/svc.ts", ["Service"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/svc.ts", targetSymbolId: "Service#handle" },
    });
  });

  it("STILL resolves a free call sharing a builtin member name (push(x) with no receiver)", () => {
    const call: CallRef = { callText: "push(x)", receiver: null, member: "push", startLine: 9 };
    const symbolTable = tableWith(["src/queue.ts", [sym("push", "push", "src/queue.ts", [])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/queue.ts", targetSymbolId: "push" } });
  });

  it("STILL resolves a `this` self-call sharing a builtin member name (this.push(x))", () => {
    const call: CallRef = { callText: "this.push(x)", receiver: "this", member: "push", startLine: 9 };
    const symbolTable = tableWith(["src/queue.ts", [sym("Queue#push", "push", "src/queue.ts", ["Queue"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "src/queue.ts", callerScope: ["Queue"] }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/queue.ts", targetSymbolId: "Queue#push" },
    });
  });
});

/**
 * bd tea-rags-mcp-6b3gj — the same guard on the import-narrowed fallback. This
 * pass exists to break N>1 ambiguity with the caller's import list, which is
 * precisely the shape that turns a builtin call into a confident wrong answer.
 */
describe("TSImportNarrowedFallbackSymbolResolutionStrategy — builtin-receiver guard (bd tea-rags-mcp-6b3gj)", () => {
  const strat = new TSImportNarrowedFallbackSymbolResolutionStrategy(cfg);

  const ambiguous = (): InMemoryGlobalSymbolTable =>
    tableWith(
      ["src/impl-a.ts", [sym("ImplA#push", "push", "src/impl-a.ts", ["ImplA"])]],
      ["src/impl-b.ts", [sym("ImplB#push", "push", "src/impl-b.ts", ["ImplB"])]],
    );

  it("continues for an untyped builtin-vocabulary member even when one candidate is imported (out.push(x))", () => {
    const call: CallRef = { callText: "out.push(x)", receiver: "out", member: "push", startLine: 9 };
    const outcome = strat.attempt(call, ctx({ symbolTable: ambiguous(), imports: [{ importText: "./impl-a.js" }] }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues for a builtin-typed receiver even when one candidate is imported (const m = new Map(); m.push(x))", () => {
    const call: CallRef = { callText: "m.push(x)", receiver: "m", member: "push", startLine: 9 };
    const outcome = strat.attempt(
      call,
      ctx({
        symbolTable: ambiguous(),
        imports: [{ importText: "./impl-a.js" }],
        localBindings: { m: [{ line: 2, type: "Map" }] },
      }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("STILL narrows an ordinary interface-dispatch receiver to the imported implementer (impl.handle(req))", () => {
    const call: CallRef = { callText: "impl.handle(req)", receiver: "impl", member: "handle", startLine: 9 };
    const symbolTable = tableWith(
      ["src/impl-a.ts", [sym("ImplA#handle", "handle", "src/impl-a.ts", ["ImplA"])]],
      ["src/impl-b.ts", [sym("ImplB#handle", "handle", "src/impl-b.ts", ["ImplB"])]],
    );
    const outcome = strat.attempt(call, ctx({ symbolTable, imports: [{ importText: "./impl-a.js" }] }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/impl-a.ts", targetSymbolId: "ImplA#handle" },
    });
  });
});

/**
 * bd tea-rags-mcp-6b3gj — end to end through the whole chain, which is where
 * the phantom edge was actually observed: the oracle
 * (`scripts/ts-codegraph-typechecker-oracle.ts`) found 1341 of these on
 * tea-rags-mcp's own `src/`, every one of them a bare member name matched to
 * the single project symbol that happened to share it.
 */
describe("TSCallResolver.resolve — no phantom edge for a builtin receiver (bd tea-rags-mcp-6b3gj)", () => {
  const resolver = new TSCallResolver({ baseUrl: ".", paths: {} }, DEFAULT_AMBIGUOUS_RESOLVE_MODE);

  it("declines console.error(msg) rather than emitting an edge to the project's own `error`", () => {
    const call: CallRef = { callText: "console.error(msg)", receiver: "console", member: "error", startLine: 4 };
    expect(resolver.resolve(call, ctx({ symbolTable: collidingTable() }))).toBeNull();
  });

  it("declines out.push(x) rather than emitting an edge to the project's own `push`", () => {
    const call: CallRef = { callText: "out.push(x)", receiver: "out", member: "push", startLine: 9 };
    expect(resolver.resolve(call, ctx({ symbolTable: collidingTable() }))).toBeNull();
  });

  it("declines this.pending.set(k, v) rather than emitting an edge to the project's own `set`", () => {
    const call: CallRef = { callText: "this.pending.set(k, v)", receiver: "this.pending", member: "set", startLine: 9 };
    const context = ctx({
      symbolTable: collidingTable(),
      callerScope: ["Service"],
      classFieldTypes: { Service: { pending: "Map" } },
    });
    expect(resolver.resolve(call, context)).toBeNull();
  });

  it("still emits the real edge for a project-typed receiver sharing the name (const s = new Stack(); s.push(x))", () => {
    const call: CallRef = { callText: "s.push(x)", receiver: "s", member: "push", startLine: 9 };
    const symbolTable = tableWith(["src/stack.ts", [sym("Stack#push", "push", "src/stack.ts", ["Stack"])]]);
    const context = ctx({ symbolTable, localBindings: { s: [{ line: 2, type: "Stack" }] } });
    expect(resolver.resolve(call, context)).toEqual({
      targetRelPath: "src/stack.ts",
      targetSymbolId: "Stack#push",
    });
  });
});

/**
 * bd tea-rags-mcp-6b3gj — the classifier half of the same decision. A call the
 * guard refuses to resolve because it targets a builtin must ALSO be counted
 * external, or `resolveSuccessRate` punishes the resolver for being right: the
 * call leaves the numerator while staying in the denominator.
 */
describe("TSCallResolver.targetsExternalImport — builtin member on an untyped receiver (bd tea-rags-mcp-6b3gj)", () => {
  const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });

  it("flags an untyped receiver whose member is builtin-only vocabulary (out.push(x))", () => {
    const call: CallRef = { callText: "out.push(x)", receiver: "out", member: "push", startLine: 9 };
    expect(resolver.targetsExternalImport(call, ctx({ symbolTable: new InMemoryGlobalSymbolTable() }))).toBe(true);
  });

  it("does NOT flag an untyped receiver whose member is ordinary project vocabulary (svc.handle(req))", () => {
    const call: CallRef = { callText: "svc.handle(req)", receiver: "svc", member: "handle", startLine: 9 };
    expect(resolver.targetsExternalImport(call, ctx({ symbolTable: new InMemoryGlobalSymbolTable() }))).toBe(false);
  });

  it("does NOT flag a builtin-named member on a receiver typed as a project class (s: Stack; s.push(x))", () => {
    const call: CallRef = { callText: "s.push(x)", receiver: "s", member: "push", startLine: 9 };
    const context = ctx({
      symbolTable: new InMemoryGlobalSymbolTable(),
      localBindings: { s: [{ line: 2, type: "Stack" }] },
    });
    expect(resolver.targetsExternalImport(call, context)).toBe(false);
  });

  it("does NOT flag a free call sharing a builtin member name (push(x) with no receiver)", () => {
    const call: CallRef = { callText: "push(x)", receiver: null, member: "push", startLine: 9 };
    expect(resolver.targetsExternalImport(call, ctx({ symbolTable: new InMemoryGlobalSymbolTable() }))).toBe(false);
  });
});
