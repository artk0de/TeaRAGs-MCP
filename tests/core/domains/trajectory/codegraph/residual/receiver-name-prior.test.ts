import { describe, expect, it } from "vitest";

import {
  NAME_PRIOR,
  nameMatchedClasses,
  receiverNameOf,
  receiverNameRank,
} from "../../../../../../src/core/domains/trajectory/codegraph/residual/receiver-name-prior.js";

describe("receiverNameOf", () => {
  it.each([
    ["@invoice", "invoice"],
    ["@@registry", "registry"],
    ["order.line_items", "line_items"],
    ["Current.user", "user"],
    ["record.firm(x)", "firm"],
    ["build(foo(1), bar).payment_webhook", "payment_webhook"],
    ["Billing::Invoice", "Invoice"],
    ["items[0]", "items"],
    ["client&.account", "account"],
    ["valid?", "valid"],
  ])("reads the last segment of %s as %s", (receiver, name) => {
    expect(receiverNameOf(receiver)).toBe(name);
  });

  it("reads nothing from a receiver with no name", () => {
    expect(receiverNameOf("(a + b)")).toBeUndefined();
    expect(receiverNameOf("")).toBeUndefined();
  });
});

describe("receiverNameRank", () => {
  it.each([
    ["invoice", "Invoice", NAME_PRIOR.exact],
    ["result", "AbstractPolicy::Result", NAME_PRIOR.exact],
    ["invoiceItem", "Billing::InvoiceItem", NAME_PRIOR.exact],
    ["invoices", "Invoice", NAME_PRIOR.singular],
    ["companies", "Company", NAME_PRIOR.singular],
    ["addresses", "Address", NAME_PRIOR.singular],
    ["result", "PaymentResult", NAME_PRIOR.classSuffix],
    ["results", "KindOfService::PaymentResult", NAME_PRIOR.classSuffix],
    ["current_user", "User", NAME_PRIOR.reverseSuffix],
    ["signatory_users", "User", NAME_PRIOR.reverseSuffix],
    ["payment_webhook", "Webhook", NAME_PRIOR.reverseSuffix],
    ["currentUser", "User", NAME_PRIOR.reverseSuffix],
  ])("ranks %s against %s as %s", (name, cls, rank) => {
    expect(receiverNameRank(name, cls)).toBe(rank);
  });

  it.each([
    ["firm", "User"],
    ["id", "ProcessId"],
    ["user", "Username"],
    ["status", "Statu"],
  ])("finds no relation between %s and %s", (name, cls) => {
    expect(receiverNameRank(name, cls)).toBe(NAME_PRIOR.none);
  });
});

describe("nameMatchedClasses", () => {
  it("returns the name-matched classes best rank first, input order within a rank, never the rest", () => {
    const classes = ["Firm", "CurrentUser", "Admin::User", "Account", "User", "UserProfile"];

    expect(nameMatchedClasses("@current_user", classes)).toEqual(["CurrentUser", "Admin::User", "User"]);
  });

  it("matches nothing for a receiver with no name", () => {
    expect(nameMatchedClasses("(a || b)", ["User"])).toEqual([]);
  });
});
