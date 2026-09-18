import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type NamedSymbol,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoCallResolver } from "../../../../../../src/core/domains/language/go/resolver/go-resolver.js";
import { GoReceiverChainSymbolResolutionStrategy } from "../../../../../../src/core/domains/language/go/resolver/strategies/index.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-e6xx — Go field chains. `c.writermem.reset(w)` inside a
 * `Context` method is a call of `responseWriter#reset`: `c` is typed by the
 * receiver, `writermem` by `Context`'s field declaration. The receiver is
 * dotted, so it never matched a local binding or an import, and the terminal
 * guard dropped it. Fixtures are shaped after gin's `context.go` / `gin.go` /
 * `routergroup.go`, with struct facts published the way the walker publishes
 * them (`<relPath>::<Type>` on `classFieldTypesByClassKey`).
 */

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

function ginTable(): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile("context.go", [sym("Context", "context.go"), sym("Context#Next", "context.go")]);
  t.upsertFile("response_writer.go", [
    sym("ResponseWriter", "response_writer.go"),
    sym("responseWriter", "response_writer.go"),
    sym("responseWriter#reset", "response_writer.go"),
    sym("responseWriter#Header", "response_writer.go"),
  ]);
  t.upsertFile("gin.go", [sym("Engine", "gin.go"), sym("New", "gin.go"), sym("HandlersChain#Last", "gin.go")]);
  t.upsertFile("routergroup.go", [sym("RouterGroup", "routergroup.go"), sym("RouterGroup#GET", "routergroup.go")]);
  t.upsertFile("tree.go", [sym("methodTrees", "tree.go"), sym("methodTrees#get", "tree.go")]);
  return t;
}

const GIN_FIELDS: Record<string, Record<string, string>> = {
  "context.go::Context": {
    writermem: "responseWriter",
    Writer: "ResponseWriter",
    Request: "http.Request",
    engine: "Engine",
    handlers: "HandlersChain",
    Keys: "",
  },
  "response_writer.go::responseWriter": {
    ResponseWriter: "http.ResponseWriter",
    "embedded:ResponseWriter": "http.ResponseWriter",
    size: "int",
  },
  "gin.go::Engine": { RouterGroup: "RouterGroup", "embedded:RouterGroup": "RouterGroup", trees: "methodTrees" },
  "routergroup.go::RouterGroup": { Handlers: "HandlersChain", engine: "Engine" },
};

function contextCtx(over: Partial<CallContext> = {}): CallContext {
  return {
    callerFile: "context.go",
    callerScope: [],
    imports: [],
    symbolTable: ginTable(),
    localBindings: { c: [{ line: 1, type: "Context" }], engine: [{ line: 1, type: "Engine" }] },
    classFieldTypesByClassKey: GIN_FIELDS,
    ...over,
  };
}

const call = (receiver: string, member: string): CallRef => ({
  callText: `${receiver}.${member}()`,
  receiver,
  member,
  startLine: 5,
});

const resolver = new GoCallResolver(new DefaultSymbolIdComposer());

describe("GoCallResolver — receivers typed through struct fields", () => {
  it("resolves `c.writermem.reset(w)` to responseWriter#reset (gin context.go)", () => {
    expect(resolver.resolve(call("c.writermem", "reset"), contextCtx())).toEqual({
      targetRelPath: "response_writer.go",
      targetSymbolId: "responseWriter#reset",
    });
  });

  it("types a field of a named non-struct type: `c.handlers.Last()` → HandlersChain#Last", () => {
    expect(resolver.resolve(call("c.handlers", "Last"), contextCtx())?.targetSymbolId).toBe("HandlersChain#Last");
  });

  it("walks several hops: `c.engine.trees.get(m)` → methodTrees#get", () => {
    expect(resolver.resolve(call("c.engine.trees", "get"), contextCtx())?.targetSymbolId).toBe("methodTrees#get");
  });

  it("promotes the final call through embedding: `c.engine.GET()` → RouterGroup#GET", () => {
    expect(resolver.resolve(call("c.engine", "GET"), contextCtx())?.targetSymbolId).toBe("RouterGroup#GET");
  });

  it("reads a field PROMOTED from an embedded struct: `engine.Handlers.Last()` → HandlersChain#Last", () => {
    expect(resolver.resolve(call("engine.Handlers", "Last"), contextCtx())?.targetSymbolId).toBe("HandlersChain#Last");
  });

  it("types the head through a return-type binding: `e := New(); e.trees.get()`", () => {
    const ctx = contextCtx({
      localBindings: undefined,
      localCallBindings: { e: "New" },
      functionReturnTypes: { New: "Engine" },
    });
    expect(resolver.resolve(call("e.trees", "get"), ctx)?.targetSymbolId).toBe("methodTrees#get");
  });

  it("NEGATIVE: a package-qualified field type resolves nothing (`c.Request.Context()`)", () => {
    const t = ginTable();
    t.upsertFile("req.go", [sym("Request", "req.go"), sym("Request#Context", "req.go")]);
    expect(resolver.resolve(call("c.Request", "Context"), contextCtx({ symbolTable: t }))).toBeNull();
  });

  it("NEGATIVE: an interface-typed field drops rather than guessing an implementer (`c.Writer.Header()`)", () => {
    // responseWriter#Header is the ONLY `Header` in the table — a short-name
    // fallback would pick it. The interface itself declares no symbol.
    expect(resolver.resolve(call("c.Writer", "Header"), contextCtx())).toBeNull();
  });

  it("NEGATIVE: an untyped head drops with no short-name fallback", () => {
    expect(resolver.resolve(call("x.writermem", "reset"), contextCtx())).toBeNull();
  });

  it("NEGATIVE: an unknown field stops the walk", () => {
    expect(resolver.resolve(call("c.missing", "reset"), contextCtx())).toBeNull();
  });

  it("NEGATIVE: a field whose type is not nominal types nothing (`c.Keys`)", () => {
    expect(resolver.resolve(call("c.Keys", "reset"), contextCtx())).toBeNull();
  });

  it("NEGATIVE: a METHOD hop is not a field — its result is not typed (`c.engine.Clone().trees`)", () => {
    const t = ginTable();
    t.upsertFile("gin2.go", [sym("Engine#Clone", "gin2.go")]);
    expect(resolver.resolve(call("c.engine.Clone().trees", "get"), contextCtx({ symbolTable: t }))).toBeNull();
  });
});

describe("GoReceiverChainSymbolResolutionStrategy", () => {
  const strat = new GoReceiverChainSymbolResolutionStrategy({
    composer: new DefaultSymbolIdComposer(),
    mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  });

  it("continues on a bare call — not a receiver it types", () => {
    expect(strat.attempt({ ...call("c", "Next"), receiver: null }, contextCtx()).kind).toBe("continue");
  });

  it("continues on a single-identifier receiver — the binding passes before it own that", () => {
    expect(strat.attempt(call("c", "Next"), contextCtx()).kind).toBe("continue");
  });

  it("continues on a dotted receiver whose head it cannot type (a package, say)", () => {
    expect(strat.attempt(call("json.API", "Marshal"), contextCtx()).kind).toBe("continue");
  });

  it("drops a typed chain whose final type does not declare the member", () => {
    expect(strat.attempt(call("c.writermem", "Frobnicate"), contextCtx()).kind).toBe("drop");
  });
});
