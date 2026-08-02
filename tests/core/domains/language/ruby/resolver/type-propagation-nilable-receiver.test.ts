/**
 * A NILABLE receiver types like its one reachable arm (bd tea-rags-mcp-27q0z).
 *
 * The nilable form exists so a fact can state "Firm or nothing" honestly. At a
 * CALL SITE that honesty must not cost precision: `nil.foo` reaches no
 * in-project definition, so a `Firm|nil` receiver dispatches exactly where a
 * `Firm` receiver dispatches. Without this the union would reach
 * `RubyUnionDispatchResolver` — which the resolution runner consults BEFORE the
 * exact chain — and a call that resolved to one exact edge would come back as a
 * one-target `cone` fan-out instead.
 *
 * A genuinely polymorphic union is untouched: two reachable arms still need the
 * fan-out, which is what it is for.
 */
import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../src/core/contracts/types/codegraph.js";
import type { RubyTypeRef } from "../../../../../../src/core/contracts/types/language.js";
import {
  boundCallReturnType,
  typeOfReceiver,
} from "../../../../../../src/core/domains/language/ruby/resolver/type-propagation.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ctxOf = (over: Partial<CallContext> = {}): CallContext => ({
  callerFile: "app/caller.rb",
  callerScope: [],
  imports: [],
  symbolTable: new InMemoryGlobalSymbolTable(),
  ...over,
});

const inst = (name: string): RubyTypeRef => ({ form: "instance", name });
const NIL: RubyTypeRef = { form: "nil" };
const nilable = (ref: RubyTypeRef): RubyTypeRef => ({ form: "union", members: [ref, NIL] });

describe("typeOfReceiver — nilable binding", () => {
  it("a `[Firm, nil]` local binding dispatches as a Firm", () => {
    const ctx = ctxOf({ localBindings: { firm: [{ line: 1, type: "Firm", typeRef: nilable(inst("Firm")) }] } });
    expect(typeOfReceiver("firm", 5, ctx)).toEqual(inst("Firm"));
  });

  it("a genuinely polymorphic binding still hands back the union to fan out", () => {
    const union = { form: "union" as const, members: [inst("A"), inst("B")] };
    const ctx = ctxOf({ localBindings: { obj: [{ line: 1, type: "A", typeRef: union }] } });
    expect(typeOfReceiver("obj", 5, ctx)).toEqual(union);
  });
});

describe("typeOfReceiver — nilable hop inside a chain", () => {
  it("a chain through a nilable return keeps threading and lands on a nominal", () => {
    const ctx = ctxOf({
      localBindings: { host: [{ line: 1, type: "HostHelper" }] },
      structuredReturnTypes: {
        "HostHelper#current_firm": nilable(inst("Firm")),
        "Firm#owner": inst("Owner"),
      },
    });
    expect(typeOfReceiver("host.current_firm.owner", 5, ctx)).toEqual(inst("Owner"));
  });

  it("a chain ENDING on a nilable return dispatches as the reachable arm", () => {
    const ctx = ctxOf({
      localBindings: { host: [{ line: 1, type: "HostHelper" }] },
      structuredReturnTypes: { "HostHelper#current_firm": nilable(inst("Firm")) },
    });
    expect(typeOfReceiver("host.current_firm", 5, ctx)).toEqual(inst("Firm"));
  });
});

describe("boundCallReturnType — a receiver bound to a nilable call", () => {
  it("a scope-qualified binding onto a nilable return dispatches as the reachable arm", () => {
    // `hit = Rules::MassFailure.call(signals)` with `@return [RuleHit, nil]`.
    // The single-target `returnTypeBinding` pass takes class/instance only, so a
    // raw union here would silently give up the exact edge it used to emit.
    const ctx = ctxOf({
      localCallBindings: { hit: "Rules::MassFailure.call" },
      structuredReturnTypes: { "Rules::MassFailure#call": nilable(inst("RuleHit")) },
    });
    expect(boundCallReturnType("hit", ctx)).toEqual(inst("RuleHit"));
  });

  it("a bare self-call binding onto a nilable return does the same", () => {
    const ctx = ctxOf({
      callerScope: ["Svc"],
      localCallBindings: { hit: "build_hit" },
      structuredReturnTypes: { "Svc#build_hit": nilable(inst("RuleHit")) },
    });
    expect(boundCallReturnType("hit", ctx)).toEqual(inst("RuleHit"));
  });

  it("a genuinely polymorphic return still hands back the union", () => {
    const union = { form: "union" as const, members: [inst("A"), inst("B")] };
    const ctx = ctxOf({
      localCallBindings: { x: "Svc.call" },
      structuredReturnTypes: { "Svc#call": union },
    });
    expect(boundCallReturnType("x", ctx)).toEqual(union);
  });
});
