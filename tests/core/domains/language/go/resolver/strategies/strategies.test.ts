import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  GoGlobalShortNameSymbolResolutionStrategy,
  GoImportMatchSymbolResolutionStrategy,
  GoLocalBindingSymbolResolutionStrategy,
  GoReceiverDropSymbolResolutionStrategy,
  GoReturnTypeBindingSymbolResolutionStrategy,
  type ResolverConfig,
} from "../../../../../../../src/core/domains/language/go/resolver/strategies/index.js";
import { DefaultSymbolIdComposer } from "../../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { composer: new DefaultSymbolIdComposer(), mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[] = []): NamedSymbol => ({
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
  callerFile: "main.go",
  callerScope: [],
  imports: [],
  ...over,
});

describe("GoLocalBindingSymbolResolutionStrategy", () => {
  const strat = new GoLocalBindingSymbolResolutionStrategy(cfg);
  const call: CallRef = { callText: "c.JSON()", receiver: "c", member: "JSON", startLine: 1 };

  it("continues when the call has no receiver", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt({ ...call, receiver: null }, ctx({ symbolTable }));
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the receiver has no localBinding (not this strategy's case)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(call, ctx({ symbolTable, localBindings: {} }));
    expect(outcome.kind).toBe("continue");
  });

  it("resolves the instance form `Type#member` when localBinding names the type", () => {
    const symbolTable = tableWith(["context.go", [sym("Context#JSON", "JSON", "context.go")]]);
    const outcome = strat.attempt(call, ctx({ symbolTable, localBindings: { c: [{ line: 1, type: "Context" }] } }));
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind === "resolved") {
      expect(outcome.target.targetSymbolId).toBe("Context#JSON");
      expect(outcome.target.targetRelPath).toBe("context.go");
    }
  });

  it("falls back to the static form `Type.member` when the instance form is absent", () => {
    const symbolTable = tableWith(["ctx.go", [sym("Context.helper", "helper", "ctx.go")]]);
    const outcome = strat.attempt(
      { callText: "c.helper()", receiver: "c", member: "helper", startLine: 1 },
      ctx({ symbolTable, localBindings: { c: [{ line: 1, type: "Context" }] } }),
    );
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind === "resolved") expect(outcome.target.targetSymbolId).toBe("Context.helper");
  });

  it("DROPS (not continue) when the bound type does NOT define the member — no global fallback", () => {
    // Symbol exists under a DIFFERENT type; a global short-name fallback would
    // fabricate the edge. The guard must DROP instead (bd tea-rags-mcp-e6xx).
    const symbolTable = tableWith(["other.go", [sym("Other#unrelated", "unrelated", "other.go")]]);
    const outcome = strat.attempt(
      { callText: "c.unrelated()", receiver: "c", member: "unrelated", startLine: 1 },
      ctx({ symbolTable, localBindings: { c: [{ line: 1, type: "Context" }] } }),
    );
    expect(outcome.kind).toBe("drop");
  });
});

