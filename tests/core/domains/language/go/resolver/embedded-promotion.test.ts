import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoCallResolver } from "../../../../../../src/core/domains/language/go/resolver/go-resolver.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-e6xx — Go method promotion through struct embedding. gin's
 * `Engine` embeds `RouterGroup`, so `engine.GET(...)` and gin's own
 * `engine.combineHandlers(...)` dispatch to `RouterGroup#GET` /
 * `RouterGroup#combineHandlers`: `Engine` declares neither. Before this the
 * typed-receiver guard found no `Engine#GET` and DROPPED the edge.
 *
 * The struct facts arrive the way the walker publishes them: the run-global
 * `classFieldTypesByClassKey`, keyed `<relPath>::<Type>`, with an embedded field
 * marked by an `embedded:<name>` key.
 */

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

function ginTable(extra: [string, NamedSymbol[]][] = []): InMemoryGlobalSymbolTable {
  const t = new InMemoryGlobalSymbolTable();
  t.upsertFile("gin.go", [
    sym("Engine", "gin.go"),
    sym("New", "gin.go"),
    sym("Engine#Use", "gin.go"),
    sym("Engine#addRoute", "gin.go"),
  ]);
  t.upsertFile("routergroup.go", [
    sym("RouterGroup", "routergroup.go"),
    sym("RouterGroup#GET", "routergroup.go"),
    sym("RouterGroup#Use", "routergroup.go"),
    sym("RouterGroup#combineHandlers", "routergroup.go"),
  ]);
  for (const [relPath, defs] of extra) t.upsertFile(relPath, defs);
  return t;
}

const GIN_FIELDS: Record<string, Record<string, string>> = {
  "gin.go::Engine": {
    RouterGroup: "RouterGroup",
    "embedded:RouterGroup": "RouterGroup",
    trees: "methodTrees",
  },
  "routergroup.go::RouterGroup": { Handlers: "HandlersChain", basePath: "string", engine: "Engine", root: "bool" },
};

