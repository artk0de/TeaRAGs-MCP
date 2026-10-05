/**
 * Ruby's `TypeMemberLookup` (bd tea-rags-mcp-m99j1.1.4): the `instance` form
 * resolves an instance method (`Type#m`) and the `class` form a class method
 * (`Type.m`), both up the ancestor MRO.
 */
import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { TypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { createRubyTypeMemberLookup } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-type-member-lookup.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

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

/** `class A; def foo; def self.make; end` and `class B < A; end`. */
const ctx = (): CallContext => ({
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  symbolTable: tableWith({
    "app/a.rb": [{ symbolId: "A" }, { symbolId: "A#foo", scope: ["A"] }, { symbolId: "A.make", scope: ["A"] }],
    "app/b.rb": [{ symbolId: "B" }],
  }),
  classAncestors: { B: ["A"] },
  classExtends: { B: "A" },
});

describe("createRubyTypeMemberLookup", () => {
  const lookup = createRubyTypeMemberLookup("strict");

  it("resolves an instance member inherited from the superclass", () => {
    expect(lookup.findMember({ form: "instance", name: "B" }, "foo", ctx())).toEqual({
      targetRelPath: "app/a.rb",
      targetSymbolId: "A#foo",
    });
  });

  it("resolves a class member inherited from the superclass", () => {
    expect(lookup.findMember({ form: "class", name: "B" }, "make", ctx())).toEqual({
      targetRelPath: "app/a.rb",
      targetSymbolId: "A.make",
    });
  });

  it("does not answer an instance receiver with a class method", () => {
    // `B.new.make` reaches no `make`: only the `.`-form exists. The miss falls
    // back to the receiver type's own file, as `resolveTypeInstanceMethod` does.
    expect(lookup.findMember({ form: "instance", name: "B" }, "make", ctx())).toEqual({
      targetRelPath: "app/b.rb",
      targetSymbolId: null,
    });
  });

  it("answers null for a union receiver", () => {
    const union: TypeRef = {
      form: "union",
      members: [
        { form: "instance", name: "A" },
        { form: "instance", name: "B" },
      ],
    };
    expect(lookup.findMember(union, "foo", ctx())).toBeNull();
  });
});
