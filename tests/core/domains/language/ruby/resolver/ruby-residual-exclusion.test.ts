/**
 * Residual exclusion (bd tea-rags-mcp-2m83f.34) — the Ruby answer to "is this
 * residual site one no model pick can make right?". Rule A (`schemaColumn`): a
 * bare receiver whose camelized name is the last segment of a model owning a
 * synthesized column named like the member, with no declared def on that model.
 * Rule B (`frameworkMember`): an ActiveRecord relation / ActiveStorage member on
 * a receiver chain that is a relation or an attachment proxy (bd tea-rags-mcp-2m83f.35:
 * a tail fact naming a class the project does not declare cannot reach a menu
 * candidate and leaves the agreement intact). Rule C (`timestampColumn`): the
 * Rails-managed `created_at` / `updated_at` on a bare receiver when no model
 * declares a def of that name.
 */
import { describe, expect, it } from "vitest";

import type { CallContext, CallRef, SymbolDefinition } from "../../../../../../src/core/contracts/types/codegraph.js";
import { RubyCallResolver } from "../../../../../../src/core/domains/language/ruby/resolver/ruby-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

function sym(symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition {
  return { symbolId, fqName: symbolId, shortName, relPath, scope };
}

function column(symbolId: string, shortName: string, relPath: string, scope: string[]): SymbolDefinition {
  return { ...sym(symbolId, shortName, relPath, scope), isSchemaColumn: true };
}

function modelTable(): InMemoryGlobalSymbolTable {
  const table = new InMemoryGlobalSymbolTable();
  table.upsertFile("app/models/getting_paid/refund.rb", [
    sym("GettingPaid::Refund", "Refund", "app/models/getting_paid/refund.rb", ["GettingPaid"]),
  ]);
  table.upsertFile("app/models/payment.rb", [
    sym("Payment", "Payment", "app/models/payment.rb", []),
    sym("Payment#state", "state", "app/models/payment.rb", ["Payment"]),
  ]);
  table.upsertFile("app/models/invoice.rb", [sym("Invoice#amount", "amount", "app/models/invoice.rb", ["Invoice"])]);
  table.upsertFile("app/models/document.rb", [
    sym("Document", "Document", "app/models/document.rb", []),
    sym("Document#attach", "attach", "app/models/document.rb", ["Document"]),
  ]);
  table.upsertFile("app/contracts/item.rb", [
    sym("Api::Item#updated_at", "updated_at", "app/contracts/item.rb", ["Api", "Item"]),
    sym("Api::Item#created_at", "created_at", "app/contracts/item.rb", ["Api", "Item"]),
    sym("Api::Item#amount", "amount", "app/contracts/item.rb", ["Api", "Item"]),
  ]);
  table.setSchemaColumns([
    column("GettingPaid::Refund#amount", "amount", "app/models/getting_paid/refund.rb", ["GettingPaid", "Refund"]),
    column("GettingPaid::Refund#amount=", "amount=", "app/models/getting_paid/refund.rb", ["GettingPaid", "Refund"]),
    column("GettingPaid::Refund#amount?", "amount?", "app/models/getting_paid/refund.rb", ["GettingPaid", "Refund"]),
    column("Payment#state", "state", "app/models/payment.rb", ["Payment"]),
    column("GettingPaid::Refund#created_at", "created_at", "app/models/getting_paid/refund.rb", [
      "GettingPaid",
      "Refund",
    ]),
    column("GettingPaid::Refund#updated_at", "updated_at", "app/models/getting_paid/refund.rb", [
      "GettingPaid",
      "Refund",
    ]),
    column("Payment#updated_at", "updated_at", "app/models/payment.rb", ["Payment"]),
  ]);
  return table;
}

function ctx(overrides: Partial<CallContext> = {}): CallContext {
  return {
    callerFile: "app/services/billing.rb",
    callerScope: ["Billing"],
    imports: [],
    symbolTable: modelTable(),
    ...overrides,
  };
}

const call = (receiver: string, member: string): CallRef => ({
  callText: `${receiver}.${member}`,
  receiver,
  member,
  startLine: 5,
});

const exclusion = (c: CallRef, context: CallContext = ctx()) => new RubyCallResolver().residualExclusion(c, context);

const RELATION_RETURNS = {
  "Contact.without_deleted": { form: "container", element: { form: "instance", name: "Contact" } },
  "Firm#contacts": { form: "container", element: { form: "instance", name: "Contact" } },
  "Document#file": { form: "instance", name: "ActiveStorage::Attached::One" },
  "Message.unread_by_fm": { form: "container", element: { form: "instance", name: "Message" } },
} as const satisfies CallContext["structuredReturnTypes"];

describe("RubyCallResolver#residualExclusion — schemaColumn", () => {
  it("excludes a column read on a receiver named after a namespaced model", () => {
    expect(exclusion(call("refund", "amount"))).toBe("schemaColumn");
  });

  it("excludes the column writer and predicate", () => {
    expect(exclusion(call("refund", "amount="))).toBe("schemaColumn");
    expect(exclusion(call("refund", "amount?"))).toBe("schemaColumn");
  });

  it("excludes an ivar receiver named after the model", () => {
    expect(exclusion(call("@refund", "amount"))).toBe("schemaColumn");
  });

  it("keeps a column the model shadows with a declared def", () => {
    expect(exclusion(call("@payment", "state"))).toBeNull();
  });

  it("keeps a receiver no model with that column is named after", () => {
    expect(exclusion(call("invoice", "amount"))).toBeNull();
  });

  it("keeps a chain receiver", () => {
    expect(exclusion(call("order.refund", "amount"))).toBeNull();
  });
});

describe("RubyCallResolver#residualExclusion — frameworkMember", () => {
  const railsCtx = (overrides: Partial<CallContext> = {}) =>
    ctx({ structuredReturnTypes: RELATION_RETURNS, ...overrides });

  it("excludes a relation member on a query-builder marker chain", () => {
    expect(exclusion(call("Product.ransack(q).result", "ids"), railsCtx())).toBe("frameworkMember");
  });

  it("excludes a relation member on a scope tail", () => {
    expect(exclusion(call("contacts.without_deleted", "includes"), railsCtx())).toBe("frameworkMember");
  });

  it("excludes a relation member on a concern scope tail, stated over the concern", () => {
    const concernScope = railsCtx({
      structuredReturnTypes: {
        "SoftDeletable#with_deleted": { form: "container", element: { form: "instance", name: "SoftDeletable" } },
      },
    });
    expect(exclusion(call("Contact.with_deleted", "pluck"), concernScope)).toBe("frameworkMember");
  });

  it("excludes a relation member on a collection association tail", () => {
    expect(exclusion(call("firm.contacts", "pluck"), railsCtx())).toBe("frameworkMember");
  });

  it("excludes an ActiveStorage member on an attachment tail", () => {
    expect(exclusion(call("document.file", "attach"), railsCtx())).toBe("frameworkMember");
    expect(exclusion(call("file", "attach"), railsCtx())).toBe("frameworkMember");
  });

  it("keeps a project member on a relation chain", () => {
    expect(exclusion(call(".select(1).without_deleted", "unread_by_fm"), railsCtx())).toBeNull();
  });

  it("keeps a relation member on a tail that is no relation", () => {
    expect(exclusion(call("invitation.owner", "includes"), railsCtx())).toBeNull();
  });

  it("keeps an ActiveStorage member on a relation tail", () => {
    expect(exclusion(call("firm.contacts", "attach"), railsCtx())).toBeNull();
  });

  it("keeps every framework member when the project declares no Rails gem", () => {
    const noRails = railsCtx({ declaredDependencies: new Set(["sinatra"]) });
    expect(exclusion(call("Product.ransack(q).result", "ids"), noRails)).toBeNull();
    expect(exclusion(call("document.file", "attach"), noRails)).toBeNull();
  });

  it("applies to a project that declares activerecord without rails", () => {
    const arOnly = railsCtx({ declaredDependencies: new Set(["activerecord"]) });
    expect(exclusion(call("firm.contacts", "pluck"), arOnly)).toBe("frameworkMember");
  });

  it("keeps a predicate member that is no framework member", () => {
    expect(exclusion(call("invitation", "pending?"), railsCtx())).toBeNull();
  });
});

describe("RubyCallResolver#residualExclusion — frameworkMember tails (bd tea-rags-mcp-2m83f.35)", () => {
  it("excludes a relation member on a scope a concern declares", () => {
    const returns = {
      "SoftDeletable.without_deleted": { form: "container", element: { form: "instance", name: "SoftDeletable" } },
    } as const satisfies CallContext["structuredReturnTypes"];
    const context = ctx({ structuredReturnTypes: returns });
    expect(exclusion(call("@actor.firm.contacts.without_deleted", "includes"), context)).toBe("frameworkMember");
  });

  it("excludes an ActiveStorage member when the tail's other facts name a class the project does not declare", () => {
    const returns = {
      ...RELATION_RETURNS,
      "Api::ShowSerializer::DocumentSerializer#file": { form: "instance", name: "File" },
    } as const satisfies CallContext["structuredReturnTypes"];
    expect(exclusion(call("document.file", "attach"), ctx({ structuredReturnTypes: returns }))).toBe("frameworkMember");
  });

  it("keeps an ActiveStorage member when another tail fact names a project class", () => {
    const returns = {
      ...RELATION_RETURNS,
      "Holder#file": { form: "instance", name: "Document" },
    } as const satisfies CallContext["structuredReturnTypes"];
    expect(exclusion(call("holder.file", "attach"), ctx({ structuredReturnTypes: returns }))).toBeNull();
  });

  it("keeps an ActiveStorage member when every tail fact names a class the project does not declare", () => {
    const returns = {
      "Api::ShowSerializer::DocumentSerializer#file": { form: "instance", name: "File" },
    } as const satisfies CallContext["structuredReturnTypes"];
    expect(exclusion(call("document.file", "attach"), ctx({ structuredReturnTypes: returns }))).toBeNull();
  });
});

describe("RubyCallResolver#residualExclusion — timestampColumn", () => {
  it("excludes updated_at and created_at on a bare receiver no model is named after", () => {
    expect(exclusion(call("doc", "updated_at"))).toBe("timestampColumn");
    expect(exclusion(call("@doc", "created_at"))).toBe("timestampColumn");
  });

  it("keeps a timestamp a model shadows with a declared def", () => {
    const table = modelTable();
    table.upsertFile("app/models/payment.rb", [
      sym("Payment", "Payment", "app/models/payment.rb", []),
      sym("Payment#state", "state", "app/models/payment.rb", ["Payment"]),
      sym("Payment#updated_at", "updated_at", "app/models/payment.rb", ["Payment"]),
    ]);
    expect(exclusion(call("record", "updated_at"), ctx({ symbolTable: table }))).toBeNull();
  });

  it("keeps a timestamp on a chain receiver", () => {
    expect(exclusion(call("result.data", "updated_at"))).toBeNull();
  });

  it("keeps a column that is no Rails timestamp", () => {
    expect(exclusion(call("doc", "amount"))).toBeNull();
    expect(exclusion(call("auto_topup.settings", "amount"))).toBeNull();
  });

  it("keeps a timestamp no model owns as a column", () => {
    const table = modelTable();
    table.setSchemaColumns([]);
    expect(exclusion(call("doc", "updated_at"), ctx({ symbolTable: table }))).toBeNull();
  });

  it("keeps a timestamp when the project declares no Rails gem", () => {
    expect(exclusion(call("doc", "updated_at"), ctx({ declaredDependencies: new Set(["sinatra"]) }))).toBeNull();
  });
});