describe("GoReturnTypeBindingSymbolResolutionStrategy", () => {
  const strat = new GoReturnTypeBindingSymbolResolutionStrategy(cfg);

  it("continues when the call has no receiver", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "New()", receiver: null, member: "New", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the receiver has no localCallBinding", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "engine.Use()", receiver: "engine", member: "Use", startLine: 1 },
      ctx({ symbolTable, localCallBindings: {} }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the called func has no recorded return type (fall through to import path)", () => {
    const symbolTable = tableWith(["gin.go", [sym("Engine#Use", "Use", "gin.go")]]);
    const outcome = strat.attempt(
      { callText: "engine.Use()", receiver: "engine", member: "Use", startLine: 1 },
      ctx({ symbolTable, localCallBindings: { engine: "Mystery" }, functionReturnTypes: {} }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the return type is NOT a concrete type symbol (interface/builtin gate)", () => {
    // `Handler` is an interface with no type symbol — only a method symbol on an
    // unrelated type exists. The gate must SKIP (continue), never bind.
    const symbolTable = tableWith(["other.go", [sym("Server#ServeHTTP", "ServeHTTP", "other.go")]]);
    const outcome = strat.attempt(
      { callText: "x.ServeHTTP()", receiver: "x", member: "ServeHTTP", startLine: 1 },
      ctx({ symbolTable, localCallBindings: { x: "Unknown" }, functionReturnTypes: { Unknown: "Handler" } }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("resolves via engine→New→Engine when the return type is a concrete type symbol", () => {
    const symbolTable = tableWith(["gin.go", [sym("Engine", "Engine", "gin.go"), sym("Engine#Use", "Use", "gin.go")]]);
    const outcome = strat.attempt(
      { callText: "engine.Use()", receiver: "engine", member: "Use", startLine: 1 },
      ctx({ symbolTable, localCallBindings: { engine: "New" }, functionReturnTypes: { New: "Engine" } }),
    );
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind === "resolved") expect(outcome.target.targetSymbolId).toBe("Engine#Use");
  });

  it("DROPS when the type is bound (gate passes) but the type does NOT define the member", () => {
    // engine→New→Engine binds the TYPE, but Engine has no `Frobnicate`; a method
    // of that name on an unrelated type must NOT be fabricated. Mirrors m46z drop.
    const symbolTable = tableWith(
      ["gin.go", [sym("Engine", "Engine", "gin.go"), sym("Engine#Use", "Use", "gin.go")]],
      ["other.go", [sym("Other#Frobnicate", "Frobnicate", "other.go")]],
    );
    const outcome = strat.attempt(
      { callText: "engine.Frobnicate()", receiver: "engine", member: "Frobnicate", startLine: 1 },
      ctx({ symbolTable, localCallBindings: { engine: "New" }, functionReturnTypes: { New: "Engine" } }),
    );
    expect(outcome.kind).toBe("drop");
  });
});

describe("GoImportMatchSymbolResolutionStrategy", () => {
  const strat = new GoImportMatchSymbolResolutionStrategy(cfg);

  it("continues when the call has no receiver", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "Func()", receiver: null, member: "Func", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("resolves `pkg.Func()` to a file whose path contains the import suffix", () => {
    const symbolTable = tableWith(["foo/bar/x.go", [sym("Func", "Func", "foo/bar/x.go")]]);
    const outcome = strat.attempt(
      { callText: "bar.Func()", receiver: "bar", member: "Func", startLine: 1 },
      ctx({ symbolTable, imports: [{ importText: "foo/bar", startLine: 1 }] }),
    );
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind === "resolved") expect(outcome.target.targetRelPath).toBe("foo/bar/x.go");
  });

  it("continues when no import's last segment matches the receiver", () => {
    const symbolTable = tableWith(["foo/bar/x.go", [sym("Func", "Func", "foo/bar/x.go")]]);
    const outcome = strat.attempt(
      { callText: "baz.Func()", receiver: "baz", member: "Func", startLine: 1 },
      ctx({ symbolTable, imports: [{ importText: "foo/bar", startLine: 1 }] }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the import matches but no candidate file carries the suffix", () => {
    // import matches receiver, but the only `Func` lives outside `foo/bar`.
    const symbolTable = tableWith(["unrelated/x.go", [sym("Func", "Func", "unrelated/x.go")]]);
    const outcome = strat.attempt(
      { callText: "bar.Func()", receiver: "bar", member: "Func", startLine: 1 },
      ctx({ symbolTable, imports: [{ importText: "foo/bar", startLine: 1 }] }),
    );
    expect(outcome.kind).toBe("continue");
  });
});

describe("GoReceiverDropSymbolResolutionStrategy", () => {
  const strat = new GoReceiverDropSymbolResolutionStrategy(cfg);

  it("continues when the call has no receiver (lets the global fallback run)", () => {
    const symbolTable = tableWith();
    const outcome = strat.attempt(
      { callText: "Func()", receiver: null, member: "Func", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("DROPS a receiver-present call that reached this terminal guard — no global short-name fabrication", () => {
    // gin parity: `c.Request.URL.Query()` matched no localBinding/returnType/import.
    // A unique `Context#Query` would otherwise be fabricated — must DROP (m46z).
    const symbolTable = tableWith(["context.go", [sym("Context#Query", "Query", "context.go")]]);
    const outcome = strat.attempt(
      { callText: "c.Request.URL.Query()", receiver: "c.Request.URL", member: "Query", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("drop");
  });
});

describe("GoGlobalShortNameSymbolResolutionStrategy", () => {
  const strat = new GoGlobalShortNameSymbolResolutionStrategy(cfg);

  it("continues when the call HAS a receiver (not this strategy's case)", () => {
    const symbolTable = tableWith(["helpers.go", [sym("Util", "Util", "helpers.go")]]);
    const outcome = strat.attempt(
      { callText: "x.Util()", receiver: "x", member: "Util", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("resolves a unique no-receiver short name (top-level helper)", () => {
    const symbolTable = tableWith(["helpers.go", [sym("Util", "Util", "helpers.go")]]);
    const outcome = strat.attempt(
      { callText: "Util()", receiver: null, member: "Util", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("resolved");
    if (outcome.kind === "resolved") expect(outcome.target.targetRelPath).toBe("helpers.go");
  });

  it("continues when the no-receiver short name is ambiguous under strict mode", () => {
    const symbolTable = tableWith(["a.go", [sym("Func", "Func", "a.go")]], ["b.go", [sym("Func", "Func", "b.go")]]);
    const outcome = strat.attempt(
      { callText: "Func()", receiver: null, member: "Func", startLine: 1 },
      ctx({ symbolTable }),
    );
    expect(outcome.kind).toBe("continue");
  });
});
