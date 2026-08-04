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
import {
  resolveConventionReceiverTarget,
  RubyConventionReceiverSymbolResolutionStrategy,
} from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/ruby-convention-receiver.js";
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
  callerScope: [],
  imports: [],
  ...over,
});

/** `Payment` with one instance method — the class the convention should name. */
const paymentTable = (): InMemoryGlobalSymbolTable =>
  tableWith([
    "app/models/payment.rb",
    [
      sym("Payment", "Payment", "app/models/payment.rb", []),
      sym("Payment#refund", "refund", "app/models/payment.rb", ["Payment"]),
    ],
  ]);

describe("RubyConventionReceiverSymbolResolutionStrategy (bd tea-rags-mcp-wob7g)", () => {
  const strat = new RubyConventionReceiverSymbolResolutionStrategy(cfg);

  // ── the mechanism ──────────────────────────────────────────────────────────

  it("types a bare receiver by naming convention and resolves the member", () => {
    const symbolTable = paymentTable();
    const call: CallRef = { callText: "payment.refund", receiver: "payment", member: "refund", startLine: 1 };
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome.kind).toBe("resolved");
    expect(outcome.kind === "resolved" ? outcome.target.targetSymbolId : null).toBe("Payment#refund");
  });

  it("camelizes a snake_case receiver (`recurring_invoice` → `RecurringInvoice`)", () => {
    const symbolTable = tableWith([
      "app/models/recurring_invoice.rb",
      [
        sym("RecurringInvoice", "RecurringInvoice", "app/models/recurring_invoice.rb", []),
        sym("RecurringInvoice#charge", "charge", "app/models/recurring_invoice.rb", ["RecurringInvoice"]),
      ],
    ]);
    const call: CallRef = {
      callText: "recurring_invoice.charge",
      receiver: "recurring_invoice",
      member: "charge",
      startLine: 1,
    };
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome.kind === "resolved" ? outcome.target.targetSymbolId : null).toBe("RecurringInvoice#charge");
  });

  it("accepts an `@ivar` receiver once `ivarField` has declined it", () => {
    const symbolTable = paymentTable();
    const call: CallRef = { callText: "@payment.refund", receiver: "@payment", member: "refund", startLine: 1 };
    const outcome = strat.attempt(call, ctx({ symbolTable }));
    expect(outcome.kind === "resolved" ? outcome.target.targetSymbolId : null).toBe("Payment#refund");
  });

  // ── the MANDATORY precision gate ───────────────────────────────────────────

  it("stays silent when the derived class HAS subtypes (polymorphic base)", () => {
    const symbolTable = tableWith([
      "app/models/actor.rb",
      [sym("Actor", "Actor", "app/models/actor.rb", []), sym("Actor#user", "user", "app/models/actor.rb", ["Actor"])],
    ]);
    // `actor` in taxdome is a polymorphic base — System / Guest / User / Employee.
    // Every measured convention error came from exactly this shape.
    const hierarchy = hierarchyOf({ Actor: ["System", "Guest", "User", "Employee"] });
    const call: CallRef = { callText: "actor.user", receiver: "actor", member: "user", startLine: 1 };
    expect(strat.attempt(call, ctx({ symbolTable, hierarchy })).kind).toBe("continue");
    // …and it WOULD have resolved without the gate, so the gate is what is under test.
    expect(strat.attempt(call, ctx({ symbolTable })).kind).toBe("resolved");
  });

  it("applies the gate to a namespaced declaration of the same short name", () => {
    const symbolTable = tableWith([
      "app/models/crm/actor.rb",
      [
        sym("Crm::Actor", "Actor", "app/models/crm/actor.rb", []),
        sym("Crm::Actor#user", "user", "app/models/crm/actor.rb", ["Crm::Actor"]),
      ],
    ]);
    const hierarchy = hierarchyOf({ "Crm::Actor": ["Crm::System"] });
    const call: CallRef = { callText: "actor.user", receiver: "actor", member: "user", startLine: 1 };
    expect(strat.attempt(call, ctx({ symbolTable, hierarchy })).kind).toBe("continue");
  });

  it("fires when the derived class exists and has NO subtypes", () => {
    const symbolTable = paymentTable();
    const hierarchy = hierarchyOf({ Actor: ["System"] });
    const call: CallRef = { callText: "payment.refund", receiver: "payment", member: "refund", startLine: 1 };
    expect(strat.attempt(call, ctx({ symbolTable, hierarchy })).kind).toBe("resolved");
  });

  // ── CONTINUE guards — everything the strategy must leave alone ─────────────

  it("continues when the receiver names no declared class", () => {
    const symbolTable = paymentTable();
    const call: CallRef = { callText: "widget.refund", receiver: "widget", member: "refund", startLine: 1 };
    expect(strat.attempt(call, ctx({ symbolTable })).kind).toBe("continue");
  });

  it("continues when a real fact channel already types the receiver", () => {
    const symbolTable = tableWith([
      "app/models/payment.rb",
      [
        sym("Payment", "Payment", "app/models/payment.rb", []),
        sym("Payment#refund", "refund", "app/models/payment.rb", ["Payment"]),
      ],
    ]);
    // A local binding is a REAL fact — it owns this receiver, convention must not.
    const call: CallRef = { callText: "payment.refund", receiver: "payment", member: "refund", startLine: 5 };
    const outcome = strat.attempt(
      call,
      ctx({ symbolTable, localBindings: { payment: [{ line: 1, type: "Charge" }] } }),
    );
    expect(outcome.kind).toBe("continue");
  });

  it("continues when the class exists but declares no such member (no file-only edge)", () => {
    const symbolTable = tableWith(["app/models/payment.rb", [sym("Payment", "Payment", "app/models/payment.rb", [])]]);
    const call: CallRef = { callText: "payment.refund", receiver: "payment", member: "refund", startLine: 1 };
    expect(strat.attempt(call, ctx({ symbolTable })).kind).toBe("continue");
  });

  it("continues on a null receiver (bare call)", () => {
    const symbolTable = paymentTable();
    const call: CallRef = { callText: "refund", receiver: null, member: "refund", startLine: 1 };
    expect(strat.attempt(call, ctx({ symbolTable })).kind).toBe("continue");
  });

  it("continues on a dotted receiver — the chain passes own those", () => {
    const symbolTable = paymentTable();
    const call: CallRef = {
      callText: "order.payment.refund",
      receiver: "order.payment",
      member: "refund",
      startLine: 1,
    };
    expect(strat.attempt(call, ctx({ symbolTable })).kind).toBe("continue");
  });

  it("continues on a keyword receiver", () => {
    const symbolTable = tableWith([
      "app/models/self.rb",
      [sym("Self", "Self", "app/models/self.rb", []), sym("Self#refund", "refund", "app/models/self.rb", ["Self"])],
    ]);
    const call: CallRef = { callText: "self.refund", receiver: "self", member: "refund", startLine: 1 };
    expect(strat.attempt(call, ctx({ symbolTable })).kind).toBe("continue");
  });

  it("continues on a constant receiver — `RubyConstantSymbolResolutionStrategy` owns those", () => {
    const symbolTable = paymentTable();
    const call: CallRef = { callText: "Payment.refund", receiver: "Payment", member: "refund", startLine: 1 };
    expect(strat.attempt(call, ctx({ symbolTable })).kind).toBe("continue");
  });
});

