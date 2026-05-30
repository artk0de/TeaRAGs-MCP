import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import {
  TSFieldTypeSymbolResolutionStrategy,
  TSGlobalShortNameSymbolResolutionStrategy,
  TSImportBasenameSymbolResolutionStrategy,
  TSImportNarrowedFallbackSymbolResolutionStrategy,
  TSLocalBindingSymbolResolutionStrategy,
  TSNamedImportSymbolResolutionStrategy,
  TSReceiverSymbolSymbolResolutionStrategy,
  TSSuperSymbolResolutionStrategy,
  TSThisMemberSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/typescript/resolver/strategies/index.js";

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

describe("TSSuperSymbolResolutionStrategy", () => {
  const strat = new TSSuperSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "super.init()", receiver: "super", member: "init", startLine: 1 };

  it("continues when the receiver is not `super`", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: "this" }, ctx({ symbolTable, callerScope: ["Child"] }));
    expect(outcome.kind).toBe("continue");
  });

  it("DROPS (not continue) when classExtends has no entry for the enclosing class — bug 4rgg guard", () => {
    const symbolTable = tableWith(["src/child.ts", [sym("Child#init", "init", "src/child.ts", ["Child"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "src/child.ts", callerScope: ["Child"] }));
    // The whole point: a miss here must DROP, never fall through to a later
    // same-file lookup that would emit a self-loop edge.
    expect(outcome.kind).toBe("drop");
  });

  it("resolves to the PARENT class method via the classExtends chain", () => {
    const symbolTable = tableWith(
      ["src/child.ts", [sym("Child#init", "init", "src/child.ts", ["Child"])]],
      ["src/base.ts", [sym("Base#init", "init", "src/base.ts", ["Base"])]],
    );
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerFile: "src/child.ts", callerScope: ["Child"], classExtends: { Child: "Base" } }),
    );
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/base.ts", targetSymbolId: "Base#init" } });
  });
});

describe("TSThisMemberSymbolResolutionStrategy", () => {
  const strat = new TSThisMemberSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "this.read()", receiver: "this", member: "read", startLine: 1 };

  it("resolves `this.X()` against the enclosing class in the SAME file", () => {
    const symbolTable = tableWith(
      ["src/store.ts", [sym("Store#read", "read", "src/store.ts", ["Store"])]],
      ["src/other.ts", [sym("Other#read", "read", "src/other.ts", ["Other"])]],
    );
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "src/store.ts", callerScope: ["Store"] }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/store.ts", targetSymbolId: "Store#read" },
    });
  });

  it("continues when `this.X` is not found in the caller's own file", () => {
    const symbolTable = tableWith(["src/other.ts", [sym("Other#read", "read", "src/other.ts", ["Other"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, callerFile: "src/store.ts", callerScope: ["Store"] }));
    expect(outcome.kind).toBe("continue");
  });
});

describe("TSFieldTypeSymbolResolutionStrategy", () => {
  const strat = new TSFieldTypeSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "this.store.read()", receiver: "this.store", member: "read", startLine: 1 };

  it("resolves `this.field.X()` via the declared field type", () => {
    const symbolTable = tableWith(["src/store.ts", [sym("Store#read", "read", "src/store.ts", ["Store"])]]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, callerScope: ["Service"], classFieldTypes: { Service: { store: "Store" } } }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/store.ts", targetSymbolId: "Store#read" },
    });
  });

  it("continues when the field type is unknown", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(call, ctx({ symbolTable, callerScope: ["Service"] }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues on chained access `this.a.b.x()` (out of scope)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { ...call, receiver: "this.a.b" },
      ctx({ symbolTable, callerScope: ["Service"], classFieldTypes: { Service: { a: "A" } } }),
    );
    expect(outcome.kind).toBe("continue");
  });
});

describe("TSLocalBindingSymbolResolutionStrategy", () => {
  const strat = new TSLocalBindingSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "store.read()", receiver: "store", member: "read", startLine: 1 };

  it("resolves `param.X()` via the walker-bound local type", () => {
    const symbolTable = tableWith(["src/store.ts", [sym("Store#read", "read", "src/store.ts", ["Store"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, localBindings: { store: "Store" } }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/store.ts", targetSymbolId: "Store#read" },
    });
  });

  it("continues when the receiver has no local binding", () => {
    const symbolTable = tableWith(["src/store.ts", [sym("Store#read", "read", "src/store.ts", ["Store"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });
});

describe("TSNamedImportSymbolResolutionStrategy", () => {
  const strat = new TSNamedImportSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "RankModule.run()", receiver: "RankModule", member: "run", startLine: 1 };

  it("resolves via an EXACT named-specifier match", () => {
    const symbolTable = tableWith(["src/rank.ts", [sym("RankModule#run", "run", "src/rank.ts", ["RankModule"])]]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, imports: [{ importText: "./rank.js", importedNames: ["RankModule"] }] }),
    );
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/rank.ts", targetSymbolId: "RankModule#run" },
    });
  });

  it("emits a terminal file-only edge when the member is not indexed (does NOT continue)", () => {
    const symbolTable = tableWith(["src/rank.ts", [sym("RankModule", "RankModule", "src/rank.ts", [])]]);
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, imports: [{ importText: "./rank.js", importedNames: ["RankModule"] }] }),
    );
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/rank.ts", targetSymbolId: null } });
  });

  it("continues when no import carries the receiver in importedNames", () => {
    const symbolTable = tableWith(["src/rank.ts", [sym("RankModule#run", "run", "src/rank.ts", ["RankModule"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, imports: [{ importText: "./rank.js" }] }));
    expect(outcome.kind).toBe("continue");
  });
});

