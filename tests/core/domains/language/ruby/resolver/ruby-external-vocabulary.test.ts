import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyExternalVocabulary } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-external-vocabulary.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ctx = (table: InMemoryGlobalSymbolTable): CallContext => ({
  callerFile: "app/models/account.rb",
  callerScope: [],
  imports: [],
  symbolTable: table,
});

describe("RubyExternalVocabulary", () => {
  const vocab = new RubyExternalVocabulary();

  it("isBareCallExternal delegates to the framework registry", () => {
    expect(vocab.isBareCallExternal("has_many")).toBe(true); // rails macro
    expect(vocab.isBareCallExternal("params")).toBe(true); // rails runtime
    expect(vocab.isBareCallExternal("puts")).toBe(true); // kernel
    expect(vocab.isBareCallExternal("my_helper")).toBe(false); // project method
  });

  it("isQualifiedReceiverExternal flags an unresolved constant (gem/stdlib)", () => {
    expect(vocab.isQualifiedReceiverExternal("Net::HTTP", ctx(new InMemoryGlobalSymbolTable()))).toBe(true);
  });

  it("does NOT flag a constant that resolves to a project file", () => {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/user.rb", [
      { symbolId: "User", fqName: "User", shortName: "User", relPath: "app/models/user.rb", scope: [] },
    ]);
    expect(vocab.isQualifiedReceiverExternal("User", ctx(table))).toBe(false);
  });

  it("does NOT flag a lowercase receiver (local var / self)", () => {
    expect(vocab.isQualifiedReceiverExternal("user", ctx(new InMemoryGlobalSymbolTable()))).toBe(false);
  });

  it("isQualifiedMemberExternal is true for an AR-core member, false for a project method", () => {
    expect(vocab.isQualifiedMemberExternal("update")).toBe(true);
    expect(vocab.isQualifiedMemberExternal("handle_details_post")).toBe(false);
  });
});
