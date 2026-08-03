import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type HierarchyView,
  type InheritanceEdge,
  type NamedSymbol,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import type { ResolverConfig } from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";
import { RubyIvarFieldSymbolResolutionStrategy } from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/ruby-ivar-field.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const cfg: ResolverConfig = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

const sym = (symbolId: string, shortName: string, relPath: string, scope: string[]): NamedSymbol => ({
  symbolId,
  fqName: symbolId,
  shortName,
  relPath,
  scope,
});

const tableWith = (...files: [string, NamedSymbol[]][]): InMemoryGlobalSymbolTable => {
  const t = new InMemoryGlobalSymbolTable();
  for (const [relPath, defs] of files) t.upsertFile(relPath, defs);
  return t;
};

/** Minimal HierarchyView: a flat descendants map keyed by fqName. */
function hierarchyOf(descendants: Record<string, string[]>): HierarchyView {
  const toEdges = (names: string[]): InheritanceEdge[] =>
    names.map((sourceFqName) => ({
      sourceFqName,
      ancestorFqName: "",
      ancestorSymbolId: null,
      kind: "super" as const,
      depth: 1,
    }));
  return {
    getAncestors: () => [],
    getDescendants: (fqName) => toEdges(descendants[fqName] ?? []),
  };
}

const ctx = (over: Partial<CallContext> & Pick<CallContext, "symbolTable">): CallContext => ({
  callerFile: "app/services/caller.rb",
  callerScope: ["Foo"],
  imports: [],
  ...over,
});

/** `Payment#refund` — the class an `@payment` receiver names by convention. */
const paymentTable = (): InMemoryGlobalSymbolTable =>
  tableWith([
    "app/models/payment.rb",
    [
      sym("Payment", "Payment", "app/models/payment.rb", []),
      sym("Payment#refund", "refund", "app/models/payment.rb", ["Payment"]),
    ],
  ]);

/** `Payment#refund` PLUS a second class the fact channels can name instead. */
const paymentAndChargeTable = (): InMemoryGlobalSymbolTable =>
  tableWith(
    [
      "app/models/payment.rb",
      [
        sym("Payment", "Payment", "app/models/payment.rb", []),
        sym("Payment#refund", "refund", "app/models/payment.rb", ["Payment"]),
      ],
    ],
    [
      "app/models/charge.rb",
      [
        sym("Charge", "Charge", "app/models/charge.rb", []),
        sym("Charge#refund", "refund", "app/models/charge.rb", ["Charge"]),
      ],
    ],
  );

const refundCall: CallRef = { callText: "@payment.refund", receiver: "@payment", member: "refund", startLine: 1 };

const targetOf = (outcome: { kind: string } & Record<string, unknown>): string | null =>
  outcome.kind === "resolved" ? ((outcome.target as { targetSymbolId: string | null }).targetSymbolId ?? null) : null;