describe("TSImportBasenameSymbolResolutionStrategy", () => {
  const strat = new TSImportBasenameSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "RankModule.run()", receiver: "RankModule", member: "run", startLine: 1 };

  it("resolves via kebab-case → PascalCase basename normalization", () => {
    const symbolTable = tableWith(["src/rank-module.ts", [sym("RankModule#run", "run", "src/rank-module.ts", ["RankModule"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, imports: [{ importText: "./rank-module.js" }] }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/rank-module.ts", targetSymbolId: "RankModule#run" },
    });
  });

  it("continues when no import basename mirrors the receiver", () => {
    const symbolTable = tableWith(["src/unrelated.ts", [sym("RankModule#run", "run", "src/unrelated.ts", ["RankModule"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, imports: [{ importText: "./unrelated.js" }] }));
    expect(outcome.kind).toBe("continue");
  });
});

describe("TSReceiverSymbolSymbolResolutionStrategy", () => {
  const strat = new TSReceiverSymbolSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "Helper.run()", receiver: "Helper", member: "run", startLine: 1 };

  it("resolves to the single file that imports AND declares the receiver", () => {
    const symbolTable = tableWith([
      "src/helper.ts",
      [sym("Helper", "Helper", "src/helper.ts", []), sym("Helper#run", "run", "src/helper.ts", ["Helper"])],
    ]);
    const outcome = strat.attempt(call, ctx({ symbolTable, imports: [{ importText: "./helper.js" }] }));
    expect(outcome).toEqual({
      kind: "resolved",
      target: { targetRelPath: "src/helper.ts", targetSymbolId: "Helper#run" },
    });
  });

  it("continues when the receiver is declared in no imported file", () => {
    const symbolTable = tableWith(["src/helper.ts", [sym("Helper", "Helper", "src/helper.ts", [])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, imports: [] }));
    expect(outcome.kind).toBe("continue");
  });
});

describe("TSGlobalShortNameSymbolResolutionStrategy", () => {
  const strat = new TSGlobalShortNameSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "freeFn()", receiver: undefined, member: "freeFn", startLine: 1 };

  it("resolves a unique global short-name", () => {
    const symbolTable = tableWith(["src/util.ts", [sym("freeFn", "freeFn", "src/util.ts", [])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome).toEqual({ kind: "resolved", target: { targetRelPath: "src/util.ts", targetSymbolId: "freeFn" } });
  });

  it("continues (strict) when the short-name is ambiguous across files", () => {
    const symbolTable = tableWith(
      ["src/a.ts", [sym("freeFn", "freeFn", "src/a.ts", [])]],
      ["src/b.ts", [sym("freeFn", "freeFn", "src/b.ts", [])]],
    );
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });
});

describe("TSImportNarrowedFallbackSymbolResolutionStrategy", () => {
  const strat = new TSImportNarrowedFallbackSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "impl.handle()", receiver: "impl", member: "handle", startLine: 1 };

  it("narrows N>1 ambiguous candidates to the single one the caller imports", () => {
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

  it("continues when the short-name is not ambiguous (N<=1) — leaves the fast path to globalShortName", () => {
    const symbolTable = tableWith(["src/impl-a.ts", [sym("ImplA#handle", "handle", "src/impl-a.ts", ["ImplA"])]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, imports: [{ importText: "./impl-a.js" }] }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the ambiguity cannot be narrowed by imports", () => {
    const symbolTable = tableWith(
      ["src/impl-a.ts", [sym("ImplA#handle", "handle", "src/impl-a.ts", ["ImplA"])]],
      ["src/impl-b.ts", [sym("ImplB#handle", "handle", "src/impl-b.ts", ["ImplB"])]],
    );
    const outcome = strat.attempt(call, ctx({ symbolTable, imports: [{ importText: "./other.js" }] }));
    expect(outcome.kind).toBe("continue");
  });
});
