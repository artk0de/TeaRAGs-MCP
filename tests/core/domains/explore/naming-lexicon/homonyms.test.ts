import { describe, expect, it } from "vitest";

import {
  isTypeFamilyRoleName,
  mergeUnqualifiedTypeSpellings,
} from "../../../../../src/core/domains/explore/naming-lexicon/homonyms.js";

/**
 * Homonym false positives seen on live projects: the role word a type family
 * shares as its tail, and one class spelled qualified and unqualified.
 */
describe("mergeUnqualifiedTypeSpellings", () => {
  it("folds an unqualified spelling into the one qualified type sharing its last segment", () => {
    // Live: `@document` → TaxPreparation::Document (27) + Document (10).
    const merged = mergeUnqualifiedTypeSpellings([
      { typeName: "TaxPreparation::Document", n: 27, tag: "q" },
      { typeName: "Document", n: 10, tag: "u" },
    ]);
    expect(merged).toEqual([{ typeName: "TaxPreparation::Document", n: 37, tag: "q" }]);
  });

  it("merges a dotted namespace the same way, and re-sorts by count", () => {
    // Live: `request` → ActionDispatch::Request + Request.
    const merged = mergeUnqualifiedTypeSpellings([
      { typeName: "Request", n: 8 },
      { typeName: "Invoice", n: 6 },
      { typeName: "http.Request", n: 3 },
    ]);
    expect(merged).toEqual([
      { typeName: "http.Request", n: 11 },
      { typeName: "Invoice", n: 6 },
    ]);
  });

  it("keeps the unqualified spelling when two qualified types share its last segment — which one is unknown", () => {
    const types = [
      { typeName: "GrowthBilling::Subscription", n: 5 },
      { typeName: "Subscriptions::Subscription", n: 4 },
      { typeName: "Subscription", n: 3 },
    ];
    expect(mergeUnqualifiedTypeSpellings(types)).toEqual(types);
  });

  it("leaves types with distinct last segments alone", () => {
    const types = [
      { typeName: "Billing::Invoice", n: 5 },
      { typeName: "Bill", n: 4 },
    ];
    expect(mergeUnqualifiedTypeSpellings(types)).toEqual(types);
  });
});

describe("isTypeFamilyRoleName", () => {
  it.each([
    [
      "symbolTable",
      [
        { typeName: "InMemoryGlobalSymbolTable", shape: "TAIL" as const },
        { typeName: "GlobalSymbolTable", shape: "TAIL" as const },
      ],
    ],
    [
      "state",
      [
        { typeName: "ClientState", shape: "TAIL" as const },
        { typeName: "ChunkPhaseState", shape: "TAIL" as const },
        { typeName: "FilePhaseState", shape: "TAIL" as const },
        { typeName: "CodegraphRunState", shape: "TAIL" as const },
      ],
    ],
    [
      "connection",
      [
        { typeName: "Bookkeeping::QBO::Connection", shape: "EXACT" as const },
        { typeName: "Communication::TwilioConnection", shape: "TAIL" as const },
        { typeName: "GettingPaid::StripeConnection", shape: "TAIL" as const },
      ],
    ],
  ])("`%s`: every type ends in the name, each a different class — a role word, not a homonym", (_name, types) => {
    expect(isTypeFamilyRoleName(types)).toBe(true);
  });

  it("a type the name does not denote keeps the homonym (`result` → KindOfService::Result + Crm::Api::Account)", () => {
    expect(
      isTypeFamilyRoleName([
        { typeName: "KindOfService::Result", shape: "EXACT" },
        { typeName: "Crm::Api::Account", shape: "FREE" },
      ]),
    ).toBe(false);
  });

  it("two classes with one simple name in different namespaces are a real homonym (`subscription`)", () => {
    expect(
      isTypeFamilyRoleName([
        { typeName: "GrowthBilling::Subscription", shape: "EXACT" },
        { typeName: "Subscriptions::Subscription", shape: "EXACT" },
      ]),
    ).toBe(false);
  });

  it("a QUALIFIED shape is not a tail: the name says more than the type", () => {
    expect(
      isTypeFamilyRoleName([
        { typeName: "Invoice", shape: "QUALIFIED" },
        { typeName: "Payment", shape: "TAIL" },
      ]),
    ).toBe(false);
  });

  it("fewer than two types is no family", () => {
    expect(isTypeFamilyRoleName([{ typeName: "Invoice", shape: "EXACT" }])).toBe(false);
    expect(isTypeFamilyRoleName([])).toBe(false);
  });
});