function engineCtx(over: Partial<CallContext> = {}): CallContext {
  return {
    callerFile: "gin.go",
    callerScope: [],
    imports: [],
    symbolTable: ginTable(),
    localBindings: { engine: [{ line: 1, type: "Engine" }] },
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

describe("GoCallResolver — method promotion through struct embedding", () => {
  it("resolves `engine.combineHandlers` on a typed `*Engine` to RouterGroup#combineHandlers", () => {
    expect(resolver.resolve(call("engine", "combineHandlers"), engineCtx())).toEqual({
      targetRelPath: "routergroup.go",
      targetSymbolId: "RouterGroup#combineHandlers",
    });
  });

  it("resolves `engine.GET` bound through `engine := New()` to RouterGroup#GET", () => {
    const ctx = engineCtx({
      localBindings: undefined,
      localCallBindings: { engine: "New" },
      functionReturnTypes: { "::New": "Engine" },
    });
    expect(resolver.resolve(call("engine", "GET"), ctx)?.targetSymbolId).toBe("RouterGroup#GET");
  });

  it("keeps the outer type's own method over a promoted namesake (Engine#Use, not RouterGroup#Use)", () => {
    expect(resolver.resolve(call("engine", "Use"), engineCtx())?.targetSymbolId).toBe("Engine#Use");
  });

  it("promotes through a chain of embeddings, the shallowest definer winning", () => {
    const t = ginTable([
      ["server.go", [sym("Server", "server.go"), sym("Base", "server.go"), sym("Base#GET", "server.go")]],
    ]);
    const ctx = engineCtx({
      symbolTable: t,
      localBindings: { s: [{ line: 1, type: "Server" }] },
      classFieldTypesByClassKey: {
        ...GIN_FIELDS,
        // Server embeds Engine (depth 1) and Base (depth 1); only Engine's
        // embedded RouterGroup (depth 2) and Base (depth 1) define GET, so the
        // depth-1 Base wins.
        "server.go::Server": {
          Engine: "Engine",
          "embedded:Engine": "Engine",
          Base: "Base",
          "embedded:Base": "Base",
        },
        "server.go::Base": {},
      },
    });
    expect(resolver.resolve(call("s", "GET"), ctx)?.targetSymbolId).toBe("Base#GET");
  });

  it("reaches a depth-2 definer when nothing shallower declares the member", () => {
    const t = ginTable([["server.go", [sym("Server", "server.go")]]]);
    const ctx = engineCtx({
      symbolTable: t,
      localBindings: { s: [{ line: 1, type: "Server" }] },
      classFieldTypesByClassKey: {
        ...GIN_FIELDS,
        "server.go::Server": { Engine: "Engine", "embedded:Engine": "Engine" },
      },
    });
    expect(resolver.resolve(call("s", "combineHandlers"), ctx)?.targetSymbolId).toBe("RouterGroup#combineHandlers");
  });

  it("NEGATIVE: a named field that merely shares its type's name promotes nothing", () => {
    // `RouterGroup RouterGroup` is a named field: `engine.GET` does not compile
    // against it, so the resolver must not invent the promotion.
    const ctx = engineCtx({ classFieldTypesByClassKey: { "gin.go::Engine": { RouterGroup: "RouterGroup" } } });
    expect(resolver.resolve(call("engine", "GET"), ctx)).toBeNull();
  });

  it("NEGATIVE: two embedded types declaring the member at the same depth is ambiguous", () => {
    const t = ginTable([["other.go", [sym("Other", "other.go"), sym("Other#GET", "other.go")]]]);
    const ctx = engineCtx({
      symbolTable: t,
      classFieldTypesByClassKey: {
        ...GIN_FIELDS,
        "gin.go::Engine": {
          RouterGroup: "RouterGroup",
          "embedded:RouterGroup": "RouterGroup",
          Other: "Other",
          "embedded:Other": "Other",
        },
        "other.go::Other": {},
      },
    });
    expect(resolver.resolve(call("engine", "GET"), ctx)).toBeNull();
  });

  it("NEGATIVE: an opaque embedded sibling (external type) stops the walk before a deeper definer", () => {
    // `*http.Server` might itself declare `GET`; the project cannot see into
    // it, so a definer two levels down must not be selected past it.
    const t = ginTable([["server.go", [sym("Server", "server.go")]]]);
    const ctx = engineCtx({
      symbolTable: t,
      localBindings: { s: [{ line: 1, type: "Server" }] },
      classFieldTypesByClassKey: {
        ...GIN_FIELDS,
        "server.go::Server": {
          Engine: "Engine",
          "embedded:Engine": "Engine",
          Server: "http.Server",
          "embedded:Server": "http.Server",
        },
      },
    });
    expect(resolver.resolve(call("s", "combineHandlers"), ctx)).toBeNull();
  });

  it("NEGATIVE: a field of the member's name at a shallower depth shadows a promoted method", () => {
    const ctx = engineCtx({
      classFieldTypesByClassKey: {
        ...GIN_FIELDS,
        "gin.go::Engine": { ...GIN_FIELDS["gin.go::Engine"], combineHandlers: "" },
      },
    });
    expect(resolver.resolve(call("engine", "combineHandlers"), ctx)).toBeNull();
  });

  it("NEGATIVE: an embedding cycle terminates without an edge", () => {
    const t = ginTable([["cycle.go", [sym("A", "cycle.go"), sym("B", "cycle.go")]]]);
    const ctx = engineCtx({
      symbolTable: t,
      localBindings: { a: [{ line: 1, type: "A" }] },
      classFieldTypesByClassKey: {
        "cycle.go::A": { B: "B", "embedded:B": "B" },
        "cycle.go::B": { A: "A", "embedded:A": "A" },
      },
    });
    expect(resolver.resolve(call("a", "Missing"), ctx)).toBeNull();
  });

  it("NEGATIVE: a method found on an embedded type with a namesake in another package is ambiguous", () => {
    // `app.Engine2` embeds `app.Base`, which embeds `app.Inner` (the real
    // definer of `Reset`). `other.Base` also exists and declares `Reset`: the
    // id `Base#Reset` cannot tell the two `Base`s apart, so the depth-1 hit is
    // as likely the other package's method as a promotion of this one.
    const t = ginTable([
      [
        "app/app.go",
        [
          sym("Engine2", "app/app.go"),
          sym("Base", "app/app.go"),
          sym("Inner", "app/app.go"),
          sym("Inner#Reset", "app/app.go"),
        ],
      ],
      ["other/other.go", [sym("Base", "other/other.go"), sym("Base#Reset", "other/other.go")]],
    ]);
    const ctx = engineCtx({
      symbolTable: t,
      callerFile: "app/app.go",
      localBindings: { e: [{ line: 1, type: "Engine2" }] },
      classFieldTypesByClassKey: {
        "app/app.go::Engine2": { Base: "Base", "embedded:Base": "Base" },
        "app/app.go::Base": { Inner: "Inner", "embedded:Inner": "Inner" },
        "app/app.go::Inner": {},
        "other/other.go::Base": {},
      },
    });
    expect(resolver.resolve(call("e", "Reset"), ctx)).toBeNull();
  });

  it("NEGATIVE: a namesake class key another language published is never read as a Go struct", () => {
    // A Python `Engine` class with a field map at `engine.py::Engine` — the
    // symbol table has its `Engine` too. Only `.go` declarations count.
    const t = ginTable([["engine.py", [sym("Engine", "engine.py")]]]);
    const ctx = engineCtx({
      symbolTable: t,
      classFieldTypesByClassKey: {
        "engine.py::Engine": { RouterGroup: "RouterGroup", "embedded:RouterGroup": "RouterGroup" },
        "routergroup.go::RouterGroup": {},
      },
    });
    expect(resolver.resolve(call("engine", "GET"), ctx)).toBeNull();
  });
});
