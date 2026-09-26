import { describe, expect, it } from "vitest";

import type { IdentifierCasing } from "../../../../../src/core/contracts/types/language.js";
import type {
  NamingShapeDistribution,
  NamingShapeShare,
} from "../../../../../src/core/domains/explore/naming-lexicon/shapes.js";
import type { TypeNameRow } from "../../../../../src/core/domains/explore/naming-lexicon/type-roles.js";
import {
  judgeDraftName,
  judgeTypeDraft,
  typeDraftPopulation,
  typeNameEvidence,
} from "../../../../../src/core/domains/explore/naming-lexicon/verdicts.js";

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

  it("a FREE-dominant (role-naming) history accepts a role name it already uses", () => {
    expect(
      judgeDraftName({
        name: "item",
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

describe("judgeDraftName — a novel FREE name against a role-naming history (live: `x: SymbolDefinition`)", () => {
  // SymbolDefinition is named by role: FREE rows hold ~0.84 of the locals.
  const byTypeRows = [
    { kind: "local" as const, name: "defs", n: 10, exampleOwner: "Resolver#defs" },
    { kind: "local" as const, name: "candidates", n: 8, exampleOwner: "Resolver#candidates" },
    { kind: "local" as const, name: "fallback", n: 4, exampleOwner: "Resolver#fallback" },
    { kind: "local" as const, name: "definition", n: 3, exampleOwner: "Resolver#definition" },
    { kind: "local" as const, name: "target", n: 2, exampleOwner: "Resolver#target" },
    { kind: "local" as const, name: "hit", n: 1, exampleOwner: "Resolver#hit" },
  ];
  const judge = (name: string, rows: typeof byTypeRows = byTypeRows, kind: "local" | "return" = "local") =>
    judgeDraftName({ name, kind, typeName: "SymbolDefinition", casing: "camel", byTypeRows: rows });

  it("a FREE name the type's rows never use is a NEW_TERM carrying the type's top 5 names", () => {
    expect(judge("x")).toEqual({
      verdict: "NEW_TERM",
      topTerms: ["defs", "candidates", "fallback", "definition", "target"],
    });
  });

  it("a FREE name the type's rows already use conforms", () => {
    expect(judge("fallback")).toEqual({ verdict: "CONFORMS" });
  });

  it("a known name matches across casings (a snake row names the camel draft)", () => {
    const rows = [...byTypeRows, { kind: "local" as const, name: "best_match", n: 1, exampleOwner: "R#m" }];
    expect(judge("bestMatch", rows)).toEqual({ verdict: "CONFORMS" });
  });

  it("a non-FREE draft keeps the share judgement: an unused EXACT name is a MISFIT, not a NEW_TERM", () => {
    expect(judge("symbolDefinition")).toEqual({ verdict: "MISFIT", suggestion: "defs", holder: "Resolver#defs" });
  });

  it("the top names of other-kind rows are merged per name, heaviest first", () => {
    const rows = [
      { kind: "param" as const, name: "defs", n: 4, exampleOwner: "P#defs" },
      { kind: "field" as const, name: "defs", n: 4, exampleOwner: "F#defs" },
      { kind: "param" as const, name: "candidates", n: 6, exampleOwner: "P#candidates" },
    ];
    expect(judge("x", rows)).toEqual({ verdict: "NEW_TERM", topTerms: ["defs", "candidates"] });
  });

  it("a return draft is not a value draft: a FREE return keeps the share judgement", () => {
    const returns = [{ kind: "return" as const, name: "resolve", n: 10, exampleOwner: "R#resolve" }];
    expect(judge("lookup", returns, "return")).toEqual({ verdict: "CONFORMS" });
  });
});

describe("judgeDraftName — a QUALIFIED draft against co-occurrence-counted rows", () => {
  // `node` everywhere; `source_node` beside a second Node in its owner; `result_node` always alone.
  const qualifiedRows = [
    { kind: "local" as const, name: "node", n: 10, exampleOwner: "Graph#walk" },
    { kind: "local" as const, name: "source_node", n: 5, exampleOwner: "Graph#link", sameTypeSiblingN: 5 },
  ];
  const loneRows = [
    { kind: "local" as const, name: "node", n: 10, exampleOwner: "Graph#walk" },
    { kind: "local" as const, name: "result_node", n: 5, exampleOwner: "Graph#find", sameTypeSiblingN: 0 },
  ];
  const judge = (name: string, byTypeRows: typeof qualifiedRows) =>
    judgeDraftName({ name, kind: "local", typeName: "Node", casing: "snake", byTypeRows });

  it("conforms as QUALIFIED where the project qualifies second bindings", () => {
    expect(judge("target_node", qualifiedRows)).toEqual({ verdict: "CONFORMS" });
  });

  it("a lone qualifier the project already uses conforms as the FREE name it is", () => {
    expect(judge("result_node", loneRows)).toEqual({ verdict: "CONFORMS" });
  });

  it("a novel lone qualifier is a NEW_TERM carrying the type's names, not a MISFIT naming itself", () => {
    expect(judge("other_node", loneRows)).toEqual({ verdict: "NEW_TERM", topTerms: ["node", "result_node"] });
  });

  it("with neither QUALIFIED nor FREE rows to conform to, it is a MISFIT naming the canonical row", () => {
    const exactRows = [{ kind: "local" as const, name: "node", n: 10, exampleOwner: "Graph#walk" }];
    expect(judge("other_node", exactRows)).toEqual({ verdict: "MISFIT", suggestion: "node", holder: "Graph#walk" });
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

describe("judgeDraftName — a value draft whose type has only return rows (the live GitFileSignals shape)", () => {
  const conceptTerms = [{ term: "chunk", score: 2, holders: [OWNER] }];
  const ret = (name: string, n: number, exampleOwner: string, casing?: IdentifierCasing) => ({
    kind: "return" as const,
    name,
    n,
    exampleOwner,
    ...(casing ? { casing } : {}),
  });
  // On the self-index GitFileSignals has exactly these two rows, both returns.
  const byTypeRows = [
    ret("computeFileSignals", 1, "GitProvider#computeFileSignals"),
    ret("assembleFileSignals", 1, "Assembler#assembleFileSignals"),
  ];
  const draft = { typeName: "GitFileSignals", casing: "camel" as const, byTypeRows, conceptTerms };

  it("a name that does not spell the type is a MISFIT naming the noun the returns use", () => {
    expect(judgeDraftName({ ...draft, name: "meta" })).toEqual({
      verdict: "MISFIT",
      suggestion: "fileSignals",
      holder: "GitProvider#computeFileSignals",
    });
  });

  it("a name that spells the type conforms", () => {
    for (const name of ["fileSignals", "signals", "gitFileSignals"]) {
      expect(judgeDraftName({ ...draft, name }), name).toEqual({ verdict: "CONFORMS" });
    }
  });

  it("the most frequent noun wins, weighted by n; a return named after the type gives its full form", () => {
    expect(
      judgeDraftName({
        ...draft,
        name: "meta",
        byTypeRows: [ret("computeFileSignals", 1, "A#m"), ret("gitFileSignals", 3, "B#gitFileSignals")],
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: "gitFileSignals", holder: "B#gitFileSignals" });
  });

  it("the noun is rendered in the return row's own casing", () => {
    expect(
      judgeDraftName({
        ...draft,
        name: "meta",
        byTypeRows: [ret("compute_file_signals", 2, "R#compute_file_signals", "snake")],
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: "file_signals", holder: "R#compute_file_signals" });
  });

  it("returns carrying no type tail give nothing comparable: NEW_TERM with no terms, never CONFORMS", () => {
    expect(
      judgeDraftName({
        ...draft,
        name: "meta",
        byTypeRows: [ret("narrow", 2, "A#narrow"), ret("lookup", 1, "B#lookup")],
      }),
    ).toEqual({ verdict: "NEW_TERM", topTerms: [] });
  });

  it("with no comparable type row, bound-callee rows still judge before the NEW_TERM", () => {
    expect(
      judgeDraftName({
        ...draft,
        name: "meta",
        byTypeRows: [ret("narrow", 2, "A#narrow")],
        callee: { member: "load" },
        byCalleeRows: [{ member: "load", kind: "local", name: "signals", n: 5, exampleOwner: "C#run" }],
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: "signals", holder: "C#run" });
  });
});

describe("judgeDraftName — a typed draft whose type has history only in other kinds", () => {
  const conceptTerms = [
    { term: "chunk", score: 2, holders: [OWNER] },
    { term: "payload", score: 1, holders: [OWNER] },
  ];
  // GitFileSignals is held by params and fields; the draft is a local (the default kind).
  const byTypeRows = [
    { kind: "param" as const, name: "fileSignals", n: 4, exampleOwner: "Git#param" },
    { kind: "field" as const, name: "fileSignals", n: 4, exampleOwner: "Git#field" },
    { kind: "param" as const, name: "signals", n: 6, exampleOwner: "Git#signals" },
  ];

  it("is judged against those rows, weighted by n across kinds — never by the concept's terms", () => {
    expect(
      judgeDraftName({ name: "meta", typeName: "GitFileSignals", casing: "camel", byTypeRows, conceptTerms }),
    ).toEqual({ verdict: "MISFIT", suggestion: "fileSignals", holder: "Git#param" });
  });

  it("conforms when its shape holds the other kinds' rows", () => {
    expect(
      judgeDraftName({ name: "fileSignals", typeName: "GitFileSignals", casing: "camel", byTypeRows, conceptTerms }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  it("a typed draft with no history at all still takes the concept's terms", () => {
    expect(
      judgeDraftName({ name: "meta", typeName: "GitFileSignals", casing: "camel", byTypeRows: [], conceptTerms }),
    ).toEqual({ verdict: "NEW_TERM", topTerms: ["chunk", "payload"] });
  });

  it("an unlicensed return verb for a type with history names no concept terms", () => {
    expect(
      judgeDraftName({
        name: "buildMeta",
        kind: "return",
        typeName: "GitFileSignals",
        casing: "camel",
        byTypeRows,
        conceptTerms,
      }),
    ).toEqual({ verdict: "NEW_TERM", topTerms: [] });
  });
});

describe("judgeDraftName — a collection draft (typeMultiplicity many) against collection rows", () => {
  const many = (name: string, n: number) => ({ kind: "local" as const, name, n, exampleOwner: `Holder#${name}` });

  it("the plural the collection rows use conforms; the singular spelling is a MISFIT naming it", () => {
    const input = { typeName: "Item", casing: "camel" as const, typeMultiplicity: "many" as const };
    const byTypeRows = [many("items", 5), many("records", 1)];
    expect(judgeDraftName({ ...input, name: "items", byTypeRows })).toEqual({ verdict: "CONFORMS" });
    expect(judgeDraftName({ ...input, name: "item", byTypeRows })).toEqual({
      verdict: "MISFIT",
      suggestion: "items",
      holder: "Holder#items",
    });
  });

  it("number is induced from the rows: a project naming its collections singular accepts the singular", () => {
    expect(
      judgeDraftName({
        name: "item",
        typeName: "Item",
        casing: "camel",
        typeMultiplicity: "many",
        byTypeRows: [many("item", 5)],
      }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  it("a single-value draft keeps the number-blind judgement", () => {
    expect(judgeDraftName({ name: "items", typeName: "Item", casing: "camel", byTypeRows: [many("item", 5)] })).toEqual(
      { verdict: "CONFORMS" },
    );
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

/**
 * Type and constant drafts (bd tea-rags-mcp-vi0wx, spec §3–4): MISFIT when the
 * family or directory role is missing, COLLISION on an existing type's short
 * name in another module, NEW_TERM (soft, with `alternatives` when term
 * alignment finds candidates) otherwise unless role and terms align.
 */
describe("judgeTypeDraft", () => {
  function row(
    shortName: string,
    relPath: string,
    ancestors: string[] = [],
    symbolKind: TypeNameRow["symbolKind"] = "class",
  ): TypeNameRow {
    return { symbolId: shortName, relPath, shortName, symbolKind, ancestors };
  }
  /** Distinct single-word types spread over their own directories: population without roles. */
  function filler(count: number): TypeNameRow[] {
    return Array.from({ length: count }, (_, i) =>
      row(`Filler${String.fromCharCode(97 + (i % 26))}${i}`, `src/f${i}/x.ts`),
    );
  }
  const STRATEGIES = [
    row("TsStrategy", "src/lang/ts/strategy.ts", ["SymbolResolutionStrategy"]),
    row("PyStrategy", "src/lang/py/strategy.ts", ["SymbolResolutionStrategy"]),
    row("RubyStrategy", "src/lang/rb/strategy.ts", ["SymbolResolutionStrategy"]),
  ];
  const judge = (
    rows: readonly TypeNameRow[],
    draft: { name: string; path: string; extends?: string; symbolKind?: TypeNameRow["symbolKind"] },
    conceptNames: readonly string[] = [],
  ) =>
    judgeTypeDraft({
      ...draft,
      casing: "pascal",
      evidence: typeNameEvidence(rows, typeDraftPopulation(draft)),
      conceptNames,
    });

  // A project-wide popular suffix with no inheritance or directory anchor is a guess, not an expected role.
  describe("the project suffix only confirms", () => {
    // `options` is a project suffix (3 primary files, 3 dirs); src/explore/ has no directory role.
    const OPTIONS_ELSEWHERE = [
      row("PostProcessOptions", "src/explore/post-process.ts"),
      ...["Alpha", "Bravo", "Charlie", "Delta", "Echo"].map((name) =>
        row(name, `src/explore/${name.toLowerCase()}.ts`),
      ),
      row("IndexOptions", "src/a/index-options.ts"),
      row("RenderOptions", "src/b/render-options.ts"),
    ];

    it("`CalculatedDoc` in a directory with no directory role → not MISFIT", () => {
      expect(
        judge(OPTIONS_ELSEWHERE, { name: "CalculatedDoc", path: "src/explore/calculated-doc.ts" }).verdict,
      ).not.toBe("MISFIT");
    });

    it("`SearchOptions` there → CONFORMS", () => {
      expect(judge(OPTIONS_ELSEWHERE, { name: "SearchOptions", path: "src/explore/search-options.ts" })).toEqual({
        verdict: "CONFORMS",
      });
    });

    it("`SearchOptions` in a directory where no type carries the suffix → CONFORMS", () => {
      expect(judge(OPTIONS_ELSEWHERE, { name: "SearchOptions", path: "src/z/search-options.ts" })).toEqual({
        verdict: "CONFORMS",
      });
    });
  });

  it("a draft extending a family without the family's role → MISFIT naming name + role", () => {
    expect(
      judge(STRATEGIES, {
        name: "ResolutionOutcome",
        path: "src/core/domains/language/x/strategies/new.ts",
        extends: "SymbolResolutionStrategy",
      }),
    ).toMatchObject({
      verdict: "MISFIT",
      suggestion: "ResolutionOutcomeStrategy",
      role: { word: "strategy", evidence: "inheritance" },
    });
  });

  it("a draft carrying the family role with established terms → CONFORMS", () => {
    expect(
      judge(STRATEGIES, { name: "GoStrategy", path: "src/lang/go/strategy.ts", extends: "SymbolResolutionStrategy" }),
    ).toEqual({ verdict: "CONFORMS" });
  });

  it("a short name that already exists as a type in another module → COLLISION naming it", () => {
    const rows = [...filler(6), row("Commit", "src/git/commit.ts")];
    expect(judge(rows, { name: "Commit", path: "src/vcs/commit.ts" })).toEqual({
      verdict: "COLLISION",
      existing: { symbolId: "Commit", relPath: "src/git/commit.ts" },
    });
  });

  it("the draft's own file and ambient `.d.ts` declarations are no collision", () => {
    const rows = [...filler(6), row("Commit", "src/vcs/commit.ts"), row("Commit", "types/global.d.ts")];
    expect(judge(rows, { name: "Commit", path: "src/vcs/commit.ts" }).verdict).not.toBe("COLLISION");
  });

  it("a duplicate (relPath, typeId) row — a Rust associated const in two impls — counts once", () => {
    // One `FooStore` read twice is not two types: no directory role from it.
    const rows = [...filler(3), row("FooStore", "src/stores/foo.ts"), row("FooStore", "src/stores/foo.ts")];
    expect(typeNameEvidence(rows, "type").roles).toEqual([]);
  });

  it("an unestablished qualifier with an established modifier lifted in the concept code → NEW_TERM + alternatives", () => {
    const rows = [
      ...filler(20),
      row("PredefinedTemplate", "src/templates/predefined.ts"),
      row("PredefinedField", "src/fields/predefined.ts"),
      row("InvoiceDoc", "src/docs/invoice.ts"),
    ];
    const verdict = judge(rows, { name: "CalculatedDoc", path: "src/docs/calculated.ts" }, [
      "PredefinedTemplate",
      "PredefinedField",
    ]);
    expect(verdict).toMatchObject({ verdict: "NEW_TERM" });
    expect(verdict.verdict === "NEW_TERM" ? verdict.alternatives?.[0] : undefined).toMatchObject({
      word: "predefined",
      heads: ["field", "template"],
      domains: ["src/fields", "src/templates"],
    });
  });

  it("offers no qualifier the draft already carries, and at most the three most lifted", () => {
    // Live on the self-index `CalculatedDoc` drew 17 alternatives, the first being its own head `doc`.
    const modifiers = ["Doc", "Alpha", "Bravo", "Charlie", "Delta"];
    const rows = [
      ...filler(40),
      ...modifiers.flatMap((word) => [
        row(`${word}Template`, `src/t/${word}.ts`),
        row(`${word}Field`, `src/f/${word}.ts`),
      ]),
    ];
    // Lift order: Alpha ×4, Bravo ×3, Charlie ×2, Delta ×1 hits, and `Doc` above them all.
    const conceptNames = [
      ...Array.from({ length: 5 }, () => "DocTemplate"),
      ...Array.from({ length: 4 }, () => "AlphaTemplate"),
      ...Array.from({ length: 3 }, () => "BravoTemplate"),
      ...Array.from({ length: 2 }, () => "CharlieTemplate"),
      "DeltaTemplate",
    ];
    const verdict = judge(rows, { name: "CalculatedDoc", path: "src/c/calculated.ts" }, conceptNames);
    expect(verdict.verdict === "NEW_TERM" ? verdict.alternatives?.map((a) => a.word) : undefined).toEqual([
      "alpha",
      "bravo",
      "charlie",
    ]);
  });

  it("nothing similar in the concept code → NEW_TERM with no alternatives", () => {
    const rows = [
      ...filler(20),
      row("PredefinedTemplate", "src/templates/p.ts"),
      row("PredefinedField", "src/fields/p.ts"),
    ];
    const verdict = judge(rows, { name: "CalculatedDoc", path: "src/docs/calculated.ts" }, []);
    expect(verdict).toEqual({ verdict: "NEW_TERM", topTerms: [] });
  });

  it("a head spelled against the project's dominant spelling → NEW_TERM with a head alternative, never MISFIT", () => {
    const docs = Array.from({ length: 12 }, (_, i) => row(`Kind${i}Doc`, `src/docs/k${i}.ts`));
    const rows = [...filler(6), ...docs, row("RawDocument", "src/raw/raw.ts")];
    const verdict = judge(rows, { name: "CalculatedDocument", path: "src/calc/calculated.ts" });
    expect(verdict.verdict).toBe("NEW_TERM");
    expect(verdict.verdict === "NEW_TERM" ? verdict.alternatives : undefined).toContainEqual(
      expect.objectContaining({ word: "doc", slot: "head" }),
    );
  });

  describe("constants — judged against the constant population, directory and suffix evidence only", () => {
    const constant = (name: string, relPath: string) => row(name, relPath, ["Ignored"], "constant");
    const PATTERNS = [
      constant("SPEC_PATTERN", "src/infra/patterns/spec.ts"),
      constant("TEST_PATTERN", "src/infra/patterns/test.ts"),
      constant("FIXTURE_PATTERN", "src/infra/patterns/fixture.ts"),
    ];

    it("a SCREAMING draft in a directory of `*_PATTERN` constants → MISFIT in the draft's casing", () => {
      const rows = [...filler(6), ...PATTERNS];
      expect(
        judgeTypeDraft({
          name: "VENDOR_GLOB",
          path: "src/infra/patterns/vendor.ts",
          casing: "screamingSnake",
          evidence: typeNameEvidence(rows, typeDraftPopulation({ name: "VENDOR_GLOB" })),
          conceptNames: [],
        }),
      ).toMatchObject({ verdict: "MISFIT", suggestion: "VENDOR_GLOB_PATTERN", role: { evidence: "directory" } });
    });

    it("never reads constants as an inheritance family, and never reports a COLLISION", () => {
      const rows = [...filler(6), ...PATTERNS, constant("DEFAULT_LIMIT", "src/a/limits.ts")];
      const evidence = typeNameEvidence(rows, "constant");
      expect(evidence.roles.map((r) => r.evidence)).not.toContain("inheritance");
      expect(
        judgeTypeDraft({
          name: "DEFAULT_LIMIT",
          path: "src/b/limits.ts",
          casing: "screamingSnake",
          evidence,
          conceptNames: [],
        }).verdict,
      ).not.toBe("COLLISION");
    });

    it("the draft population: an explicit symbolKind, else SCREAMING casing → constant", () => {
      expect(typeDraftPopulation({ name: "MAX_RETRIES" })).toBe("constant");
      expect(typeDraftPopulation({ name: "maxRetries", symbolKind: "constant" })).toBe("constant");
      expect(typeDraftPopulation({ name: "RetryPolicy" })).toBe("type");
    });
  });
});
