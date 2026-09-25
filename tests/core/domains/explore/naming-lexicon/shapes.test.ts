import { describe, expect, it } from "vitest";

import type { IdentifierCasing } from "../../../../../src/core/contracts/types/language.js";
import {
  classifyNamingShape,
  isNonConceptType,
  isWeakerNamingShape,
  shapeDistribution,
} from "../../../../../src/core/domains/explore/naming-lexicon/shapes.js";

const TYPE = "TaxPreparation::TaxAutomationDocument";

/**
 * The same conventions rendered in two casings — the taxdome Ruby names (snake)
 * and their TypeScript equivalents (camel). Parameterized by the casing
 * argument, never by a language name.
 */
const CASES: {
  casing: IdentifierCasing;
  exact: string;
  plural: string;
  qualifiedSuffix: string;
  qualifiedPrefix: string;
  tail: string;
  qualifiedTail: string;
  verbType: string;
}[] = [
  {
    casing: "snake",
    exact: "tax_automation_document",
    plural: "tax_automation_documents",
    qualifiedSuffix: "tax_automation_document_ignored",
    qualifiedPrefix: "source_tax_automation_document",
    tail: "document",
    qualifiedTail: "source_document",
    verbType: "find_tax_automation_document!",
  },
  {
    casing: "camel",
    exact: "taxAutomationDocument",
    plural: "taxAutomationDocuments",
    qualifiedSuffix: "taxAutomationDocumentIgnored",
    qualifiedPrefix: "sourceTaxAutomationDocument",
    tail: "document",
    qualifiedTail: "sourceDocument",
    verbType: "findTaxAutomationDocument",
  },
];

describe.each(CASES)("classifyNamingShape ($casing)", (c) => {
  const typed = (name: string, kind: "local" | "return" = "local") =>
    classifyNamingShape({ name, typeName: TYPE, kind, casing: c.casing });

  it("EXACT — the rendered type", () => {
    expect(typed(c.exact)).toBe("EXACT");
    expect(typed(`@${c.exact}`)).toBe("EXACT");
  });

  it("EXACT — the plural of the rendered type", () => {
    expect(typed(c.plural)).toBe("EXACT");
  });

  it("QUALIFIED — the rendered type plus a qualifier suffix or prefix", () => {
    expect(typed(c.qualifiedSuffix)).toBe("QUALIFIED");
    expect(typed(c.qualifiedPrefix)).toBe("QUALIFIED");
  });

  it("TAIL — a proper suffix of the type's words", () => {
    expect(typed(c.tail)).toBe("TAIL");
    expect(typed(`${c.tail}s`)).toBe("TAIL");
  });

  it("TAIL — the name's own qualifier plus a proper suffix of the type's words", () => {
    expect(typed(c.qualifiedTail)).toBe("TAIL");
    expect(typed(`${c.qualifiedTail}s`)).toBe("TAIL");
  });

  it("VERB_TYPE — a verb prefix plus the type, on a return", () => {
    expect(typed(c.verbType, "return")).toBe("VERB_TYPE");
  });

  it("a verb-prefixed type name on a local is QUALIFIED, not VERB_TYPE", () => {
    expect(typed(c.verbType, "local")).toBe("QUALIFIED");
  });

  it("FREE — a role name", () => {
    expect(typed("row")).toBe("FREE");
  });
});

describe("classifyNamingShape — qualifier plus a proper suffix of the type's words", () => {
  const camel = (name: string, typeName: string) =>
    classifyNamingShape({ name, typeName, kind: "local", casing: "camel" });

  it.each([
    ["childNode", "AstNode"],
    ["semanticNode", "AstNode"],
    ["shardTree", "MerkleTree"],
    ["fileItems", "ChunkItem"],
    ["dbNames", "PhysicalCollectionName"],
    ["deferredChunkHandoff", "CodegraphChunkHandoff"],
  ])("%s : %s is TAIL", (name, typeName) => {
    expect(camel(name, typeName)).toBe("TAIL");
  });

  it.each([
    ["targetCollection", "PhysicalCollectionName"],
    ["allCollections", "PhysicalCollectionName"],
    ["row", "AstNode"],
    ["row", "CodegraphChunkHandoff"],
  ])("%s : %s is FREE — no proper suffix of the type's words ends the name", (name, typeName) => {
    expect(camel(name, typeName)).toBe("FREE");
  });

  it("a name spelling the full type words stays EXACT / QUALIFIED", () => {
    expect(camel("astNode", "AstNode")).toBe("EXACT");
    expect(camel("childAstNode", "AstNode")).toBe("QUALIFIED");
  });
});

describe("classifyNamingShape — EXACT is casing-sensitive", () => {
  it("a camel rendering in a snake convention is not EXACT", () => {
    expect(
      classifyNamingShape({ name: "taxAutomationDocument", typeName: TYPE, kind: "local", casing: "snake" }),
    ).not.toBe("EXACT");
  });
});