describe("RubyIvarFieldSymbolResolutionStrategy — convention tier (bd tea-rags-mcp-r2gjj)", () => {
  const strat = new RubyIvarFieldSymbolResolutionStrategy(cfg);

  // ── the mechanism: an ivar NO channel typed ────────────────────────────────

  it("types an untyped @ivar by naming convention and pins the member", () => {
    const outcome = strat.attempt(refundCall, ctx({ symbolTable: paymentTable() }));
    expect(outcome.kind).toBe("resolved");
    expect(targetOf(outcome)).toBe("Payment#refund");
  });

  it("camelizes a snake_case ivar (`@recurring_invoice` → `RecurringInvoice`)", () => {
    const symbolTable = tableWith([
      "app/models/recurring_invoice.rb",
      [
        sym("RecurringInvoice", "RecurringInvoice", "app/models/recurring_invoice.rb", []),
        sym("RecurringInvoice#charge", "charge", "app/models/recurring_invoice.rb", ["RecurringInvoice"]),
      ],
    ]);
    const call: CallRef = {
      callText: "@recurring_invoice.charge",
      receiver: "@recurring_invoice",
      member: "charge",
      startLine: 1,
    };
    expect(targetOf(strat.attempt(call, ctx({ symbolTable })))).toBe("RecurringInvoice#charge");
  });

  it("leaves a `@@class_var` receiver to `conventionReceiver` — the entry guard is unchanged", () => {
    // `IVAR_RECEIVER` is a SINGLE `@`; a class variable was never this pass's
    // surface and the tier must not widen it. `conventionReceiver` (position 12)
    // already accepts `@@` receivers, so nothing is lost by declining here.
    const call: CallRef = { ...refundCall, callText: "@@payment.refund", receiver: "@@payment" };
    expect(strat.attempt(call, ctx({ symbolTable: paymentTable() })).kind).toBe("continue");
  });

  // ── REGRESSION CHANNEL: every existing ivar channel stays authoritative ────

  it("keeps the walker `classFieldTypes` fact when the convention would name another class", () => {
    const outcome = strat.attempt(
      refundCall,
      ctx({ symbolTable: paymentAndChargeTable(), classFieldTypes: { Foo: { "@payment": "Charge" } } }),
    );
    expect(targetOf(outcome)).toBe("Charge#refund");
  });

  it("keeps the precise `ivarTypes` fact when the convention would name another class", () => {
    const outcome = strat.attempt(
      refundCall,
      ctx({ symbolTable: paymentAndChargeTable(), ivarTypes: { Foo: { "@payment": "Charge" } } }),
    );
    expect(targetOf(outcome)).toBe("Charge#refund");
  });

  it("keeps a fact's FILE-ONLY edge rather than upgrading it to a convention pin", () => {
    // `Charge` is known but declares no `#refund`; the fact channel answers with a
    // file-only edge. Letting the convention overwrite it would silently swap a
    // declared type for a guessed one.
    const symbolTable = tableWith(
      [
        "app/models/payment.rb",
        [
          sym("Payment", "Payment", "app/models/payment.rb", []),
          sym("Payment#refund", "refund", "app/models/payment.rb", ["Payment"]),
        ],
      ],
      ["app/models/charge.rb", [sym("Charge", "Charge", "app/models/charge.rb", [])]],
    );
    const outcome = strat.attempt(
      refundCall,
      ctx({ symbolTable, classFieldTypes: { Foo: { "@payment": "Charge" } } }),
    );
    expect(outcome.kind).toBe("resolved");
    expect(targetOf(outcome)).toBeNull();
  });

  it("still DROPS a GEM-typed ivar — a declared type keeps the denominator honest", () => {
    // `@payment` is declared `Stripe::Charge`, which has no project file. The
    // strategy DROPs so `RubyExternalVocabulary` can reclassify the call as
    // external. A convention guess here would fabricate an edge AND pull the call
    // back into the resolveSuccessRate denominator as a false resolution.
    const outcome = strat.attempt(
      refundCall,
      ctx({ symbolTable: paymentTable(), classFieldTypes: { Foo: { "@payment": "Stripe::Charge" } } }),
    );
    expect(outcome.kind).toBe("drop");
  });

  // ── the MANDATORY precision gate ───────────────────────────────────────────

  it("stays silent when the derived class HAS subtypes (polymorphic base)", () => {
    const symbolTable = tableWith([
      "app/models/actor.rb",
      [
        sym("Actor", "Actor", "app/models/actor.rb", []),
        sym("Actor#deliver", "deliver", "app/models/actor.rb", ["Actor"]),
      ],
    ]);
    const call: CallRef = { callText: "@actor.deliver", receiver: "@actor", member: "deliver", startLine: 1 };
    const hierarchy = hierarchyOf({ Actor: ["System", "Guest", "User", "Employee"] });
    expect(strat.attempt(call, ctx({ symbolTable, hierarchy })).kind).toBe("drop");
    // …and it WOULD have resolved without the gate, so the gate is what is under test.
    expect(targetOf(strat.attempt(call, ctx({ symbolTable })))).toBe("Actor#deliver");
  });

  // ── the terminal: a wrong guess dies on member absence ─────────────────────

  it("DROPS when the convention names a class that declares no such member", () => {
    const symbolTable = tableWith(["app/models/payment.rb", [sym("Payment", "Payment", "app/models/payment.rb", [])]]);
    expect(strat.attempt(refundCall, ctx({ symbolTable })).kind).toBe("drop");
  });

  it("DROPS when only a CLASS method of that name exists — an ivar is an instance", () => {
    const symbolTable = tableWith([
      "app/models/payment.rb",
      [
        sym("Payment", "Payment", "app/models/payment.rb", []),
        sym("Payment.refund", "refund", "app/models/payment.rb", ["Payment"]),
      ],
    ]);
    expect(strat.attempt(refundCall, ctx({ symbolTable })).kind).toBe("drop");
  });

  it("DROPS when the ivar names no in-project class at all", () => {
    const symbolTable = tableWith(["other.rb", [sym("Other#refund", "refund", "other.rb", ["Other"])]]);
    expect(strat.attempt(refundCall, ctx({ symbolTable })).kind).toBe("drop");
  });

  // ── entry guards unchanged ────────────────────────────────────────────────

  it("continues on a chained `@a.b` receiver — the chain passes own those", () => {
    const call: CallRef = { ...refundCall, receiver: "@payment.card" };
    expect(strat.attempt(call, ctx({ symbolTable: paymentTable() })).kind).toBe("continue");
  });

  it("continues outside a class scope (callerScope empty)", () => {
    expect(strat.attempt(refundCall, ctx({ symbolTable: paymentTable(), callerScope: [] })).kind).toBe("continue");
  });

  it("continues on a non-ivar receiver — `conventionReceiver` owns those", () => {
    const call: CallRef = { ...refundCall, receiver: "payment" };
    expect(strat.attempt(call, ctx({ symbolTable: paymentTable() })).kind).toBe("continue");
  });
});

describe("RubyCallResolver — ivar convention tier in the chain (bd tea-rags-mcp-r2gjj)", () => {
  it("resolves an untyped convention-named @ivar end to end", () => {
    const resolver = new RubyCallResolver();
    expect(resolver.resolve(refundCall, ctx({ symbolTable: paymentTable() }))?.targetSymbolId).toBe("Payment#refund");
  });

  it("leaves a polymorphic-base @ivar unresolved through the whole chain", () => {
    const resolver = new RubyCallResolver();
    const symbolTable = tableWith([
      "app/models/actor.rb",
      [
        sym("Actor", "Actor", "app/models/actor.rb", []),
        sym("Actor#deliver", "deliver", "app/models/actor.rb", ["Actor"]),
      ],
    ]);
    const hierarchy = hierarchyOf({ Actor: ["System", "Guest"] });
    const call: CallRef = { callText: "@actor.deliver", receiver: "@actor", member: "deliver", startLine: 1 };
    expect(resolver.resolve(call, ctx({ symbolTable, hierarchy }))).toBeNull();
  });
});
