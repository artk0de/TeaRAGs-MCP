import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyExternalVocabulary } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-external-vocabulary.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ctx = (table: InMemoryGlobalSymbolTable, extra?: Partial<CallContext>): CallContext => ({
  callerFile: "app/models/account.rb",
  callerScope: [],
  imports: [],
  symbolTable: table,
  ...extra,
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

  // bd tea-rags-mcp-wr7ku — the external classifier answers the same question the
  // ivarField strategy does ("what type is @ivar in class C"), so it must read the
  // same two channels in the same order. A gem-typed ivar recorded ONLY in the
  // precise `ivarTypes` channel is still honestly external.
  describe("@ivar receiver honours BOTH ivar type channels", () => {
    it("flags a gem-typed ivar recorded in the precise ivarTypes channel as external", () => {
      const callCtx = ctx(new InMemoryGlobalSymbolTable(), {
        callerScope: ["Foo"],
        ivarTypes: { Foo: { "@http": "Net::HTTP" } },
      });
      expect(vocab.isQualifiedReceiverExternal("@http", callCtx)).toBe(true);
    });

    it("does NOT flag an ivar typed to an IN-PROJECT class via ivarTypes", () => {
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("app/models/user.rb", [
        { symbolId: "User", fqName: "User", shortName: "User", relPath: "app/models/user.rb", scope: [] },
      ]);
      const callCtx = ctx(table, { callerScope: ["Foo"], ivarTypes: { Foo: { "@user": "User" } } });
      expect(vocab.isQualifiedReceiverExternal("@user", callCtx)).toBe(false);
    });

    it("does NOT flag an ivar recorded in NEITHER channel (honest denominator)", () => {
      const callCtx = ctx(new InMemoryGlobalSymbolTable(), {
        callerScope: ["Foo"],
        ivarTypes: { Foo: {} },
        classFieldTypes: { Foo: {} },
      });
      expect(vocab.isQualifiedReceiverExternal("@whatever", callCtx)).toBe(false);
    });
  });

  describe("core/gem-typed local receiver → external (dnd9s)", () => {
    it("flags a local var typed to a Ruby core class (Hash) even when an in-project method shares the name", () => {
      // `options` typed Hash via localBinding; `merge` also exists on in-project X#merge.
      // resolveConstant("Hash", ctx) = null → externally typed → must be external.
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("lib/x.rb", [
        { symbolId: "X#merge", fqName: "X#merge", shortName: "merge", relPath: "lib/x.rb", scope: ["X"] },
      ]);
      const callCtx = ctx(table, {
        localBindings: { options: [{ line: 5, type: "Hash" }] },
      });
      // atLine=10 (after the binding at line 5)
      expect(vocab.isQualifiedReceiverExternal("options", callCtx, 10)).toBe(true);
    });

    it("flags a local var typed to a gem class (Sawyer::Resource) as external", () => {
      const table = new InMemoryGlobalSymbolTable();
      const callCtx = ctx(table, {
        localBindings: { state: [{ line: 3, type: "Sawyer::Resource" }] },
      });
      expect(vocab.isQualifiedReceiverExternal("state", callCtx, 8)).toBe(true);
    });

    it("does NOT flag a local var typed to an IN-PROJECT class", () => {
      // `account` typed Account and Account IS in the symbol table → in-project miss stays a miss.
      const table = new InMemoryGlobalSymbolTable();
      table.upsertFile("app/models/account.rb", [
        {
          symbolId: "Account",
          fqName: "Account",
          shortName: "Account",
          relPath: "app/models/account.rb",
          scope: [],
        },
      ]);
      const callCtx = ctx(table, {
        localBindings: { account: [{ line: 2, type: "Account" }] },
      });
      expect(vocab.isQualifiedReceiverExternal("account", callCtx, 10)).toBe(false);
    });

    it("does NOT flag an untyped local var (no localBinding entry)", () => {
      const table = new InMemoryGlobalSymbolTable();
      const callCtx = ctx(table, { localBindings: {} });
      expect(vocab.isQualifiedReceiverExternal("options", callCtx, 10)).toBe(false);
    });

    it("does NOT flag when atLine is absent (backward-compat: no regression)", () => {
      const table = new InMemoryGlobalSymbolTable();
      const callCtx = ctx(table, {
        localBindings: { options: [{ line: 5, type: "Hash" }] },
      });
      // No atLine → falls back to existing behaviour (lowercase = non-external)
      expect(vocab.isQualifiedReceiverExternal("options", callCtx)).toBe(false);
    });

    it("flags a RubyTypeRef instance-form binding whose name is not in-project", () => {
      const table = new InMemoryGlobalSymbolTable();
      const callCtx = ctx(table, {
        localBindings: {
          state: [{ line: 1, type: "String", typeRef: { form: "instance", name: "String" } }],
        },
      });
      expect(vocab.isQualifiedReceiverExternal("state", callCtx, 5)).toBe(true);
    });
  });
});

/**
 * bd tea-rags-mcp-2a5oo — a `db/schema.rb` column reader now carries its VALUE
 * type as a structured return fact, so a chain that continues past a column hop
 * (`firm.name.strip`) has a KNOWN core receiver. The classifier must claim it as
 * an honest external skip through the SAME channels it already uses for a typed
 * local — no new path, no new vocabulary.
 */
describe("RubyExternalVocabulary — column-typed chain hop (bd tea-rags-mcp-2a5oo)", () => {
  const vocab = new RubyExternalVocabulary();

  /** Symbol table knowing `Firm` (in-project) and nothing else. */
  function firmTable(): InMemoryGlobalSymbolTable {
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/models/firm.rb", [
      { symbolId: "Firm", fqName: "Firm", shortName: "Firm", relPath: "app/models/firm.rb", scope: [] },
    ]);
    return table;
  }

  it("flags a chain whose column hop types to a core class as external", () => {
    const callCtx = ctx(firmTable(), {
      localBindings: { firm: [{ line: 1, type: "Firm" }] },
      structuredReturnTypes: { "Firm#name": { form: "instance", name: "String" } },
    });
    expect(vocab.isQualifiedReceiverExternal("firm.name", callCtx, 5)).toBe(true);
  });

  it("flags a jsonb column hop (Hash) as external too", () => {
    const callCtx = ctx(firmTable(), {
      localBindings: { firm: [{ line: 1, type: "Firm" }] },
      structuredReturnTypes: { "Firm#settings": { form: "instance", name: "Hash" } },
    });
    expect(vocab.isQualifiedReceiverExternal("firm.settings", callCtx, 5)).toBe(true);
  });

  it("does NOT flag the same chain while the column hop is untyped", () => {
    const callCtx = ctx(firmTable(), { localBindings: { firm: [{ line: 1, type: "Firm" }] } });
    expect(vocab.isQualifiedReceiverExternal("firm.name", callCtx, 5)).toBe(false);
  });

  it("does NOT flag a hop whose declared type IS in-project (a real miss stays a miss)", () => {
    const table = firmTable();
    table.upsertFile("app/models/owner.rb", [
      { symbolId: "Owner", fqName: "Owner", shortName: "Owner", relPath: "app/models/owner.rb", scope: [] },
    ]);
    const callCtx = ctx(table, {
      localBindings: { firm: [{ line: 1, type: "Firm" }] },
      structuredReturnTypes: { "Firm#owner": { form: "instance", name: "Owner" } },
    });
    expect(vocab.isQualifiedReceiverExternal("firm.owner", callCtx, 5)).toBe(false);
  });
});