describe("classifyNamingShape — CALLEE_DERIVED", () => {
  it.each([
    ["snake", "tax_automation_document", "find_tax_automation_document!"],
    ["snake", "user", "load_user"],
    ["snake", "report", "build_report?"],
    ["camel", "taxAutomationDocument", "findTaxAutomationDocument"],
    ["camel", "user", "getUser"],
    ["camel", "session", "createSession"],
  ] as const)("(%s) %s bound from %s, no type", (casing, name, member) => {
    expect(classifyNamingShape({ name, kind: "local", casing, callee: { member } })).toBe("CALLEE_DERIVED");
  });

  it("a name equal to an un-prefixed callee member is callee-derived", () => {
    expect(
      classifyNamingShape({ name: "document", kind: "field", casing: "snake", callee: { member: "document" } }),
    ).toBe("CALLEE_DERIVED");
  });

  it("a bare verb callee (`Model.find`) derives no name", () => {
    expect(
      classifyNamingShape({
        name: "find",
        kind: "local",
        casing: "snake",
        callee: { member: "find", receiver: "TaxAutomationDocument" },
      }),
    ).toBe("FREE");
  });

  it("does not apply to params or returns", () => {
    expect(classifyNamingShape({ name: "user", kind: "param", casing: "snake", callee: { member: "load_user" } })).toBe(
      "FREE",
    );
  });

  it("a type-based shape wins over CALLEE_DERIVED", () => {
    expect(
      classifyNamingShape({
        name: "tax_automation_document",
        typeName: TYPE,
        kind: "local",
        casing: "snake",
        callee: { member: "find_tax_automation_document!" },
      }),
    ).toBe("EXACT");
  });

  it("without a type or callee everything is FREE", () => {
    expect(classifyNamingShape({ name: "tax_automation_document", kind: "local", casing: "snake" })).toBe("FREE");
  });
});

describe("shapeDistribution", () => {
  const rows = [
    { name: "tax_automation_document", n: 12 },
    { name: "document", n: 4 },
    { name: "row", n: 4 },
  ];

  it("weights shares by n, sorted by share, summing to 1", () => {
    const d = shapeDistribution(rows, { typeName: TYPE, kind: "local", casing: "snake" });
    expect(d.n).toBe(20);
    expect(d.shares).toEqual([
      { shape: "EXACT", share: 0.6 },
      { shape: "TAIL", share: 0.2 },
      { shape: "FREE", share: 0.2 },
    ]);
    expect(d.shares.reduce((sum, s) => sum + s.share, 0)).toBeCloseTo(1, 10);
  });

  it("confidence is (n/20)^2, capped at 1", () => {
    expect(shapeDistribution([{ name: "row", n: 10 }], { kind: "local", casing: "snake" }).confidence).toBeCloseTo(
      0.25,
    );
    expect(shapeDistribution([{ name: "row", n: 40 }], { kind: "local", casing: "snake" }).confidence).toBe(1);
  });

  it("an empty row set has no shares and zero confidence", () => {
    expect(shapeDistribution([], { typeName: TYPE, kind: "local", casing: "snake" })).toEqual({
      shares: [],
      n: 0,
      confidence: 0,
    });
  });

  it("a row's own type and callee override the context (byCallee rows)", () => {
    const d = shapeDistribution(
      [
        { name: "tax_automation_document", n: 3, typeName: TYPE },
        { name: "doc", n: 1 },
      ],
      { kind: "local", casing: "snake", callee: { member: "find", receiver: "TaxAutomationDocument" } },
    );
    expect(d.shares).toEqual([
      { shape: "EXACT", share: 0.75 },
      { shape: "FREE", share: 0.25 },
    ]);
  });
});

/** The language's list arrives from the descriptor (`naming.nonConceptTypes`); the lexicon only matches it. */
describe("isNonConceptType", () => {
  const RUBY_LIKE = ["String", "Integer", "Hash", "nil"];

  it.each(["String", "Integer", "Hash", "nil", "::String"])("%j is listed, so not a concept", (typeName) => {
    expect(isNonConceptType(typeName, RUBY_LIKE)).toBe(true);
  });

  it.each(["T", "K", ""])("%j — single-letter generics and the empty name are never concepts", (typeName) => {
    expect(isNonConceptType(typeName, [])).toBe(true);
  });

  it("matches the language's spelling exactly — no case folding", () => {
    expect(isNonConceptType("string", RUBY_LIKE)).toBe(false);
    expect(isNonConceptType("String", ["string"])).toBe(false);
  });

  it.each(["TaxAutomationDocument", "User", "::System", "TT"])("%s is a concept", (typeName) => {
    expect(isNonConceptType(typeName, RUBY_LIKE)).toBe(false);
  });
});

describe("isWeakerNamingShape", () => {
  it("orders EXACT > QUALIFIED > TAIL > (VERB_TYPE = CALLEE_DERIVED) > FREE", () => {
    expect(isWeakerNamingShape("TAIL", "FREE")).toBe(false);
    expect(isWeakerNamingShape("FREE", "TAIL")).toBe(true);
    expect(isWeakerNamingShape("FREE", "EXACT")).toBe(true);
    expect(isWeakerNamingShape("TAIL", "QUALIFIED")).toBe(true);
    expect(isWeakerNamingShape("QUALIFIED", "EXACT")).toBe(true);
    expect(isWeakerNamingShape("CALLEE_DERIVED", "TAIL")).toBe(true);
    expect(isWeakerNamingShape("FREE", "CALLEE_DERIVED")).toBe(true);
    expect(isWeakerNamingShape("EXACT", "FREE")).toBe(false);
  });

  it("equal strength is not weaker: VERB_TYPE and CALLEE_DERIVED share a rank, a shape never beats itself", () => {
    expect(isWeakerNamingShape("VERB_TYPE", "CALLEE_DERIVED")).toBe(false);
    expect(isWeakerNamingShape("CALLEE_DERIVED", "VERB_TYPE")).toBe(false);
    expect(isWeakerNamingShape("FREE", "FREE")).toBe(false);
  });
});
