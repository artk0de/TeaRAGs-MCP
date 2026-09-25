import { describe, expect, it } from "vitest";

import type { IdentifierCasing } from "../../../../../src/core/contracts/types/language.js";
import type {
  NamingShapeDistribution,
  NamingShapeShare,
} from "../../../../../src/core/domains/explore/naming-lexicon/shapes.js";
import { judgeDraftName } from "../../../../../src/core/domains/explore/naming-lexicon/verdicts.js";

const TYPE = "TaxAutomationDocument";
const OWNER = "TaxPreparation::TaxAutomations::Syncer#call";

/** A project-wide shape prior as the ops layer computes it: shares over `n` rows, confidence (n/20)^2 capped. */
function shapePrior(shares: NamingShapeShare[], n: number): NamingShapeDistribution {
  return { shares, n, confidence: Math.min(1, (n / 20) ** 2) };
}
const CALLEE_DERIVED_PRIOR = shapePrior(
  [
    { shape: "CALLEE_DERIVED", share: 0.7 },
    { shape: "FREE", share: 0.3 },
  ],
  400,
);
const FREE_PRIOR = shapePrior(
  [
    { shape: "FREE", share: 0.8 },
    { shape: "CALLEE_DERIVED", share: 0.2 },
  ],
  400,
);
const VERB_TYPE_PRIOR = shapePrior([{ shape: "VERB_TYPE", share: 1 }], 100);

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

  it("a return with no return rows takes the project's dominant return verb", () => {
    expect(
      judgeDraftName({
        name: c.draftReturn,
        kind: "return",
        typeName: TYPE,
        casing: c.casing,
        byTypeRows: [{ kind: "local", name: c.exact, n: 30, exampleOwner: OWNER }],
        projectShapePrior: { return: VERB_TYPE_PRIOR },
        projectReturnVerbs: [
          { verb: "find", share: 0.7 },
          { verb: "load", share: 0.3 },
        ],
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: c.defaultReturn });
  });

  it("a return in the project's dominant verb form conforms with no return rows", () => {
    expect(
      judgeDraftName({
        name: c.defaultReturn,
        kind: "return",
        typeName: TYPE,
        casing: c.casing,
        byTypeRows: [{ kind: "local", name: c.exact, n: 30, exampleOwner: OWNER }],
        projectShapePrior: { return: VERB_TYPE_PRIOR },
        projectReturnVerbs: [{ verb: "find", share: 0.7 }],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  it("CALLEE_DERIVED suggestion when no type is known and the project names after callees (find_x! → x)", () => {
    expect(
      judgeDraftName({
        name: "row",
        kind: "local",
        casing: c.casing,
        callee: { member: c.calleeMember },
        projectShapePrior: { local: CALLEE_DERIVED_PRIOR },
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: c.exact });
  });

  it("a callee-derived name conforms when no type is known and the project names after callees", () => {
    expect(
      judgeDraftName({
        name: c.exact,
        kind: "local",
        casing: c.casing,
        callee: { member: c.calleeMember },
        projectShapePrior: { local: CALLEE_DERIVED_PRIOR },
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });
});

/**
 * The fallbacks above apply a convention only when the project-wide prior shows
 * it; without that support the verdict is NEW_TERM and carries no suggestion —
 * the convention is induced from the distribution, never assumed.
 */
describe("judgeDraftName — fallbacks need project support", () => {
  const untypedRow = {
    name: "row",
    kind: "local" as const,
    casing: "snake" as const,
    callee: { member: "find_tax_automation_document!" },
  };

  it("no prior → no callee-derived suggestion", () => {
    expect(judgeDraftName(untypedRow)).toEqual({ verdict: "NEW_TERM", topTerms: [] });
  });

  it("a FREE-dominant prior → no callee-derived suggestion", () => {
    expect(judgeDraftName({ ...untypedRow, projectShapePrior: { local: FREE_PRIOR } })).toEqual({
      verdict: "NEW_TERM",
      topTerms: [],
    });
  });

  it("a CALLEE_DERIVED-dominant prior of low confidence → no suggestion", () => {
    expect(
      judgeDraftName({
        ...untypedRow,
        projectShapePrior: { local: shapePrior([{ shape: "CALLEE_DERIVED", share: 0.9 }], 10) },
      }),
    ).toEqual({ verdict: "NEW_TERM", topTerms: [] });
  });

  it("a CALLEE_DERIVED prior for another kind does not support this kind", () => {
    expect(judgeDraftName({ ...untypedRow, projectShapePrior: { field: CALLEE_DERIVED_PRIOR } })).toEqual({
      verdict: "NEW_TERM",
      topTerms: [],
    });
  });

  it("an unsupported fallback reports the concept's top terms", () => {
    const conceptTerms = [{ term: "tax_automation_document", score: 1, holders: [OWNER] }];
    expect(judgeDraftName({ ...untypedRow, projectShapePrior: { local: FREE_PRIOR }, conceptTerms })).toEqual({
      verdict: "NEW_TERM",
      topTerms: ["tax_automation_document"],
    });
  });

  it("a return with no return rows and no dominant verb gets no verb suggestion", () => {
    const typedReturn = {
      name: "find_vendor_envelope",
      kind: "return" as const,
      typeName: TYPE,
      casing: "snake" as const,
      byTypeRows: [{ kind: "local" as const, name: "tax_automation_document", n: 30, exampleOwner: OWNER }],
    };
    expect(judgeDraftName(typedReturn)).toEqual({ verdict: "NEW_TERM", topTerms: [] });
    expect(
      judgeDraftName({
        ...typedReturn,
        projectShapePrior: { return: VERB_TYPE_PRIOR },
        projectReturnVerbs: [
          { verb: "find", share: 0.4 },
          { verb: "load", share: 0.35 },
        ],
      }),
    ).toEqual({ verdict: "NEW_TERM", topTerms: [] });
    expect(
      judgeDraftName({
        ...typedReturn,
        projectShapePrior: { return: shapePrior([{ shape: "VERB_TYPE", share: 1 }], 5) },
        projectReturnVerbs: [{ verb: "find", share: 1 }],
      }),
    ).toEqual({ verdict: "NEW_TERM", topTerms: [] });
  });

  it("the suggested verb is the project's, not a hardcoded one", () => {
    expect(
      judgeDraftName({
        name: "find_vendor_envelope",
        kind: "return",
        typeName: TYPE,
        casing: "snake",
        byTypeRows: [{ kind: "local", name: "tax_automation_document", n: 30, exampleOwner: OWNER }],
        projectShapePrior: { return: VERB_TYPE_PRIOR },
        projectReturnVerbs: [
          { verb: "load", share: 0.2 },
          { verb: "fetch", share: 0.8 },
        ],
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: "fetch_tax_automation_document" });
  });

  it("an invented callee still yields its derived name — correct lexically", () => {
    // `x = find_vendor_envelope` in a project that names locals after their
    // callee: `vendor_envelope` IS the conventional local for that call, so this
    // function is right to suggest it. Whether `vendor_envelope` is a term the
    // project knows is not this draft's question — the callee
    // `find_vendor_envelope` is itself a draft, judged NEW_TERM by the concept
    // path, and that is where an invented term is caught.
    expect(
      judgeDraftName({
        name: "row",
        kind: "local",
        casing: "snake",
        callee: { member: "find_vendor_envelope" },
        projectShapePrior: { local: CALLEE_DERIVED_PRIOR },
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: "vendor_envelope" });
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

  it("a type the language lists as non-concept is not judged by type", () => {
    expect(
      judgeDraftName({
        name: "label",
        typeName: "string",
        casing: "camel",
        nonConceptTypes: ["string", "number"],
        byTypeRows: [{ kind: "local", name: "name", n: 100, exampleOwner: OWNER }],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  it("a type the language does not list is judged by type (no global stop-list)", () => {
    expect(
      judgeDraftName({
        name: "label",
        typeName: "string",
        casing: "camel",
        nonConceptTypes: ["String"],
        byTypeRows: [{ kind: "local", name: "string", n: 100, exampleOwner: OWNER }],
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: "string", holder: OWNER });
  });

  it("no type, callee or terms conforms", () => {
    expect(judgeDraftName({ name: "row", casing: "snake" })).toEqual({ verdict: "CONFORMS" });
  });
});
