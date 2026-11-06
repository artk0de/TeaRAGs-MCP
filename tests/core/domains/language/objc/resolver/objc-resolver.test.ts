import { describe, expect, it } from "vitest";

import type { CallContext, CallRef } from "../../../../../../src/core/contracts/types/codegraph.js";
import { ObjcCallResolver } from "../../../../../../src/core/domains/language/objc/resolver/index.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function context(scope: string[], table: InMemoryGlobalSymbolTable): CallContext {
  return { callerFile: "Widget.m", callerScope: scope, imports: [], symbolTable: table };
}

function tableWith(ids: string[]): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile(
    "Widget.m",
    ids.map((symbolId) => ({
      symbolId,
      fqName: symbolId,
      shortName: symbolId.slice(symbolId.indexOf("#") + 1),
      relPath: "Widget.m",
      scope: ["Widget"],
    })),
  );
  return table;
}

function call(receiver: string, member: string): CallRef {
  return { callText: `[${receiver} ${member}]`, receiver, member, startLine: 4 };
}

describe("ObjcCallResolver", () => {
  const resolver = new ObjcCallResolver();
  const table = tableWith(["Widget#layout", "Widget#setName:", "Widget.widget"]);

  it("resolves [self layout] to the implementation's instance method", () => {
    const target = resolver.resolve(call("self", "layout"), context(["Widget"], table));
    expect(target).toEqual({ targetRelPath: "Widget.m", targetSymbolId: "Widget#layout" });
  });

  it("resolves [self setName:] including the colon", () => {
    const target = resolver.resolve(call("self", "setName:"), context(["Widget"], table));
    expect(target?.targetSymbolId).toBe("Widget#setName:");
  });

  it("does not resolve a class method through [self widget]", () => {
    expect(resolver.resolve(call("self", "widget"), context(["Widget"], table))).toBeNull();
  });

  it("does not resolve a send whose receiver is not self", () => {
    expect(resolver.resolve(call("other", "layout"), context(["Widget"], table))).toBeNull();
  });

  it("does not resolve [self layout] with an empty caller scope", () => {
    expect(resolver.resolve(call("self", "layout"), context([], table))).toBeNull();
  });
});
