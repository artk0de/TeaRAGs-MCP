import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, NamedSymbol } from "../../../../../../src/core/contracts/types/codegraph.js";
import { GoCallResolver } from "../../../../../../src/core/domains/language/go/resolver/go-resolver.js";
import { DefaultSymbolIdComposer } from "../../../../../../src/core/domains/language/kernel/symbol-id.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

/**
 * bd tea-rags-mcp-e6xx — explicit generic instantiation. gin's
 * `getTyped[string](c, key)` reaches the resolver as the bare call
 * `getTyped[string]`: the walker reports the callee expression verbatim, and an
 * `index_expression` callee reads the same whether it instantiates a generic
 * function or indexes a slice of funcs (`fs[i](x)`). Indexing a FUNCTION is not
 * legal Go, so when the operand names a function (or type) declared in the
 * caller's own package — the scope a bare identifier resolves in — the brackets
 * are type arguments and the call is a call of that declaration.
 */

const sym = (symbolId: string, relPath: string): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName: symbolId.split(/[#.]/).pop() ?? symbolId,
  relPath,
  scope: [],
});

const bare = (member: string): CallRef => ({ callText: `${member}(c, key)`, receiver: null, member, startLine: 9 });

function ctx(table: InMemoryGlobalSymbolTable, over: Partial<CallContext> = {}): CallContext {
  return { callerFile: "context.go", callerScope: [], imports: [], symbolTable: table, ...over };
}

const resolver = new GoCallResolver(new DefaultSymbolIdComposer());

describe("GoCallResolver — explicit generic instantiation", () => {
  it("resolves `getTyped[string](c, key)` to the generic function getTyped (gin context.go)", () => {
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("context.go", [sym("getTyped", "context.go")]);
    expect(resolver.resolve(bare("getTyped[string]"), ctx(t))).toEqual({
      targetRelPath: "context.go",
      targetSymbolId: "getTyped",
    });
  });

  it("strips several type arguments, composite ones included", () => {
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("pair.go", [sym("makePair", "pair.go")]);
    expect(resolver.resolve(bare("makePair[map[string]int, []byte]"), ctx(t))?.targetSymbolId).toBe("makePair");
  });

  it("finds the declaration in ANOTHER file of the caller's package", () => {
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("pkg/a.go", [sym("convert", "pkg/a.go")]);
    expect(resolver.resolve(bare("convert[int]"), ctx(t, { callerFile: "pkg/b.go" }))?.targetRelPath).toBe("pkg/a.go");
  });

  it("NEGATIVE: `fs[i](x)` — an operand that names no declaration is an index, not an instantiation", () => {
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("context.go", [sym("Context#fs", "context.go")]);
    expect(resolver.resolve(bare("fs[i]"), ctx(t))).toBeNull();
  });

  it("NEGATIVE: a declaration in another package is not in a bare identifier's scope", () => {
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("binding/typed.go", [sym("getTyped", "binding/typed.go")]);
    expect(resolver.resolve(bare("getTyped[string]"), ctx(t))).toBeNull();
  });

  it("NEGATIVE: a typed local of the operand's name shadows the declaration", () => {
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("context.go", [sym("handlers", "context.go")]);
    const local = ctx(t, { localBindings: { handlers: [{ line: 3, type: "HandlersChain" }] } });
    expect(resolver.resolve(bare("handlers[i]"), local)).toBeNull();
  });

  it("NEGATIVE: two same-named declarations in the package (build-tag twins) stay ambiguous", () => {
    const t = new InMemoryGlobalSymbolTable();
    t.upsertFile("typed.go", [sym("getTyped", "typed.go")]);
    t.upsertFile("typed_nomsgpack.go", [sym("getTyped", "typed_nomsgpack.go")]);
    expect(resolver.resolve(bare("getTyped[string]"), ctx(t))).toBeNull();
  });
});
