/**
 * Part 3 — anonymous module super / empty callerScope (bd 08tss Part 3).
 *
 * `super` inside `Module.new { ... }` yields an empty `callerScope`.
 * `superTargetsExternal` must return true in this case (the super target is
 * always the Ruby runtime — BasicObject / Module), so the call is classified
 * EXTERNAL rather than an in-project miss.
 *
 * Guards:
 *  - A `super` with a real enclosing class and at least one in-project ancestor
 *    MUST NOT be classified external (the ancestor chain might resolve).
 *  - A `super` with a real enclosing class but a FULLY external ancestor chain
 *    must still be classified external (existing behaviour, preserved).
 */

import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyExternalVocabulary } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-external-vocabulary.js";
import { SUPER_RECEIVER_SENTINEL } from "../../../../../../src/core/domains/language/ruby/walker/walker.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const emptyTable = () => new InMemoryGlobalSymbolTable();

const ctx = (table: InMemoryGlobalSymbolTable, extra?: Partial<CallContext>): CallContext => ({
  callerFile: "lib/anon.rb",
  callerScope: [],
  imports: [],
  symbolTable: table,
  ...extra,
});

describe("RubyExternalVocabulary — superTargetsExternal / anonymous module (bd 08tss Part 3)", () => {
  const vocab = new RubyExternalVocabulary();

  it("flags super with empty callerScope as external (anonymous Module.new)", () => {
    // No enclosing class → super targets BasicObject / Module in the runtime.
    const callCtx = ctx(emptyTable(), { callerScope: [] });
    expect(vocab.isQualifiedReceiverExternal(SUPER_RECEIVER_SENTINEL, callCtx)).toBe(true);
  });

  it("does NOT flag super when callerScope is non-empty and ancestor chain has in-project file", () => {
    // MyClass < ApplicationRecord — ApplicationRecord IS in the symbol table.
    const table = new InMemoryGlobalSymbolTable();
    table.upsertFile("app/application_record.rb", [
      {
        symbolId: "ApplicationRecord",
        fqName: "ApplicationRecord",
        shortName: "ApplicationRecord",
        relPath: "app/application_record.rb",
        scope: [],
      },
    ]);
    const callCtx = ctx(table, {
      callerScope: ["MyClass"],
      classAncestors: { MyClass: ["ApplicationRecord"] },
    });
    expect(vocab.isQualifiedReceiverExternal(SUPER_RECEIVER_SENTINEL, callCtx)).toBe(false);
  });

  it("flags super as external when callerScope is non-empty but entire ancestor chain is external (gem)", () => {
    // Existing behaviour — class Agent < ActiveRecord::Base; ActiveRecord::Base is NOT in symbol table.
    const callCtx = ctx(emptyTable(), {
      callerScope: ["Agent"],
      classAncestors: { Agent: ["ActiveRecord::Base"] },
    });
    expect(vocab.isQualifiedReceiverExternal(SUPER_RECEIVER_SENTINEL, callCtx)).toBe(true);
  });
});
