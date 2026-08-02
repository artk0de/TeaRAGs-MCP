/**
 * `returnTypeOf` over a UNION / NILABLE receiver (bd tea-rags-mcp-27q0z).
 *
 * Until this bead the engine answered `undefined` for every union receiver, so a
 * `Firm`-or-`nil` return fact could not be threaded even one hop. The policy the
 * cases below pin:
 *
 *   - the `nil` arm is NOT dispatchable and is dropped before the fold;
 *   - every remaining arm must answer, and all answers must AGREE, or the fold
 *     resolves to silence — the same conservatism `selfMemberReturnType` applies
 *     to disagreeing ancestors, for the same reason (a wrong receiver type
 *     poisons every downstream hop).
 */
import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../../../src/core/contracts/types/language.js";
import { returnTypeOf } from "../../../../../../src/core/domains/language/ruby/resolver/type-propagation.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ctxOf = (over: Partial<CallContext> = {}): CallContext => ({
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  symbolTable: new InMemoryGlobalSymbolTable(),
  ...over,
});

const inst = (name: string): RubyTypeRef => ({ form: "instance", name });
const union = (...members: RubyTypeRef[]): RubyTypeRef => ({ form: "union", members });
const NIL: RubyTypeRef = { form: "nil" };

describe("returnTypeOf — nil receiver", () => {
  it("nil dispatches to nothing", () => {
    const ctx = ctxOf({ structuredReturnTypes: { "NilClass#to_a": inst("Array") } });
    expect(returnTypeOf(NIL, "to_a", ctx)).toBeUndefined();
  });
});

describe("returnTypeOf — nilable union receiver", () => {
  it("threads the member through the single non-nil arm", () => {
    const ctx = ctxOf({ structuredReturnTypes: { "Firm#owner": inst("Owner") } });
    expect(returnTypeOf(union(inst("Firm"), NIL), "owner", ctx)).toEqual(inst("Owner"));
  });

  it("stays silent when the non-nil arm has no fact for the member", () => {
    const ctx = ctxOf({ structuredReturnTypes: {} });
    expect(returnTypeOf(union(inst("Firm"), NIL), "owner", ctx)).toBeUndefined();
  });

  it("a union of nothing but nil answers nothing", () => {
    expect(returnTypeOf(union(NIL, NIL), "owner", ctxOf())).toBeUndefined();
  });
});

describe("returnTypeOf — multi-arm union agreement fold", () => {
  it("all arms agreeing yields the agreed type", () => {
    const ctx = ctxOf({
      structuredReturnTypes: { "A#thing": inst("Thing"), "B#thing": inst("Thing") },
    });
    expect(returnTypeOf(union(inst("A"), inst("B")), "thing", ctx)).toEqual(inst("Thing"));
  });

  it("arms disagreeing resolves to silence, never to one arm's answer", () => {
    const ctx = ctxOf({
      structuredReturnTypes: { "A#thing": inst("Thing"), "B#thing": inst("Other") },
    });
    expect(returnTypeOf(union(inst("A"), inst("B")), "thing", ctx)).toBeUndefined();
  });

  it("one silent arm silences the whole fold — a partial answer would be a guess", () => {
    const ctx = ctxOf({ structuredReturnTypes: { "A#thing": inst("Thing") } });
    expect(returnTypeOf(union(inst("A"), inst("B")), "thing", ctx)).toBeUndefined();
  });

  it("agreement is structural, so union answers compare arm-wise", () => {
    const nilableOwner = union(inst("Owner"), NIL);
    const ctx = ctxOf({
      structuredReturnTypes: { "A#owner": nilableOwner, "B#owner": union(inst("Owner"), NIL) },
    });
    expect(returnTypeOf(union(inst("A"), inst("B")), "owner", ctx)).toEqual(nilableOwner);
  });

  it("the fold reaches every channel returnTypeOf owns, not just the structured one", () => {
    // Rails association on one arm, structured fact on the other — both answer
    // `Owner`, so the fold agrees.
    const ctx = ctxOf({
      structuredReturnTypes: { "A#owner": inst("Owner") },
      associationTypes: { B: { owner: "Owner" } },
    });
    expect(returnTypeOf(union(inst("A"), inst("B")), "owner", ctx)).toEqual(inst("Owner"));
  });
});