/**
 * The pass and the dynamic-dispatch deferral must read ONE predicate (bd
 * tea-rags-mcp-htffz) — two lookups would drift, and a receiver the fan-out
 * believes untyped while the pass pins it produces N wrong-type edges that bury
 * the right one. These pin the helper's answer against the strategy's.
 */
describe("resolveConventionReceiverTarget — the single authority (bd tea-rags-mcp-htffz)", () => {
  const agreesWith = (call: CallRef, context: CallContext): void => {
    const outcome = new RubyConventionReceiverSymbolResolutionStrategy(cfg).attempt(call, context);
    const target = resolveConventionReceiverTarget(call, context, cfg.mode);
    expect(target?.targetSymbolId ?? null).toBe(outcome.kind === "resolved" ? outcome.target.targetSymbolId : null);
  };

  it("pins the convention target the strategy resolves", () => {
    const symbolTable = paymentTable();
    const call: CallRef = { callText: "payment.refund", receiver: "payment", member: "refund", startLine: 1 };
    expect(resolveConventionReceiverTarget(call, ctx({ symbolTable }), cfg.mode)?.targetSymbolId).toBe(
      "Payment#refund",
    );
    agreesWith(call, ctx({ symbolTable }));
  });

  it("returns null under the subtype gate, exactly as the strategy CONTINUEs", () => {
    const symbolTable = tableWith([
      "app/models/actor.rb",
      [sym("Actor", "Actor", "app/models/actor.rb", []), sym("Actor#user", "user", "app/models/actor.rb", ["Actor"])],
    ]);
    const hierarchy = hierarchyOf({ Actor: ["System"] });
    const call: CallRef = { callText: "actor.user", receiver: "actor", member: "user", startLine: 1 };
    expect(resolveConventionReceiverTarget(call, ctx({ symbolTable, hierarchy }), cfg.mode)).toBeNull();
    agreesWith(call, ctx({ symbolTable, hierarchy }));
  });

  it("returns null when a real fact already types the receiver", () => {
    const symbolTable = paymentTable();
    const context = ctx({ symbolTable, localBindings: { payment: [{ line: 1, type: "Charge" }] } });
    const call: CallRef = { callText: "payment.refund", receiver: "payment", member: "refund", startLine: 5 };
    expect(resolveConventionReceiverTarget(call, context, cfg.mode)).toBeNull();
    agreesWith(call, context);
  });

  it("returns null when the class declares no such member (refuses the file-only edge)", () => {
    const symbolTable = tableWith(["app/models/payment.rb", [sym("Payment", "Payment", "app/models/payment.rb", [])]]);
    const call: CallRef = { callText: "payment.refund", receiver: "payment", member: "refund", startLine: 1 };
    expect(resolveConventionReceiverTarget(call, ctx({ symbolTable }), cfg.mode)).toBeNull();
    agreesWith(call, ctx({ symbolTable }));
  });

  it("returns null on a null receiver", () => {
    const symbolTable = paymentTable();
    const call: CallRef = { callText: "refund", receiver: null, member: "refund", startLine: 1 };
    expect(resolveConventionReceiverTarget(call, ctx({ symbolTable }), cfg.mode)).toBeNull();
  });
});

describe("RubyCallResolver — convention receiver in the chain (bd tea-rags-mcp-wob7g)", () => {
  it("resolves a convention-typed bare receiver end to end", () => {
    const resolver = new RubyCallResolver();
    const symbolTable = paymentTable();
    const call: CallRef = { callText: "payment.refund", receiver: "payment", member: "refund", startLine: 1 };
    expect(resolver.resolve(call, ctx({ symbolTable }))?.targetSymbolId).toBe("Payment#refund");
  });

  it("leaves a polymorphic-base receiver unresolved through the whole chain", () => {
    const resolver = new RubyCallResolver();
    const symbolTable = tableWith([
      "app/models/actor.rb",
      [
        sym("Actor", "Actor", "app/models/actor.rb", []),
        sym("Actor#deliver", "deliver", "app/models/actor.rb", ["Actor"]),
      ],
    ]);
    const hierarchy = hierarchyOf({ Actor: ["System", "Guest"] });
    const call: CallRef = { callText: "actor.deliver", receiver: "actor", member: "deliver", startLine: 1 };
    expect(resolver.resolve(call, ctx({ symbolTable, hierarchy }))).toBeNull();
  });
});
