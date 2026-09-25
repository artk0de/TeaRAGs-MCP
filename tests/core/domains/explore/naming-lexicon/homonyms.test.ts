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

  it.each([
    [
      "ctx",
      [
        { typeName: "LogContext", shape: "FREE" as const },
        { typeName: "ProviderContext", shape: "FREE" as const },
        { typeName: "ReindexContext", shape: "FREE" as const },
      ],
    ],
    [
      "cfg",
      [
        { typeName: "IngestConfig", shape: "FREE" as const },
        { typeName: "EmbeddingConfig", shape: "FREE" as const },
      ],
    ],
    [
      "req",
      [
        { typeName: "ActionDispatch::Request", shape: "FREE" as const },
        { typeName: "HttpRequest", shape: "FREE" as const },
      ],
    ],
    [
      "opts",
      [
        { typeName: "IndexOptions", shape: "FREE" as const },
        { typeName: "SearchOptions", shape: "FREE" as const },
      ],
    ],
    [
      "@ctx",
      [
        { typeName: "LogContext", shape: "FREE" as const },
        { typeName: "Context", shape: "FREE" as const },
      ],
    ],
  ])("`%s`: an abbreviation of the tail word every type shares is a role word, not a homonym", (name, types) => {
    expect(isTypeFamilyRoleName(types, name)).toBe(true);
  });

  it("`err`: a two-word type counts when the name abbreviates its first word (NodeJS.ErrnoException)", () => {
    expect(
      isTypeFamilyRoleName(
        [
          { typeName: "Error", shape: "FREE" },
          { typeName: "QuarantinableIngestError", shape: "FREE" },
          { typeName: "NodeJS.ErrnoException", shape: "FREE" },
        ],
        "err",
      ),
    ).toBe(true);
  });

  it("the first-word allowance stops at two words: `err` does not abbreviate the tail of ErrnoIngestException", () => {
    expect(
      isTypeFamilyRoleName(
        [
          { typeName: "Error", shape: "FREE" },
          { typeName: "ErrnoIngestException", shape: "FREE" },
        ],
        "err",
      ),
    ).toBe(false);
  });

  it("`run` is neither the tail nor an abbreviation of Handle / Marker / State — still a homonym", () => {
    expect(
      isTypeFamilyRoleName(
        [
          { typeName: "EnrichmentRunHandle", shape: "FREE" },
          { typeName: "RunMarker", shape: "FREE" },
          { typeName: "RunState", shape: "FREE" },
        ],
        "run",
      ),
    ).toBe(false);
  });

  it("`node` → AstNode / Content: one type the name neither ends nor abbreviates keeps the homonym", () => {
    expect(
      isTypeFamilyRoleName(
        [
          { typeName: "AstNode", shape: "TAIL" },
          { typeName: "Content", shape: "FREE" },
        ],
        "node",
      ),
    ).toBe(false);
  });

  it("an abbreviation starts with the word's first letter, is shorter than it, and spans at least two letters", () => {
    const family = (typeNames: string[]) => typeNames.map((typeName) => ({ typeName, shape: "FREE" as const }));
    // `tx` letters appear in `context` in order, but not from its first letter.
    expect(isTypeFamilyRoleName(family(["LogContext", "JobContext"]), "tx")).toBe(false);
    // the full word is EXACT / TAIL territory, decided by the shape, not by abbreviation.
    expect(isTypeFamilyRoleName(family(["LogContext", "JobContext"]), "context")).toBe(false);
    expect(isTypeFamilyRoleName(family(["LogContext", "JobContext"]), "c")).toBe(false);
    // out of order: `cxn` is not a subsequence of `context` (no `n` after the `x`).
    expect(isTypeFamilyRoleName(family(["LogContext", "JobContext"]), "cxn")).toBe(false);
    // letters only.
    expect(isTypeFamilyRoleName(family(["LogContext", "JobContext"]), "ctx2")).toBe(false);
  });

  it("an abbreviated role word over two classes sharing a last segment is still a real homonym", () => {
    expect(
      isTypeFamilyRoleName(
        [
          { typeName: "Billing::Context", shape: "FREE" },
          { typeName: "Search::Context", shape: "FREE" },
        ],
        "ctx",
      ),
    ).toBe(false);
  });

  it("fewer than two types is no family", () => {
    expect(isTypeFamilyRoleName([{ typeName: "Invoice", shape: "EXACT" }])).toBe(false);
    expect(isTypeFamilyRoleName([])).toBe(false);
  });
});
