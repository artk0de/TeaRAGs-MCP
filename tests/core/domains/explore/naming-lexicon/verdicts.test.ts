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
  typeDraftMeaningPairs,
  typeDraftPopulation,
  typeFamilyMembers,
  typeNameEvidence,
  withFamilyAnalogues,
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
    expect(judgeDraftName(untypedRow)).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: [] } });
  });

  it("a FREE-dominant prior → no callee-derived suggestion", () => {
    expect(judgeDraftName({ ...untypedRow, projectShapePrior: { local: FREE_PRIOR } })).toEqual({
      verdict: "NO_CONVENTION",
      prefer: { analogous: [] },
    });
  });

  it("a CALLEE_DERIVED-dominant prior of low confidence → no suggestion", () => {
    expect(
      judgeDraftName({
        ...untypedRow,
        projectShapePrior: { local: shapePrior([{ shape: "CALLEE_DERIVED", share: 0.9 }], 10) },
      }),
    ).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: [] } });
  });

  it("a CALLEE_DERIVED prior for another kind does not support this kind", () => {
    expect(judgeDraftName({ ...untypedRow, projectShapePrior: { field: CALLEE_DERIVED_PRIOR } })).toEqual({
      verdict: "NO_CONVENTION",
      prefer: { analogous: [] },
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

  // bd tea-rags-mcp-xsxkr: `node` only deletes the draft's qualifier — no rename demand, the canonical row is context.
  it("with neither QUALIFIED nor FREE rows to conform to, it is a NEW_TERM naming the canonical row", () => {
    const exactRows = [{ kind: "local" as const, name: "node", n: 10, exampleOwner: "Graph#walk" }];
    expect(judge("other_node", exactRows)).toEqual({ verdict: "NEW_TERM", topTerms: ["node"] });
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
      // bd tea-rags-mcp-xsxkr: with those rows ignored nothing compares the draft — not CONFORMS.
      // bd tea-rags-mcp-bjfa0: a bare verb on a constant receiver offers the receiver's words
      // (its head dropped, then whole) instead of an empty NEW_TERM; neither row's name is offered.
    ).toEqual({ verdict: "NEW_TERM", topTerms: ["tax_automation", "tax_automation_document"] });
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

  // bd tea-rags-mcp-hn2vt: a FREE shape share licenses the project's role names for this call, not any word.
  it("a FREE draft the callee's rows never use is a NEW_TERM carrying the names they do use", () => {
    expect(
      judgeDraftName({
        name: "thing",
        kind: "local",
        casing: "camel",
        callee: { member: "findByName", receiver: "registry" },
        byCalleeRows: [
          { member: "findByName", receiver: "registry", kind: "local", name: "entry", n: 5, exampleOwner: OWNER },
          { member: "findByName", receiver: "registry", kind: "local", name: "found", n: 1, exampleOwner: OWNER },
        ],
      }),
      // bd tea-rags-mcp-bjfa0: `found`, one owner's name, is that owner's context — not vocabulary to offer.
    ).toEqual({ verdict: "NEW_TERM", topTerms: ["entry"] });
  });

  it("a FREE draft a callee row already uses conforms, compared by words in either number", () => {
    const rows = [
      { member: "list", receiver: "registry", kind: "local" as const, name: "entries", n: 3, exampleOwner: OWNER },
    ];
    const judge = (name: string) =>
      judgeDraftName({
        name,
        kind: "local",
        casing: "camel",
        callee: { member: "list", receiver: "registry" },
        byCalleeRows: rows,
      });
    expect(judge("entries")).toEqual({ verdict: "CONFORMS" });
    expect(judge("entry")).toEqual({ verdict: "CONFORMS" });
    expect(judge("tmp")).toEqual({ verdict: "NEW_TERM", topTerms: ["entries"] });
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

  it("returns carrying no type tail give nothing comparable: NO_CONVENTION, never CONFORMS", () => {
    expect(
      judgeDraftName({
        ...draft,
        name: "meta",
        byTypeRows: [ret("narrow", 2, "A#narrow"), ret("lookup", 1, "B#lookup")],
      }),
    ).toEqual({ verdict: "NO_CONVENTION", prefer: { exact: "gitFileSignals", analogous: [] } });
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
  it("a typed draft whose type has no history and no concept is NO_CONVENTION", () => {
    expect(judgeDraftName({ name: "envelope", typeName: "VendorEnvelope", casing: "snake", byTypeRows: [] })).toEqual({
      verdict: "NO_CONVENTION",
      prefer: { exact: "vendor_envelope", analogous: [] },
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
      // bd tea-rags-mcp-xsxkr: not judged by type, and no use of `label` given — novel, never a MISFIT.
    ).toEqual({ verdict: "NO_CONVENTION", prefer: { analogous: [] } });
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

  // bd tea-rags-mcp-xsxkr: CONFORMS needs evidence — with nothing to compare, the name's own use elsewhere.
  it("no type, callee or terms: CONFORMS only when other rows carry the name, else novel", () => {
    expect(judgeDraftName({ name: "row", casing: "snake" })).toEqual({
      verdict: "NO_CONVENTION",
      prefer: { analogous: [] },
    });
    expect(judgeDraftName({ name: "row", casing: "snake", nameRows: 12 })).toEqual({ verdict: "CONFORMS" });
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
  /** bd tea-rags-mcp-xsxkr: a CONFORMS carrying the family role names it. */
  const STRATEGY_ROLE = {
    word: "strategy",
    evidence: "inheritance",
    examples: ["PyStrategy", "RubyStrategy", "TsStrategy"],
  };
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

    // bd tea-rags-mcp-xsxkr: the CONFORMS names the suffix it rests on.
    const OPTIONS_SUFFIX = {
      word: "options",
      evidence: "projectSuffix",
      examples: ["IndexOptions", "PostProcessOptions", "RenderOptions"],
    };

    it("`SearchOptions` there → CONFORMS", () => {
      expect(judge(OPTIONS_ELSEWHERE, { name: "SearchOptions", path: "src/explore/search-options.ts" })).toEqual({
        verdict: "CONFORMS",
        role: OPTIONS_SUFFIX,
      });
    });

    it("`SearchOptions` in a directory where no type carries the suffix → CONFORMS", () => {
      expect(judge(OPTIONS_ELSEWHERE, { name: "SearchOptions", path: "src/z/search-options.ts" })).toEqual({
        verdict: "CONFORMS",
        role: OPTIONS_SUFFIX,
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
    ).toEqual({ verdict: "CONFORMS", role: STRATEGY_ROLE });
  });

  // bd tea-rags-mcp-5ulz2, live on taxdome: `ExportAsyncWorkflow < Platform::Async::Workflow::Worker`
  // was MISFIT → `ExportAsyncWorkflowWorker`, the role of every class whose supertype ENDS in
  // `Worker`. The supertype's own subclasses are `*AsyncWorkflow`s: its nearest family decides.
  describe("a draft extending a namespaced supertype takes that supertype's family role", () => {
    const WORKERS = ["AccountsCleanup", "AccountsInvalidate", "Mailer"].map((q, i) =>
      row(`${q}Worker`, `app/workers/w${i}/${q.toLowerCase()}_worker.rb`, ["Sidekiq::Throttled::Worker"]),
    );
    const WORKFLOWS = ["Import", "Update"].map((q, i) =>
      row(`${q}AsyncWorkflow`, `app/workers/f${i}/${q.toLowerCase()}_async_workflow.rb`, [
        "Platform::Async::Workflow::Worker",
      ]),
    );
    const rows = [...filler(6), ...WORKERS, ...WORKFLOWS];
    const draft = (name: string) => ({
      name,
      path: "app/workers/x/documents/export_async_workflow.rb",
      extends: "Platform::Async::Workflow::Worker",
      symbolKind: "class" as const,
    });

    it("`ExportAsyncWorkflow` → CONFORMS with the `workflow` role and its `AsyncWorkflow` tail", () => {
      expect(judge(rows, draft("ExportAsyncWorkflow"))).toMatchObject({
        verdict: "CONFORMS",
        role: {
          word: "workflow",
          tail: "AsyncWorkflow",
          evidence: "inheritance",
          examples: ["ImportAsyncWorkflow", "UpdateAsyncWorkflow"],
        },
      });
    });

    // bd tea-rags-mcp-1ffi9 — an intentional invariant change, the user's decision: 5ulz2 judged
    // `ExportWorkflow` CONFORMS to the one-word `workflow` role. The written family's role is now
    // the tail its majority shares, and the team names these subclasses `*AsyncWorkflow`.
    it("`ExportWorkflow` → MISFIT → `ExportAsyncWorkflow`: the tail's qualifier goes before the head", () => {
      expect(judge(rows, draft("ExportWorkflow"))).toMatchObject({
        verdict: "MISFIT",
        suggestion: "ExportAsyncWorkflow",
        role: { word: "workflow", tail: "AsyncWorkflow", evidence: "inheritance" },
      });
    });

    it("`ExportJob` → MISFIT toward the sibling convention, the whole tail appended, never `…Worker`", () => {
      expect(judge(rows, draft("ExportJob"))).toMatchObject({
        verdict: "MISFIT",
        suggestion: "ExportJobAsyncWorkflow",
        role: { word: "workflow", tail: "AsyncWorkflow", evidence: "inheritance" },
      });
    });

    it("a draft ending in the tail's first words is completed, not repeated: `ExportAsync` → `ExportAsyncWorkflow`", () => {
      expect(judge(rows, draft("ExportAsync"))).toMatchObject({
        verdict: "MISFIT",
        suggestion: "ExportAsyncWorkflow",
      });
    });

    it("a qualifier the draft already carries elsewhere is moved, not repeated: `AsyncExportWorkflow` → `ExportAsyncWorkflow`", () => {
      expect(judge(rows, draft("AsyncExportWorkflow"))).toMatchObject({
        verdict: "MISFIT",
        suggestion: "ExportAsyncWorkflow",
      });
    });

    it("a family sharing only the head keeps `ExportWorkflow` CONFORMS, with no tail", () => {
      const split = [
        ...filler(6),
        ...WORKERS,
        row("ImportAsyncWorkflow", "app/workers/f0/import_async_workflow.rb", ["Platform::Async::Workflow::Worker"]),
        row("UpdateSyncWorkflow", "app/workers/f1/update_sync_workflow.rb", ["Platform::Async::Workflow::Worker"]),
      ];
      const verdict = judge(split, draft("ExportWorkflow"));
      expect(verdict).toMatchObject({ verdict: "CONFORMS", role: { word: "workflow" } });
      expect(verdict.verdict === "CONFORMS" && verdict.role?.tail).toBeFalsy();
    });
  });

  // bd tea-rags-mcp-1ffi9: a majority tail qualifier flipped 12 correct taxdome names; the tail's
  // qualifier words are unanimous among the head's names, so 6 of 11 `*DocumentNotification`s set none.
  it("`SignatureRequestNotification` among 11 notifications, 6 of them `*DocumentNotification`, CONFORMS", () => {
    const supertype = "TaxPreparation::Inbox::DocumentNotification";
    const notifications = [
      "ApprovedDocumentNotification",
      "RejectedDocumentNotification",
      "ClientUploadedDocumentsNotification",
      "ClientUploadedRequestedDocumentsNotification",
      "SharedDocumentNotification",
      "DeletedDocumentNotification",
      "DatevUploadNotification",
      "IrsTranscriptsDownloadedNotification",
      "SignedDocumentBySignerNotification",
      "VoidedSignatureRequestNotification",
      "ExpiredLinkNotification",
    ].map((name, i) => row(name, `app/models/tax_preparation/inbox/n${i}.rb`, [supertype]));
    const verdict = judge([...filler(6), ...notifications], {
      name: "SignatureRequestNotification",
      path: "app/models/tax_preparation/inbox/signature_request_notification.rb",
      extends: supertype,
      symbolKind: "class",
    });
    expect(verdict).toMatchObject({ verdict: "CONFORMS", role: { word: "notification", evidence: "inheritance" } });
    expect(verdict.verdict === "CONFORMS" && verdict.role?.tail).toBeFalsy();
  });

  it("a short name that already exists as a type in another module → COLLISION naming it", () => {
    const rows = [...filler(6), row("Commit", "src/git/commit.ts")];
    expect(judge(rows, { name: "Commit", path: "src/vcs/commit.ts" })).toEqual({
      verdict: "COLLISION",
      existing: { symbolId: "Commit", relPath: "src/git/commit.ts" },
    });
  });

  // bd tea-rags-mcp-icuxg: taxdome declares 260 Ruby `Result` types, one per namespace — a
  // convention, not a homonym. The bar is the project-suffix role's: ≥ 3 files in ≥ 2 directories.
  describe("a short name the project declares as its convention is no collision", () => {
    it("declared in 3 files across 2 directories → no COLLISION; the conventional name conforms", () => {
      const rows = [
        ...filler(6),
        row("Result", "app/policies/a/result.rb"),
        row("Result", "app/policies/b/result.rb"),
        row("Result", "app/services/c/result.rb"),
      ];
      expect(judge(rows, { name: "Result", path: "app/services/payments/result.rb" })).toEqual({
        verdict: "CONFORMS",
      });
    });

    it("declared in 3 files of one directory → still a COLLISION", () => {
      const rows = [
        ...filler(6),
        row("Result", "app/results/a.rb"),
        row("Result", "app/results/b.rb"),
        row("Result", "app/results/c.rb"),
      ];
      expect(judge(rows, { name: "Result", path: "app/services/payments/result.rb" }).verdict).toBe("COLLISION");
    });

    it("declared in 2 files across 2 directories → still a COLLISION", () => {
      const rows = [...filler(6), row("Result", "app/a/result.rb"), row("Result", "app/b/result.rb")];
      expect(judge(rows, { name: "Result", path: "app/services/payments/result.rb" })).toMatchObject({
        verdict: "COLLISION",
        existing: { relPath: "app/a/result.rb" },
      });
    });

    it("the draft's own file does not count toward the convention", () => {
      const rows = [
        ...filler(6),
        row("Result", "app/a/result.rb"),
        row("Result", "app/b/result.rb"),
        row("Result", "app/services/payments/result.rb"),
      ];
      expect(judge(rows, { name: "Result", path: "app/services/payments/result.rb" }).verdict).toBe("COLLISION");
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

  // bd tea-rags-mcp-433d2: a draft naming a known concept by a synonym head.
  describe("head alignment by meaning — anchored heads ranked by similarity to the draft's head", () => {
    const judgeBySimilarity = (
      rows: readonly TypeNameRow[],
      draft: { name: string; path: string; extends?: string },
      headSimilarity: ReadonlyMap<string, number>,
      conceptNames: readonly string[] = CONCEPT,
      usageEstablishedHeads?: ReadonlySet<string>,
    ) =>
      judgeTypeDraft({
        ...draft,
        casing: "pascal",
        evidence: typeNameEvidence(rows, "type"),
        conceptNames,
        // Similarity to the draft's head: the map is keyed by the other word.
        wordSimilarity: (a, b) => headSimilarity.get(b) ?? headSimilarity.get(a) ?? 0,
        // A constant null distribution: the floor is 0.5 whatever the number of comparisons.
        nullSimilarities: [0.5],
        ...(usageEstablishedHeads !== undefined ? { usageEstablishedHeads } : {}),
      });
    /** Type names in the code nearest the drafts' concepts: every candidate head below is grounded there. */
    const CONCEPT = ["IndexMetrics", "IndexStatus", "EmbeddingProvider", "SymbolResolutionStrategy", "GoResolver"];
    const METRICS = [
      ...filler(6),
      row("IndexMetrics", "src/dto/metrics.ts"),
      row("SignalMetrics", "src/signals/metrics.ts"),
      row("IndexStatus", "src/status/index.ts"),
      row("RunStatus", "src/run/status.ts"),
    ];

    it("a synonym head → NEW_TERM with the similar anchored head, its similarity and example types", () => {
      const verdict = judgeBySimilarity(
        METRICS,
        { name: "IndexNumbers", path: "src/api/numbers.ts" },
        new Map([
          ["metrics", 0.81],
          ["status", 0.3],
        ]),
      );
      expect(verdict).toMatchObject({
        verdict: "NEW_TERM",
        alternatives: [{ word: "metrics", slot: "head", similarity: 0.81, examples: ["IndexMetrics"] }],
      });
      expect(verdict.verdict === "NEW_TERM" ? verdict.alternatives : undefined).toHaveLength(1);
    });

    it("a similar head absent from the concept code is not offered — the word alone is too weak", () => {
      const verdict = judgeBySimilarity(
        METRICS,
        { name: "IndexNumbers", path: "src/api/numbers.ts" },
        new Map([["metrics", 0.81]]),
        ["IndexStatus"],
      );
      expect(verdict).toEqual({ verdict: "NEW_TERM", topTerms: [] });
    });

    it("only the most similar head is offered", () => {
      const verdict = judgeBySimilarity(
        METRICS,
        { name: "IndexNumbers", path: "src/api/numbers.ts" },
        new Map([
          ["metrics", 0.7],
          ["status", 0.8],
        ]),
      );
      expect(verdict.verdict === "NEW_TERM" ? verdict.alternatives?.map((a) => a.word) : undefined).toEqual(["status"]);
    });

    it("similarities without a floor (a population too small to measure) → no head alignment by meaning", () => {
      expect(
        judgeTypeDraft({
          name: "IndexNumbers",
          path: "src/api/numbers.ts",
          casing: "pascal",
          evidence: typeNameEvidence(METRICS, "type"),
          conceptNames: CONCEPT,
          wordSimilarity: () => 0.99,
        }),
      ).toEqual({ verdict: "NEW_TERM", topTerms: [] });
    });

    it("a similarity equal to the floor is not above it — the floor is what random pairs reach", () => {
      expect(
        judgeBySimilarity(METRICS, { name: "IndexNumbers", path: "src/api/numbers.ts" }, new Map([["metrics", 0.5]])),
      ).toEqual({ verdict: "NEW_TERM", topTerms: [] });
    });

    it("no similarity map (embedding unavailable) → no head alternative by meaning", () => {
      expect(judge(METRICS, { name: "IndexNumbers", path: "src/api/numbers.ts" })).toEqual({
        verdict: "NEW_TERM",
        topTerms: [],
      });
    });

    it("a CONFORMS by project suffix alone keeps its verdict and carries the alternatives", () => {
      const rows = [
        ...filler(6),
        row("FooBackend", "src/a/foo.ts"),
        row("BarBackend", "src/b/bar.ts"),
        row("BazBackend", "src/c/baz.ts"),
        row("EmbeddingProvider", "src/emb/provider.ts"),
        row("CodeProvider", "src/code/provider.ts"),
      ];
      expect(
        judgeBySimilarity(rows, { name: "EmbeddingBackend", path: "src/emb/backend.ts" }, new Map([["provider", 0.7]])),
      ).toMatchObject({ verdict: "CONFORMS", alternatives: [{ word: "provider", slot: "head", similarity: 0.7 }] });
    });

    it("a name carrying its expected (family) role gets no alternatives", () => {
      const rows = [...STRATEGIES, row("GoResolver", "src/lang/go/resolver.ts"), row("PyResolver", "src/r/py.ts")];
      expect(
        judgeBySimilarity(
          rows,
          { name: "GoStrategy", path: "src/lang/go/strategy.ts", extends: "SymbolResolutionStrategy" },
          new Map([["resolver", 0.9]]),
        ),
      ).toEqual({ verdict: "CONFORMS", role: STRATEGY_ROLE });
    });

    it("a spelling variant the similarity does not confirm is dropped (`splitter` is no `site`)", () => {
      const docs = Array.from({ length: 12 }, (_, i) => row(`Kind${i}Doc`, `src/docs/k${i}.ts`));
      const rows = [...filler(6), ...docs, row("RawDocument", "src/raw/raw.ts")];
      const draft = { name: "CalculatedDocument", path: "src/calc/calculated.ts" };
      expect(judgeBySimilarity(rows, draft, new Map([["doc", 0.2]]))).toEqual({ verdict: "NEW_TERM", topTerms: [] });
      expect(judgeBySimilarity(rows, draft, new Map([["doc", 0.9]]))).toMatchObject({
        alternatives: [{ word: "doc", slot: "head", similarity: 0.9 }],
      });
    });

    it("a head only one type carries is offered when usage establishes it", () => {
      const rows = [...filler(6), row("Reranker", "src/explore/reranker.ts"), row("RankModule", "src/explore/rank.ts")];
      const draft = { name: "SearchScorer", path: "src/explore/search-scorer.ts" };
      const similarity = new Map([["reranker", 0.8]]);
      expect(judgeBySimilarity(rows, draft, similarity, ["Reranker"])).toEqual({ verdict: "NEW_TERM", topTerms: [] });
      expect(judgeBySimilarity(rows, draft, similarity, ["Reranker"], new Set(["reranker"]))).toMatchObject({
        alternatives: [{ word: "reranker", slot: "head", examples: ["Reranker"] }],
      });
    });

    it("a directory word near a draft QUALIFIER → an alternative at the qualifier slot, naming what it replaces", () => {
      const rows = [
        ...filler(6),
        row("IndexFreshnessProbe", "src/maintenance/freshness/probe.ts"),
        row("CommitDriftMonitor", "src/maintenance/freshness/monitor.ts"),
      ];
      const verdict = judgeTypeDraft({
        name: "IndexStalenessChecker",
        path: "src/maintenance/freshness/staleness-checker.ts",
        casing: "pascal",
        evidence: typeNameEvidence(rows, "type"),
        // The concept code holds a type carrying the directory word: the term is grounded.
        conceptNames: ["IndexFreshnessProbe"],
        wordSimilarity: (a, b) => ([a, b].sort().join("|") === "freshness|staleness" ? 0.8 : 0.1),
        // A constant null distribution: the floor is 0.5 whatever the number of comparisons.
        nullSimilarities: [0.5],
      });
      expect(verdict).toMatchObject({
        verdict: "NEW_TERM",
        alternatives: [
          { word: "freshness", replaces: "staleness", similarity: 0.8, domains: ["src/maintenance/freshness"] },
        ],
      });
      expect(verdict.verdict === "NEW_TERM" ? verdict.alternatives?.[0] : undefined).not.toHaveProperty("slot");
    });

    it("a directory word near the draft's HEAD → an alternative at the head slot", () => {
      const rows = [
        ...filler(6),
        row("CodeChunker", "src/ingest/chunker/code.ts"),
        row("TextThing", "src/ingest/chunker/t.ts"),
      ];
      const verdict = judgeTypeDraft({
        name: "ChunkSplitter",
        path: "src/ingest/chunker/chunk-splitter.ts",
        casing: "pascal",
        evidence: typeNameEvidence(rows, "type"),
        conceptNames: ["TextThing", "CodeChunker"],
        wordSimilarity: (a, b) => ([a, b].sort().join("|") === "chunker|splitter" ? 0.7 : 0.1),
        // A constant null distribution: the floor is 0.5 whatever the number of comparisons.
        nullSimilarities: [0.5],
      });
      // `chunk` → `chunker` shares a stem and is not compared; `splitter` → `chunker` is.
      expect(verdict).toMatchObject({
        alternatives: [{ word: "chunker", slot: "head", replaces: "splitter", similarity: 0.7 }],
      });
    });

    describe("the floor is corrected for the number of pairs the draft is compared on (Šidák)", () => {
      /** 0.000, 0.001, … 1.000 — the q quantile is q: one comparison → floor 0.9, five → 0.979. */
      const UNIFORM = Array.from({ length: 1001 }, (_, i) => i / 1000);
      const judgeUniform = (rows: readonly TypeNameRow[], draft: { name: string; path: string }, similar: string) =>
        judgeTypeDraft({
          ...draft,
          casing: "pascal",
          evidence: typeNameEvidence(rows, "type"),
          conceptNames: rows.map((r) => r.shortName),
          wordSimilarity: (a, b) => ([a, b].includes(similar) ? 0.95 : 0.1),
          nullSimilarities: UNIFORM,
        });

      it("one candidate pair → floor 0.9: a 0.95 head is offered", () => {
        const rows = [...filler(6), row("IndexMetrics", "src/dto/metrics.ts"), row("RunMetrics", "src/r/metrics.ts")];
        expect(judgeUniform(rows, { name: "IndexNumbers", path: "src/api/numbers.ts" }, "metrics")).toMatchObject({
          alternatives: [{ word: "metrics", similarity: 0.95 }],
        });
      });

      it("five candidate pairs → floor 0.979: the same 0.95 head is not", () => {
        const heads = ["metrics", "status", "report", "summary", "digest"];
        const rows = [
          ...filler(6),
          ...heads.flatMap((head) => [
            row(`Index${head[0].toUpperCase()}${head.slice(1)}`, `src/a/${head}.ts`),
            row(`Run${head[0].toUpperCase()}${head.slice(1)}`, `src/b/${head}.ts`),
          ]),
        ];
        expect(judgeUniform(rows, { name: "IndexNumbers", path: "src/api/numbers.ts" }, "metrics")).toEqual({
          verdict: "NEW_TERM",
          topTerms: [],
        });
      });

      it("a pair reached both as a head candidate and as a directory word is one comparison", () => {
        const rows = [
          ...filler(6),
          row("CodeChunker", "src/ingest/chunker/code.ts"),
          row("TextChunker", "src/ingest/chunker/text.ts"),
        ];
        const pairs = typeDraftMeaningPairs(
          { name: "ChunkSplitter", path: "src/ingest/chunker/chunk-splitter.ts" },
          typeNameEvidence(rows, "type"),
          ["CodeChunker"],
        );
        // `splitter` / `chunker`: the directory's head AND the `chunker` directory word; `chunk` shares a stem.
        expect(pairs).toEqual([["splitter", "chunker"]]);
      });

      it("directory words add their pairs: a path-term-heavy draft pays for them", () => {
        const rows = [
          ...filler(6),
          row("IndexMetrics", "src/dto/metrics.ts"),
          row("RunMetrics", "src/r/metrics.ts"),
          // Concept types carrying the directory words `core`, `stats` and `report` ground them as path terms.
          row("CoreThing", "src/x/core.ts"),
          row("StatsThing", "src/x/stats.ts"),
          row("ReportThing", "src/x/report.ts"),
        ];
        // Alone: one pair (`numbers` / `metrics`) → offered at 0.95.
        expect(judgeUniform(rows, { name: "IndexNumbers", path: "src/api/numbers.ts" }, "metrics")).toMatchObject({
          alternatives: [{ word: "metrics" }],
        });
        // Under core/stats/report: 1 + 2 words × 3 terms = 7 pairs → floor 0.985, and nothing is offered.
        expect(
          judgeUniform(rows, { name: "IndexNumbers", path: "src/core/stats/report/numbers.ts" }, "metrics"),
        ).toEqual({ verdict: "NEW_TERM", topTerms: [] });
      });
    });

    it("a head a spelling variant already aligns gets no second head by meaning", () => {
      const docs = Array.from({ length: 12 }, (_, i) => row(`Calc${i}Doc`, `src/docs/k${i}.ts`));
      const rows = [...filler(6), ...docs, row("CalcSheet", "src/s/a.ts"), row("RawSheet", "src/s/b.ts")];
      const verdict = judgeBySimilarity(
        rows,
        { name: "CalcDocument", path: "src/calc/calculated.ts" },
        new Map([
          ["doc", 0.9],
          ["sheet", 0.95],
        ]),
        ["CalcSheet", "Calc0Doc"],
      );
      expect(verdict.verdict === "NEW_TERM" ? verdict.alternatives?.map((a) => a.word) : undefined).toEqual(["doc"]);
    });
  });

  // bd tea-rags-mcp-433d2 follow-up: live, `HeadCandidate` drew `markdown`, `git`, `commit` and
  // `MeaningGate` drew `documentation`, `is`, `similar` — lift over unrelated concept code picks noise.
  describe("a lexical qualifier alternative passes the same corrected floor as alignment by meaning", () => {
    const PREDEFINED = [
      ...filler(20),
      row("PredefinedTemplate", "src/templates/predefined.ts"),
      row("PredefinedField", "src/fields/predefined.ts"),
      row("InvoiceDoc", "src/docs/invoice.ts"),
    ];
    const CALCULATED = { name: "CalculatedDoc", path: "src/docs/calculated.ts" };
    const judgeQualifier = (
      rows: readonly TypeNameRow[],
      conceptNames: readonly string[],
      similarity: (a: string, b: string) => number,
      nullSimilarities: readonly number[],
    ) =>
      judgeTypeDraft({
        ...CALCULATED,
        casing: "pascal",
        evidence: typeNameEvidence(rows, "type"),
        conceptNames,
        wordSimilarity: similarity,
        nullSimilarities,
      });
    /** Similarity `value` for the one unordered pair `a|b` (sorted), 0.1 for every other. */
    const pairSimilarity = (pair: string, value: number) => (a: string, b: string) =>
      [a, b].sort().join("|") === pair ? value : 0.1;

    it("a lifted modifier not similar to the qualifier it replaces is dropped", () => {
      expect(
        judgeQualifier(PREDEFINED, ["PredefinedTemplate", "PredefinedField"], pairSimilarity("x|y", 0.9), [0.5]),
      ).toEqual({ verdict: "NEW_TERM", topTerms: [] });
    });

    it("a lifted modifier similar to the qualifier survives, naming the qualifier it replaces", () => {
      expect(
        judgeQualifier(
          PREDEFINED,
          ["PredefinedTemplate", "PredefinedField"],
          pairSimilarity("calculated|predefined", 0.8),
          [0.5],
        ),
      ).toMatchObject({
        verdict: "NEW_TERM",
        alternatives: [{ word: "predefined", replaces: "calculated", similarity: 0.8 }],
      });
    });

    it("each (qualifier, lifted modifier) pair is one of the draft's m comparisons", () => {
      const pairs = typeDraftMeaningPairs(CALCULATED, typeNameEvidence(PREDEFINED, "type"), [
        "PredefinedTemplate",
        "PredefinedField",
      ]);
      expect(pairs).toEqual([["calculated", "predefined"]]);
    });

    it("three lifted modifiers raise the floor: a 0.95 pair offered alone is not offered among three", () => {
      /** 0.000 … 1.000: one comparison → floor 0.9, three → 0.9655. */
      const UNIFORM = Array.from({ length: 1001 }, (_, i) => i / 1000);
      const similar = pairSimilarity("alpha|calculated", 0.95);
      const rows = [
        ...filler(40),
        ...["Alpha", "Bravo", "Charlie"].flatMap((word) => [
          row(`${word}Template`, `src/t/${word}.ts`),
          row(`${word}Field`, `src/f/${word}.ts`),
        ]),
      ];
      expect(judgeQualifier(rows, ["AlphaTemplate"], similar, UNIFORM)).toMatchObject({
        alternatives: [{ word: "alpha", replaces: "calculated", similarity: 0.95 }],
      });
      expect(judgeQualifier(rows, ["AlphaTemplate", "BravoTemplate", "CharlieTemplate"], similar, UNIFORM)).toEqual({
        verdict: "NEW_TERM",
        topTerms: [],
      });
    });
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

/**
 * Directory-role membership (bd tea-rags-mcp-tun7x). When the directory role's
 * family is cohesive — its carriers share a supertype — a draft whose known
 * supertypes (its `extends`, or an existing declaration's own supertypes) do
 * not include it is not a member: the directory role neither demands nor
 * confirms. Live control false flags: `RubyConeDispatchResolver` /
 * `RubyDynamicDispatchResolver` (`implements DispatchResolverComponent`) in
 * `ruby/resolver/strategies/` were MISFIT → `…Strategy`.
 */
describe("judgeTypeDraft — directory-role membership by the family's supertype", () => {
  const row = (shortName: string, relPath: string, ancestors: string[] = []): TypeNameRow => ({
    symbolId: shortName,
    relPath,
    shortName,
    symbolKind: "class",
    ancestors,
  });
  const STRATEGIES = [
    row("RubyBareCallStrategy", "src/strategies/bare-call.ts", ["SymbolResolutionStrategy"]),
    row("RubyConstantStrategy", "src/strategies/constant.ts", ["SymbolResolutionStrategy"]),
    row("RubySuperStrategy", "src/strategies/super.ts", ["SymbolResolutionStrategy"]),
    row("RubyConeDispatchResolver", "src/strategies/cone-dispatch.ts", ["DispatchResolverComponent"]),
  ];
  const ARGS = [
    row("CallArgs", "src/commands/call.ts"),
    row("DoctorArgs", "src/commands/doctor.ts"),
    row("PrimeArgs", "src/commands/prime.ts"),
    row("FormatProjectsOptions", "src/commands/projects-format.ts"),
  ];
  const judge = (rows: readonly TypeNameRow[], draft: { name: string; path: string; extends?: string }) =>
    judgeTypeDraft({ ...draft, casing: "pascal", evidence: typeNameEvidence(rows, "type"), conceptNames: [] });

  it("an existing type whose own supertypes miss the family's → no directory MISFIT", () => {
    expect(
      judge(STRATEGIES, { name: "RubyConeDispatchResolver", path: "src/strategies/cone-dispatch.ts" }).verdict,
    ).not.toBe("MISFIT");
  });

  it("a draft extending another supertype → no directory MISFIT", () => {
    expect(
      judge(STRATEGIES, {
        name: "RubyTableDispatchResolver",
        path: "src/strategies/table-dispatch.ts",
        extends: "DispatchResolverComponent",
      }).verdict,
    ).not.toBe("MISFIT");
  });

  it("a new draft with no declared supertype is judged as before: its supertypes are unknown", () => {
    expect(judge(STRATEGIES, { name: "CallSiteResolutionPass", path: "src/strategies/call-site.ts" })).toMatchObject({
      verdict: "MISFIT",
      suggestion: "CallSiteResolutionPassStrategy",
      role: { word: "strategy", evidence: "directory" },
    });
  });

  it("a family with no shared supertype keeps its directory MISFIT", () => {
    expect(judge(ARGS, { name: "FormatProjectsOptions", path: "src/commands/projects-format.ts" })).toMatchObject({
      verdict: "MISFIT",
      suggestion: "FormatProjectsOptionsArgs",
    });
  });

  // Live, after the membership rule `RubyDynamicDispatchResolver` became CONFORMS with the head
  // alternative `strategy` — the same demand the rule withdrew, offered by meaning instead.
  it("a known non-member is not offered the family's role word as a head by meaning", () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => row(`Filler${String.fromCharCode(97 + (i % 26))}${i}`, `src/f${i}/x.ts`)),
      ...STRATEGIES,
    ];
    const draft = { name: "RubyConeDispatchResolver", path: "src/strategies/cone-dispatch.ts" };
    const verdict = judgeTypeDraft({
      ...draft,
      casing: "pascal",
      evidence: typeNameEvidence(rows, "type"),
      conceptNames: ["RubyBareCallStrategy", "RubySuperStrategy"],
      wordSimilarity: (a, b) => ([a, b].sort().join("|") === "resolver|strategy" ? 0.9 : 0.1),
      nullSimilarities: [0.5],
    });
    expect(verdict).not.toMatchObject({ alternatives: [expect.objectContaining({ word: "strategy" })] });
    expect(
      typeDraftMeaningPairs(draft, typeNameEvidence(rows, "type"), ["RubyBareCallStrategy", "RubySuperStrategy"]),
    ).not.toContainEqual(["resolver", "strategy"]);
  });
});

/**
 * Version and ordinal tokens are not vocabulary (bd tea-rags-mcp-tun7x): `v1`
 * in `SparseV1VectorRebuild` names a value, not a concept, and `v11` in
 * `V11Store` is not a word another modifier could replace. Live control false
 * flag: `V11Store` got `v1` for `v11` (similarity 0.736).
 */
describe("judgeTypeDraft — a token with a digit is not a modifier", () => {
  const row = (shortName: string, relPath: string): TypeNameRow => ({
    symbolId: shortName,
    relPath,
    shortName,
    symbolKind: "class",
    ancestors: [],
  });
  const rows = [
    ...Array.from({ length: 20 }, (_, i) => row(`Filler${String.fromCharCode(97 + (i % 26))}${i}`, `src/f${i}/x.ts`)),
    row("SparseV1VectorRebuild", "src/sparse/rebuild.ts"),
    row("PayloadV1Set", "src/payload/set.ts"),
  ];

  it("`V11Store` gets no `v1` alternative", () => {
    expect(
      judgeTypeDraft({
        name: "V11Store",
        path: "src/migrations/v11.ts",
        casing: "pascal",
        evidence: typeNameEvidence(rows, "type"),
        conceptNames: ["SparseV1VectorRebuild", "PayloadV1Set"],
      }),
    ).toEqual({ verdict: "NEW_TERM", topTerms: [] });
  });
});

/**
 * A namespace draft (bd tea-rags-mcp-59q9c). A `module` not named for its file
 * wraps the file's subject — the same test that keeps it from being the file's
 * primary (bd tea-rags-mcp-49fsr) — so it is no member of the directory's role
 * family: neither a directory MISFIT nor a role confirmation. Live on taxdome:
 * `module GettingPaid` / `module Quickbooks` around a worker class in
 * `app/workers/getting_paid/quickbooks/` were MISFIT → `GettingPaidWorker`.
 */
describe("judgeTypeDraft — a namespace module is no member of the directory's role", () => {
  const DIR = "app/workers/getting_paid/quickbooks";
  const row = (shortName: string, relPath: string, symbolKind: TypeNameRow["symbolKind"] = "class"): TypeNameRow => ({
    symbolId: shortName,
    relPath,
    shortName,
    symbolKind,
    ancestors: [],
  });
  const WORKERS = ["ImportInvoicesWorker", "SyncPaymentsWorker", "PushCustomersWorker"].flatMap((name) => {
    const relPath = `${DIR}/${splitWords(name)}.rb`;
    return [row("GettingPaid", relPath, "module"), row("Quickbooks", relPath, "module"), row(name, relPath)];
  });
  function splitWords(name: string): string {
    return name.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase();
  }
  const judge = (draft: { name: string; path: string; symbolKind?: TypeNameRow["symbolKind"] }) =>
    judgeTypeDraft({ ...draft, casing: "pascal", evidence: typeNameEvidence(WORKERS, "type"), conceptNames: [] });

  it("a module not named for its file → no directory MISFIT, no role", () => {
    for (const name of ["GettingPaid", "Quickbooks"]) {
      const verdict = judge({ name, path: `${DIR}/sync_ledger_worker.rb`, symbolKind: "module" });
      expect(verdict.verdict).not.toBe("MISFIT");
      expect(verdict).not.toHaveProperty("role");
    }
  });

  it("a namespace module carrying the directory's role word is not CONFIRMED by it", () => {
    const verdict = judge({ name: "BackgroundWorker", path: `${DIR}/sync_ledger.rb`, symbolKind: "module" });
    expect(verdict).not.toEqual({ verdict: "CONFORMS" });
  });

  it("a module named for its file is the file's subject: the directory role still applies", () => {
    expect(judge({ name: "Quickbooks", path: `${DIR}/quickbooks.rb`, symbolKind: "module" })).toMatchObject({
      verdict: "MISFIT",
      suggestion: "QuickbooksWorker",
      role: { word: "worker", evidence: "directory" },
    });
  });

  it("a class of the same name is judged by the directory role", () => {
    expect(judge({ name: "GettingPaid", path: `${DIR}/sync_ledger_worker.rb`, symbolKind: "class" })).toMatchObject({
      verdict: "MISFIT",
      suggestion: "GettingPaidWorker",
    });
  });
});

/**
 * Project-suffix membership (bd tea-rags-mcp-49fsr): a suffix confirms only a draft that
 * belongs to its family, by the same test the derivation applies to an existing type —
 * the family's dominant declaration form, and its dominant supertype when the family is
 * cohesive. A draft whose kind or supertypes are unknown is confirmed as before. Live on
 * taxdome: `SendFailedPaymentNotification` (`include KindOfService`) and the
 * `module ClientPushBaseData` mixin were confirmed by `*Notification` / `*Data`.
 */
describe("judgeTypeDraft — a project suffix confirms only its family's members", () => {
  const row = (
    shortName: string,
    relPath: string,
    symbolKind: TypeNameRow["symbolKind"],
    ancestors: string[] = [],
  ): TypeNameRow => ({ symbolId: shortName, relPath, shortName, symbolKind, ancestors });
  const SERVICE_PATH = "app/services/billing/invoices/send_failed_payment_notification.rb";
  const MIXIN_PATH = "app/helpers/communication/client_push_base_data.rb";
  const ROWS = [
    ...["InvoicePaid", "ProposalSigned", "TaskAssigned"].map((q, i) =>
      row(`${q}Notification`, `app/models/n${i}/inbox/${q.toLowerCase()}_notification.rb`, "class", ["Notification"]),
    ),
    row("SendFailedPaymentNotification", SERVICE_PATH, "class", ["KindOfService"]),
    ...["Invoice", "Client", "Firm"].map((q, i) => row(`${q}Data`, `app/javascript/m${i}/${q}Data.ts`, "type_alias")),
    row("ClientPushBaseData", MIXIN_PATH, "module"),
  ];
  const judge = (draft: { name: string; path: string; extends?: string; symbolKind?: TypeNameRow["symbolKind"] }) =>
    judgeTypeDraft({ ...draft, casing: "pascal", evidence: typeNameEvidence(ROWS, "type"), conceptNames: [] });
  // bd tea-rags-mcp-xsxkr: a CONFORMS the suffix confirms names it.
  const NOTIFICATION_SUFFIX = {
    word: "notification",
    evidence: "projectSuffix",
    examples: ["InvoicePaidNotification", "ProposalSignedNotification", "TaskAssignedNotification"],
  };
  const DATA_SUFFIX = { word: "data", evidence: "projectSuffix" };

  // bd tea-rags-mcp-xsxkr: a CONFORMS may now carry its role, so "not confirmed" reads the verdict itself.
  it("an existing service outside the family's supertype is not confirmed by `*Notification`", () => {
    expect(judge({ name: "SendFailedPaymentNotification", path: SERVICE_PATH }).verdict).not.toBe("CONFORMS");
  });

  it("a draft extending another supertype is not confirmed by the suffix", () => {
    expect(
      judge({
        name: "SendReminderNotification",
        path: "app/services/billing/reminders/send_reminder_notification.rb",
        extends: "KindOfService",
      }).verdict,
    ).not.toBe("CONFORMS");
  });

  it("an existing class declaring no supertype is confirmed: declaring nothing is no evidence", () => {
    const path = "app/models/n9/inbox/digest_notification.rb";
    const rows = [...ROWS, row("DigestNotification", path, "class")];
    expect(
      judgeTypeDraft({
        name: "DigestNotification",
        path,
        casing: "pascal",
        evidence: typeNameEvidence(rows, "type"),
        conceptNames: [],
      }),
    ).toEqual({ verdict: "CONFORMS", role: NOTIFICATION_SUFFIX });
  });

  it("a draft extending a member of the family, through the project's own type, is confirmed", () => {
    expect(
      judge({
        name: "InvoiceOverdueNotification",
        path: "app/models/n8/inbox/invoice_overdue_notification.rb",
        extends: "InvoicePaidNotification",
      }),
    ).toEqual({ verdict: "CONFORMS", role: NOTIFICATION_SUFFIX });
  });

  it("a module draft is not confirmed by a family of type aliases", () => {
    expect(judge({ name: "ClientPushBaseData", path: MIXIN_PATH, symbolKind: "module" }).verdict).not.toBe("CONFORMS");
  });

  it("an existing module is judged by its own declaration kind", () => {
    expect(judge({ name: "ClientPushBaseData", path: MIXIN_PATH }).verdict).not.toBe("CONFORMS");
  });

  it("a member of the family's form is confirmed; a draft of unknown kind is confirmed as before", () => {
    const path = "app/javascript/m9/JobData.ts";
    expect(judge({ name: "JobData", path, symbolKind: "type_alias" })).toMatchObject({
      verdict: "CONFORMS",
      role: DATA_SUFFIX,
    });
    expect(judge({ name: "JobData", path })).toMatchObject({ verdict: "CONFORMS", role: DATA_SUFFIX });
  });
});

// A dispersed family's kind (bd tea-rags-mcp-49fsr): `KindOfService` commands are named for their
// action, never `*Service`; the kind is what the type IS, not a word its name owes.
describe("judgeTypeDraft — a kind not carried in names is never demanded", () => {
  const row = (shortName: string, relPath: string, ancestors: string[] = []): TypeNameRow => ({
    symbolId: shortName,
    relPath,
    shortName,
    symbolKind: "class",
    ancestors,
  });
  const ROWS = [
    { ...row("KindOfService", "app/lib/kind_of_service.rb"), symbolKind: "module" as const },
    row("SendFirmAttributes", "app/services/marketing/send_firm_attributes.rb", ["KindOfService"]),
    row("RenderShortcodeTexts", "app/services/crm/render_shortcode_texts.rb", ["KindOfService"]),
    row("CreateInvoice", "app/services/billing/create_invoice.rb", ["KindOfService"]),
    row("IssueRefund", "app/services/billing/issue_refund.rb", ["KindOfService"]),
  ];
  const judge = (name: string) =>
    judgeTypeDraft({
      name,
      path: "app/services/billing/invoices/send_failed_payment_notification.rb",
      extends: "KindOfService",
      casing: "pascal",
      evidence: typeNameEvidence(ROWS, "type"),
      conceptNames: [],
    });
  const SERVICE_ROLE = {
    word: "service",
    evidence: "inheritance",
    examples: ["CreateInvoice", "IssueRefund", "RenderShortcodeTexts"],
    carriedInName: false,
  };

  it("an action-named draft conforms, carrying the kind it takes", () => {
    expect(judge("SendFailedPaymentNotification")).toEqual({ verdict: "CONFORMS", role: SERVICE_ROLE });
  });

  it("a draft that does spell the kind is not flagged either", () => {
    expect(judge("SendFailedPaymentService")).toEqual({ verdict: "CONFORMS", role: SERVICE_ROLE });
  });
});

/**
 * Lexicon friction F4: a directory's role is read off each file's PRIMARY type,
 * so it holds only a draft that would be its file's primary. `ModelInfo`,
 * `LanguageVersionStamper` beside `IndexingOps` in an `*-ops.ts` file were
 * MISFIT → `…Ops`: helper declarations, never members of the `ops` family.
 */
describe("judgeTypeDraft — a directory's role holds its files' primaries only", () => {
  const row = (shortName: string, relPath: string, symbolKind: TypeNameRow["symbolKind"] = "class"): TypeNameRow => ({
    symbolId: shortName,
    relPath,
    shortName,
    symbolKind,
    ancestors: [],
  });
  const OPS = [
    row("IndexingOps", "src/ops/indexing-ops.ts"),
    row("SearchOps", "src/ops/search-ops.ts"),
    row("CollectionOps", "src/ops/collection-ops.ts"),
  ];
  const judge = (draft: {
    name: string;
    path: string;
    symbolKind?: TypeNameRow["symbolKind"];
    filePrimary?: boolean;
  }) =>
    judgeTypeDraft({
      ...draft,
      symbolKind: draft.symbolKind ?? undefined,
      casing: "pascal",
      evidence: typeNameEvidence(OPS, "type"),
      conceptNames: [],
    });

  it("an interface beside its file's primary class → no directory MISFIT, no role", () => {
    const verdict = judge({ name: "LanguageVersionStamper", path: "src/ops/indexing-ops.ts", symbolKind: "interface" });
    expect(verdict.verdict).not.toBe("MISFIT");
    expect(verdict).not.toHaveProperty("role");
  });

  it("a helper class beside its file's primary → no directory MISFIT either", () => {
    expect(judge({ name: "ModelInfo", path: "src/ops/indexing-ops.ts", symbolKind: "class" }).verdict).not.toBe(
      "MISFIT",
    );
  });

  it("the only declaration of a new file is its primary: the directory role still applies", () => {
    expect(judge({ name: "IndexDriftResetter", path: "src/ops/index-drift.ts", symbolKind: "class" })).toMatchObject({
      verdict: "MISFIT",
      suggestion: "IndexDriftResetterOps",
      role: { word: "ops", evidence: "directory" },
    });
  });

  it("diff mode says whether the draft is its file's primary: a secondary is not held", () => {
    const draft = { name: "IndexDriftResetter", path: "src/ops/index-drift.ts", symbolKind: "interface" as const };
    expect(judge({ ...draft, filePrimary: false }).verdict).not.toBe("MISFIT");
    expect(judge({ ...draft, filePrimary: true }).verdict).toBe("MISFIT");
  });
});

/**
 * Lexicon friction F3: a value draft whose type or call has too few owners to
 * hold a convention (no name carried by ≥ 2 of them) is no bare NEW_TERM an
 * agent re-justifies by hand — and no free choice either. It points at the
 * type's own spelling and at names by analogy: its thin rows, then its family.
 */
describe("judgeDraftName — NO_CONVENTION", () => {
  const registryField = { kind: "field" as const, name: "collectionRegistry", n: 1, exampleOwner: "Ops", holders: 1 };

  it("a field whose type one owner names: the type's spelling, and the owner's name by analogy", () => {
    expect(
      judgeDraftName({
        name: "projects",
        kind: "field",
        typeName: "CollectionRegistry",
        casing: "camel",
        byTypeRows: [registryField],
      }),
    ).toEqual({ verdict: "NO_CONVENTION", prefer: { exact: "collectionRegistry", analogous: ["collectionRegistry"] } });
  });

  it("a param of a type the project never binds: the type's spelling, nothing by analogy yet", () => {
    expect(judgeDraftName({ name: "callerSymbolId", kind: "param", typeName: "SymbolId", casing: "camel" })).toEqual({
      verdict: "NO_CONVENTION",
      prefer: { exact: "symbolId", analogous: [] },
    });
  });

  it("a collection draft is pointed at the plural spelling", () => {
    expect(
      judgeDraftName({ name: "ids", kind: "local", typeName: "SymbolId", typeMultiplicity: "many", casing: "snake" }),
    ).toEqual({ verdict: "NO_CONVENTION", prefer: { exact: "symbol_ids", analogous: [] } });
  });

  it("a return keeps NEW_TERM: a method name is judged by the method vocabulary", () => {
    expect(judgeDraftName({ name: "loadRegistry", kind: "return", typeName: "SymbolId", casing: "camel" })).toEqual({
      verdict: "NEW_TERM",
      topTerms: [],
    });
  });

  it("a name two owners share is a convention: it is demanded", () => {
    expect(
      judgeDraftName({
        name: "projects",
        kind: "field",
        typeName: "CollectionRegistry",
        casing: "camel",
        byTypeRows: [{ ...registryField, n: 2, holders: 2 }],
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: "collectionRegistry", holder: "Ops" });
  });
});

describe("typeFamilyMembers — the relatives a NO_CONVENTION draft is compared with", () => {
  const DECLARED = ["SymbolId", "CallerSymbolId", "CalleeSymbolId", "ProjectRegistry", "LanguageRegistry", "Reranker"];

  it("the types specializing it come first: `*SymbolId` for SymbolId", () => {
    expect(typeFamilyMembers("SymbolId", DECLARED)).toEqual(["CalleeSymbolId", "CallerSymbolId"]);
  });

  it("with none, its siblings by head word: `*Registry` for CollectionRegistry", () => {
    expect(typeFamilyMembers("CollectionRegistry", DECLARED)).toEqual(["LanguageRegistry", "ProjectRegistry"]);
  });

  it("a type with no relative has no family", () => {
    expect(typeFamilyMembers("ChunkGrouper", DECLARED)).toEqual([]);
  });
});

describe("withFamilyAnalogues", () => {
  const row = (name: string, holders: number, kind: "param" | "return" = "param") => ({
    kind,
    name,
    n: holders,
    exampleOwner: "X",
    holders,
  });

  it("appends the family's value names, most owners first, after the draft's own", () => {
    const verdict = { verdict: "NO_CONVENTION" as const, prefer: { exact: "symbolId", analogous: ["sid"] } };
    expect(
      withFamilyAnalogues(verdict, [row("callerId", 2), row("calleeSymbolId", 5), row("resolveCaller", 9, "return")]),
    ).toEqual({
      verdict: "NO_CONVENTION",
      prefer: { exact: "symbolId", analogous: ["sid", "calleeSymbolId", "callerId"] },
    });
  });

  it("leaves any other verdict alone", () => {
    const verdict = { verdict: "NEW_TERM" as const, topTerms: [] };
    expect(withFamilyAnalogues(verdict, [row("callerId", 2)])).toBe(verdict);
  });
});

/**
 * Spec 2026-09-28 naming coverage §D4: a `return` draft with no type and no
 * callee is judged by the project's METHOD vocabulary when the caller hands it
 * the evidence; without it the bare fallback stands.
 */
describe("judgeDraftName — an untyped method judged by the method vocabulary", () => {
  const vocabulary = {
    lexicon: new Set(["load", "fetch"]),
    headWords: [{ head: "load", headHolders: 3, headTails: 2, lastHolders: 0, valueCompounds: 0 }],
    lastWordNames: [{ shortName: "grand_total", holders: 2 }],
    declared: false,
  };

  it("a lexicon verb the project holds too rarely is a NEW_TERM offering the verbs it holds", () => {
    expect(judgeDraftName({ name: "fetch_user", kind: "return", casing: "snake", untypedMethod: vocabulary })).toEqual({
      verdict: "NEW_TERM",
      topTerms: ["load"],
    });
  });

  it("a verbless name declared nowhere else has no convention, only analogues", () => {
    expect(judgeDraftName({ name: "total", kind: "return", casing: "snake", untypedMethod: vocabulary })).toEqual({
      verdict: "NO_CONVENTION",
      prefer: { analogous: ["grand_total"] },
    });
  });

  it("a typed return keeps its type judgement: the method vocabulary is not read", () => {
    expect(
      judgeDraftName({
        name: "loadRegistry",
        kind: "return",
        typeName: "SymbolId",
        casing: "camel",
        untypedMethod: vocabulary,
      }),
    ).toEqual({ verdict: "NEW_TERM", topTerms: [] });
  });

  it("without the evidence an untyped return keeps the bare NEW_TERM", () => {
    expect(judgeDraftName({ name: "fetch_user", kind: "return", casing: "snake" })).toEqual({
      verdict: "NEW_TERM",
      topTerms: [],
    });
  });
});

// bd tea-rags-mcp-nfm4h: a return draft's verbatim name demand counts only the rows whose owner is of
// the draft's own kind — a module-level function is never told to take a framework override's name.
describe("judgeDraftName — the owner-kind gate on a return draft's rows", () => {
  const overrideRows = [
    {
      kind: "return" as const,
      name: "create",
      n: 4,
      holders: 4,
      exampleOwner: "CityViewSet#create",
      ownerKind: "method" as const,
    },
    {
      kind: "return" as const,
      name: "list",
      n: 3,
      holders: 3,
      exampleOwner: "CityViewSet#list",
      ownerKind: "method" as const,
    },
    {
      kind: "return" as const,
      name: "retrieve",
      n: 2,
      holders: 2,
      exampleOwner: "CityViewSet#retrieve",
      ownerKind: "method" as const,
    },
  ];
  const helper = {
    name: "listing_not_editable_response",
    kind: "return" as const,
    typeName: "Response",
    casing: "snake" as const,
  };

  it("a module-level function is not a MISFIT toward a method's name", () => {
    const verdict = judgeDraftName({ ...helper, ownerKind: "function", byTypeRows: overrideRows });
    expect(verdict.verdict).not.toBe("MISFIT");
  });

  it("a module-level function conforms to the functions that spell the type", () => {
    const functionRow = {
      kind: "return" as const,
      name: "geo_error_response",
      n: 1,
      holders: 1,
      exampleOwner: "geo_error_response",
      ownerKind: "function" as const,
    };
    expect(judgeDraftName({ ...helper, ownerKind: "function", byTypeRows: [...overrideRows, functionRow] })).toEqual({
      verdict: "CONFORMS",
    });
  });

  it("a row whose owner kind is unknown still counts", () => {
    const unknownOwner = overrideRows.map(({ ownerKind: _ownerKind, ...row }) => row);
    expect(judgeDraftName({ ...helper, ownerKind: "function", byTypeRows: unknownOwner })).toEqual({
      verdict: "MISFIT",
      suggestion: "create",
      holder: "CityViewSet#create",
    });
  });

  it("a draft whose owner kind is unknown is judged against every row, as before", () => {
    expect(judgeDraftName({ ...helper, byTypeRows: overrideRows })).toEqual({
      verdict: "MISFIT",
      suggestion: "create",
      holder: "CityViewSet#create",
    });
  });

  it("a method in a service class is still a MISFIT toward the services' `call`", () => {
    const callRows = [
      {
        kind: "return" as const,
        name: "call",
        n: 5,
        holders: 5,
        exampleOwner: "Billing::Charge#call",
        ownerKind: "method" as const,
      },
      {
        kind: "return" as const,
        name: "tax_preparation_result",
        n: 1,
        holders: 1,
        exampleOwner: "tax_preparation_result",
        ownerKind: "function" as const,
      },
    ];
    expect(
      judgeDraftName({
        name: "charge_result",
        kind: "return",
        typeName: "Result",
        casing: "snake",
        ownerKind: "method",
        byTypeRows: callRows,
      }),
    ).toEqual({ verdict: "MISFIT", suggestion: "call", holder: "Billing::Charge#call" });
  });
});
