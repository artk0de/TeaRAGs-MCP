import { describe, expect, it } from "vitest";

import type { IdentifierCasing } from "../../../../../src/core/contracts/types/language.js";
import { judgeDraftName } from "../../../../../src/core/domains/explore/naming-lexicon/verdicts.js";

const TYPE = "TaxAutomationDocument";
const OWNER = "TaxPreparation::TaxAutomations::Syncer#call";

/** The taxdome conventions in the two casings a caller passes in (snake: Ruby locals, camel: TS locals). */
const CASINGS: {
  casing: IdentifierCasing;
  exact: string;
  verbType: string;
  draftReturn: string;
  defaultReturn: string;
  calleeMember: string;
}[] = [
  {
    casing: "snake",
    exact: "tax_automation_document",
    verbType: "find_tax_automation_document!",
    draftReturn: "find_vendor_envelope",
    defaultReturn: "find_tax_automation_document",
    calleeMember: "find_tax_automation_document!",
  },
  {
    casing: "camel",
    exact: "taxAutomationDocument",
    verbType: "findTaxAutomationDocument",
    draftReturn: "findVendorEnvelope",
    defaultReturn: "findTaxAutomationDocument",
    calleeMember: "findTaxAutomationDocument",
  },
];

describe.each(CASINGS)("judgeDraftName — typed draft ($casing)", (c) => {
  it("a role name against an EXACT-dominant history is a MISFIT naming the canonical name", () => {
    expect(
      judgeDraftName({
        name: "row",
        kind: "local",
        typeName: TYPE,
        casing: c.casing,
        byTypeRows: [{ kind: "local", name: c.exact, n: 212, exampleOwner: OWNER }],
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: c.exact, holder: OWNER });
  });

  it("the canonical name conforms", () => {
    expect(
      judgeDraftName({
        name: c.exact,
        kind: "local",
        typeName: TYPE,
        casing: c.casing,
        byTypeRows: [{ kind: "local", name: c.exact, n: 212, exampleOwner: OWNER }],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  it("a return off the VERB_TYPE convention is a MISFIT naming the history's return", () => {
    expect(
      judgeDraftName({
        name: c.draftReturn,
        kind: "return",
        typeName: TYPE,
        casing: c.casing,
        byTypeRows: [{ kind: "return", name: c.verbType, n: 4, exampleOwner: OWNER }],
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: c.verbType, holder: OWNER });
  });

  it("a return with no return rows (but a known type) gets the default verb form", () => {
    expect(
      judgeDraftName({
        name: c.draftReturn,
        kind: "return",
        typeName: TYPE,
        casing: c.casing,
        byTypeRows: [{ kind: "local", name: c.exact, n: 30, exampleOwner: OWNER }],
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: c.defaultReturn });
  });

  it("a VERB_TYPE return with no return rows conforms", () => {
    expect(
      judgeDraftName({
        name: c.defaultReturn,
        kind: "return",
        typeName: TYPE,
        casing: c.casing,
        byTypeRows: [{ kind: "local", name: c.exact, n: 30, exampleOwner: OWNER }],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  it("CALLEE_DERIVED suggestion when no type is known (find_x! → x)", () => {
    expect(
      judgeDraftName({ name: "row", kind: "local", casing: c.casing, callee: { member: c.calleeMember } }),
    ).toEqual({ verdict: "MISFIT", suggestion: c.exact });
  });

  it("a callee-derived name conforms when no type is known", () => {
    expect(
      judgeDraftName({ name: c.exact, kind: "local", casing: c.casing, callee: { member: c.calleeMember } }),
    ).toEqual({ verdict: "CONFORMS" });
  });
});

describe("judgeDraftName — typed draft share threshold", () => {
  const rows = [
    { kind: "local" as const, name: "tax_automation_document", n: 16, exampleOwner: OWNER },
    { kind: "local" as const, name: "document", n: 4, exampleOwner: "Other#m" },
  ];

  it("a shape holding ≥ 20% of the rows conforms", () => {
    expect(
      judgeDraftName({ name: "document", kind: "local", typeName: TYPE, casing: "snake", byTypeRows: rows }),
    ).toEqual({
      verdict: "CONFORMS",
    });
  });

  it("only rows of the draft's kind count; kind defaults to local", () => {
    expect(
      judgeDraftName({
        name: "row",
        typeName: TYPE,
        casing: "snake",
        byTypeRows: [...rows, { kind: "param", name: "row", n: 50, exampleOwner: "P#m" }],
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: "tax_automation_document", holder: OWNER });
  });

  it("a FREE-dominant (role-naming) history accepts a role name", () => {
    expect(
      judgeDraftName({
        name: "row",
        kind: "local",
        typeName: TYPE,
        casing: "snake",
        byTypeRows: [
          { kind: "local", name: "record", n: 10, exampleOwner: OWNER },
          { kind: "local", name: "item", n: 10, exampleOwner: OWNER },
        ],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });
});

describe("judgeDraftName — byCallee rows", () => {
  it("finder-typed rows of `TaxAutomationDocument.find` make a role name a MISFIT", () => {
    expect(
      judgeDraftName({
        name: "row",
        kind: "local",
        casing: "snake",
        callee: { member: "find", receiver: TYPE },
        byCalleeRows: [
          {
            member: "find",
            receiver: TYPE,
            kind: "local",
            name: "tax_automation_document",
            n: 30,
            exampleOwner: OWNER,
            typeName: TYPE,
          },
          {
            member: "find",
            receiver: TYPE,
            kind: "local",
            name: "document",
            n: 5,
            exampleOwner: "Other#m",
            typeName: TYPE,
          },
        ],
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: "tax_automation_document", holder: OWNER });
  });

  it("rows of another callee or receiver are ignored", () => {
    expect(
      judgeDraftName({
        name: "row",
        kind: "local",
        casing: "snake",
        callee: { member: "find", receiver: TYPE },
        byCalleeRows: [
          {
            member: "find",
            receiver: "Invoice",
            kind: "local",
            name: "invoice",
            n: 30,
            exampleOwner: OWNER,
            typeName: "Invoice",
          },
          {
            member: "find_by",
            receiver: TYPE,
            kind: "local",
            name: "tax_automation_document",
            n: 30,
            exampleOwner: OWNER,
          },
        ],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  it("untyped callee rows that name by role accept a role name", () => {
    expect(
      judgeDraftName({
        name: "row",
        kind: "local",
        casing: "camel",
        callee: { member: "query" },
        byCalleeRows: [
          { member: "query", kind: "local", name: "rows", n: 10, exampleOwner: OWNER },
          { member: "query", kind: "local", name: "result", n: 10, exampleOwner: OWNER },
        ],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  it("a callee-derived draft conforms against callee-derived rows", () => {
    expect(
      judgeDraftName({
        name: "tax_automation_document",
        kind: "local",
        casing: "snake",
        callee: { member: "find_tax_automation_document!" },
        byCalleeRows: [
          {
            member: "find_tax_automation_document!",
            kind: "local",
            name: "tax_automation_document",
            n: 9,
            exampleOwner: OWNER,
          },
        ],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });
});

describe("judgeDraftName — concept terms", () => {
  const conceptTerms = [
    { term: "tax_automation_document", score: 2.4, holders: [OWNER] },
    { term: "tax_automation", score: 2.4, holders: [OWNER] },
    { term: "tax", score: 2.4, holders: [OWNER] },
    { term: "sync", score: 0.9, holders: [OWNER] },
    { term: "workflow", score: 0.7, holders: [OWNER] },
    { term: "vendor", score: 0.1, holders: [OWNER] },
  ];

  it("an untyped draft sharing no word with the top 5 terms is a NEW_TERM", () => {
    expect(judgeDraftName({ name: "VendorEnvelopeSyncer", casing: "pascal", conceptTerms })).toEqual({
      verdict: "NEW_TERM",
      topTerms: ["tax_automation_document", "tax_automation", "tax", "sync", "workflow"],
    });
  });

  it("an untyped draft sharing a (singularized) word conforms", () => {
    expect(judgeDraftName({ name: "TaxAutomationDocumentsSyncer", casing: "pascal", conceptTerms })).toEqual({
      verdict: "CONFORMS",
    });
  });

  it("a typed draft whose type has no history falls back to the concept terms", () => {
    expect(
      judgeDraftName({
        name: "vendorEnvelope",
        typeName: "VendorEnvelope",
        casing: "camel",
        byTypeRows: [],
        conceptTerms,
      }),
    ).toMatchObject({ verdict: "NEW_TERM" });
  });
});

describe("judgeDraftName — nothing to judge against", () => {
  it("a typed draft whose type has no history and no concept is a NEW_TERM with no terms", () => {
    expect(judgeDraftName({ name: "envelope", typeName: "VendorEnvelope", casing: "snake", byTypeRows: [] })).toEqual({
      verdict: "NEW_TERM",
      topTerms: [],
    });
  });

  it("a primitive type is not judged by type", () => {
    expect(
      judgeDraftName({
        name: "label",
        typeName: "string",
        casing: "camel",
        byTypeRows: [{ kind: "local", name: "name", n: 100, exampleOwner: OWNER }],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  it("no type, callee or terms conforms", () => {
    expect(judgeDraftName({ name: "row", casing: "snake" })).toEqual({ verdict: "CONFORMS" });
  });
});
