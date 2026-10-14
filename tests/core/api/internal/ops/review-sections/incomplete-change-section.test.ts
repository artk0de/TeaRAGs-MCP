/**
 * `incompleteChangeSectionProvider` (bd tea-rags-mcp-89k7k.1.4 / the review
 * half of bd tea-rags-mcp-3kykc): a co-change partner of a diff file that the
 * diff does NOT touch is the finding — history says the two change together,
 * this change carries only one side. Partners inside the diff are not findings
 * (the change carries the pair); the cap keeps the section bounded.
 *
 * The coupling-statistics gate (bd tea-rags-mcp-89k7k.1.12): a finding must
 * ALSO pass the same machinery the whole-repo silent-coupling detector applies
 * — lift above chance, Wilson lower-bound strength clearing the
 * majority-floored Otsu cut over the corpus — and the partner's KIND tiers the
 * ranking: a missing test update first, a source partner on its evidence, a
 * documentation partner last, a generated artefact never.
 */
import { describe, expect, it } from "vitest";

import type { DiffScopeRead } from "../../../../../../src/core/api/internal/ops/diff-scope-reader.js";
import { incompleteChangeSectionProvider } from "../../../../../../src/core/api/internal/ops/review-sections/incomplete-change-section.js";
import type {
  ReviewSectionContext,
  ReviewTreeChunkRow,
} from "../../../../../../src/core/api/internal/ops/review-sections/index.js";
import type {
  IncompleteChangeCoveredPartner,
  IncompleteChangePartner,
} from "../../../../../../src/core/api/public/dto/review.js";
import type { TemporalCochangeEdgeWithLinkage } from "../../../../../../src/core/contracts/types/codegraph.js";

function edge(
  relPathA: string,
  relPathB: string,
  support: number,
  confidenceAB = 0.9,
  overrides: Partial<Pick<TemporalCochangeEdgeWithLinkage, "confidenceBA" | "lift" | "structurallyLinked">> = {},
): TemporalCochangeEdgeWithLinkage {
  return {
    relPathA,
    relPathB,
    support,
    confidenceAB,
    confidenceBA: 0.5,
    lift: 2,
    lastCoChangeAt: 1_700_000_000,
    sampleCommits: ["a1b2c3"],
    structurallyLinked: false,
    ...overrides,
  };
}

function scopeOf(files: string[], skipped = 0, pastCap: string[] = []): DiffScopeRead {
  return {
    workTree: "/w",
    base: "HEAD",
    mergeBase: "mb",
    notices: [],
    changedFiles: files.length + pastCap.length,
    wholeFiles: 0,
    files,
    touchedFiles: new Set([...files, ...pastCap]),
    addedRanges: new Map(),
    nonProduction: new Set(),
    skipped,
  };
}

function makeContext(
  edges: TemporalCochangeEdgeWithLinkage[],
  files: string[],
  skipped = 0,
  pastCap: string[] = [],
): ReviewSectionContext {
  return {
    scope: scopeOf(files, skipped, pastCap),
    graphDb: { readTemporalCochangeGraph: async () => undefined, readTemporalSymbolCommits: async () => undefined },
    temporalCochange: { meta: { head: "h" }, edges },
    temporalCochangeError: undefined,
    lexiconOps: undefined,
    addressing: {},
    collectionName: "c",
    windowMonths: 6,
    diffRequest: {},
  };
}

describe("incompleteChangeSectionProvider — isBuilt", () => {
  const cases: [string, ReviewSectionContext, { built: boolean; reason?: string }][] = [
    [
      "no codegraph reader",
      { ...makeContext([], []), graphDb: undefined },
      { built: false, reason: expect.stringMatching(/codegraph/) },
    ],
    [
      "temporal graph read failed",
      { ...makeContext([], []), temporalCochange: undefined, temporalCochangeError: "lock held" },
      { built: false, reason: expect.stringMatching(/lock held/) },
    ],
    [
      "no co-change build",
      { ...makeContext([], []), temporalCochange: null },
      { built: false, reason: expect.stringMatching(/no co-change build/) },
    ],
    ["built", makeContext([], []), { built: true }],
  ];
  it.each(cases)("%s", (_name, context, expected) => {
    expect(incompleteChangeSectionProvider.isBuilt(context)).toEqual(expected);
  });
});

describe("incompleteChangeSectionProvider — run", () => {
  it("reports a partner outside the diff, with the edge's numbers; a partner inside the diff is not a finding", async () => {
    const context = makeContext(
      [
        edge("src/a.ts", "src/partner.ts", 7, 0.9),
        edge("src/a.ts", "src/b.ts", 9, 0.95), // both sides in the diff
        edge("src/other.ts", "src/elsewhere.ts", 5), // neither side in the diff
      ],
      ["src/a.ts", "src/b.ts"],
    );
    const payload = (await incompleteChangeSectionProvider.run(context)) as {
      partners: IncompleteChangePartner[];
      strengthThreshold: number;
      strengthThresholdMethod: string;
    };
    // Three candidate edges are below the Otsu minimum population, so the cut
    // resolves to the strict majority floor — consumed honestly as `majority`.
    expect(payload.strengthThreshold).toBe(0.5);
    expect(payload.strengthThresholdMethod).toBe("majority");
    expect(payload.partners).toEqual([
      {
        file: "src/a.ts",
        missingPartner: "src/partner.ts",
        partnerKind: "source",
        support: 7,
        confidence: 0.9,
        // max(Wilson(7, 8), Wilson(7, 14)) — the 0.9 direction's lower bound.
        strength: 0.5291051942301385,
        lift: 2,
        structurallyLinked: false,
        lastCoChangeAt: 1_700_000_000,
      },
    ]);
  });

  it("uses the file's own direction: a diff file named as relPathB reports confidenceBA", async () => {
    const context = makeContext([edge("src/partner.ts", "src/b.ts", 9, 0.9)], ["src/b.ts"]);
    const payload = (await incompleteChangeSectionProvider.run(context)) as {
      partners: IncompleteChangePartner[];
    };
    expect(payload.partners).toEqual([
      {
        file: "src/b.ts",
        missingPartner: "src/partner.ts",
        partnerKind: "source",
        support: 9,
        confidence: 0.5,
        strength: 0.5958436145024278,
        lift: 2,
        structurallyLinked: false,
        lastCoChangeAt: 1_700_000_000,
      },
    ]);
  });

  it("keeps the 50 strongest findings and counts the cut", async () => {
    // Confidence 1.0 makes each partner's trials exactly its support, so
    // Wilson strength rises strictly with support — the cap is what is under
    // test, not the quantisation wobble of round(support/confidence).
    const edges = Array.from({ length: 60 }, (_, i) =>
      edge("src/a.ts", `src/p${String(i).padStart(2, "0")}.ts`, i + 40, 1),
    );
    const context = makeContext(edges, ["src/a.ts"]);
    const payload = (await incompleteChangeSectionProvider.run(context)) as {
      partners: IncompleteChangePartner[];
      truncated?: number;
    };
    expect(payload.partners).toHaveLength(50);
    expect(payload.truncated).toBe(10);
    // Strongest first: the last kept partner is p50 (support 50), p51..p59 cut.
    expect(payload.partners[0].missingPartner).toBe("src/p59.ts");
    expect(payload.partners[49].missingPartner).toBe("src/p10.ts");
  });

  it("an empty diff is a built section with no partners — a valid review answer", async () => {
    const payload = (await incompleteChangeSectionProvider.run(makeContext([], []))) as { partners: unknown[] };
    expect(payload.partners).toEqual([]);
  });

  // bd tea-rags-mcp-89k7k.7: a file past the reader's cap is not in the diff
  // set, so neither side of its pairs reads as "in the diff" — its missing
  // partners are never considered. The section-level `scopeSkippedFiles` is
  // the only signal that the listed findings are partial.
  it("a scope over the file cap marks the section partial — a skipped file's partners are never considered", async () => {
    const context = makeContext(
      [
        edge("src/a.ts", "src/reported.ts", 7), // the verdict the section does answer stays
        edge("src/past-cap.ts", "src/ghost.ts", 9), // skipped side: never considered, never reported
      ],
      ["src/a.ts"],
      1,
    );
    const payload = (await incompleteChangeSectionProvider.run(context)) as {
      partners: { file: string; missingPartner: string }[];
      scopeSkippedFiles?: number;
    };
    expect(payload.partners).toMatchObject([{ file: "src/a.ts", missingPartner: "src/reported.ts" }]);
    expect(payload.scopeSkippedFiles).toBe(1);
  });

  // bd tea-rags-mcp-lxbrr: live, 23 of 29 "missing" partners were files the
  // change touches but the cap did not scan. The cap limits the SOURCES; the
  // present set is the whole change.
  it("a partner the change touches past the cap is never missing; a partner outside the change still is", async () => {
    const context = makeContext(
      [
        edge("src/a.ts", "src/skipped.ts", 7), // partner changed, past the cap
        edge("src/deleted.ts", "src/a.ts", 7), // partner deleted by the change
        edge("src/a.ts", "src/untouched.ts", 7), // partner outside the change
      ],
      ["src/a.ts"],
      2,
      ["src/skipped.ts", "src/deleted.ts"],
    );
    const payload = (await incompleteChangeSectionProvider.run(context)) as {
      partners: { file: string; missingPartner: string }[];
      scopeSkippedFiles?: number;
    };
    expect(payload.partners.map((p) => [p.file, p.missingPartner])).toEqual([["src/a.ts", "src/untouched.ts"]]);
    expect(payload.scopeSkippedFiles).toBe(2);
  });

  it("an untruncated scope claims no partial marker — the findings are then whole", async () => {
    const payload = (await incompleteChangeSectionProvider.run(
      makeContext([edge("src/a.ts", "src/p.ts", 3)], ["src/a.ts"]),
    )) as { scopeSkippedFiles?: number };
    expect(payload.scopeSkippedFiles).toBeUndefined();
  });
});

describe("incompleteChangeSectionProvider — the coupling-statistics gate (bd tea-rags-mcp-89k7k.1.12)", () => {
  // A hub co-changes with everything at high raw support — under the old
  // raw-support ranking it owned the section (measured 2026-10-05: 234
  // findings dominated by a 32-commit contracts file). Both of its directions
  // are diluted across its own huge change count, so the Wilson lower bound
  // reads below the strict majority even where lift is far above chance.
  it("a hub partner that co-changes with every diff file at diluted rates does not surface — the Wilson gate kills what raw support used to rank first", async () => {
    const context = makeContext(
      [
        // Hub edges: support 20 of the app file's 40 changes (P=0.5) and of
        // the hub's 100 (P=0.2) — strength max(Wilson(20,40), Wilson(20,100))
        // = 0.352, below the 0.5 floor. One carries lift 2 (passes lift,
        // dies on strength), one lift 1 (dies on lift itself).
        edge("src/app1.ts", "src/hub.ts", 20, 0.5, { confidenceBA: 0.2, lift: 2 }),
        edge("src/app2.ts", "src/hub.ts", 20, 0.5, { confidenceBA: 0.2, lift: 1 }),
        edge("src/app3.ts", "src/hub.ts", 20, 0.5, { confidenceBA: 0.2, lift: 5 }),
        // A genuinely coupled partner in the same graph still surfaces.
        edge("src/app1.ts", "src/real.ts", 20, 0.95, { confidenceBA: 0.9, lift: 3 }),
      ],
      ["src/app1.ts", "src/app2.ts", "src/app3.ts"],
    );
    const payload = (await incompleteChangeSectionProvider.run(context)) as {
      partners: IncompleteChangePartner[];
    };
    expect(payload.partners.map((p) => p.missingPartner)).toEqual(["src/real.ts"]);
    expect(payload.partners.every((p) => p.missingPartner !== "src/hub.ts")).toBe(true);
  });

  it("a generated partner is excluded — a version-pins artefact is release noise, not a missing update", async () => {
    const context = makeContext(
      [
        edge("src/a.ts", "src/version-pins.generated.json", 30, 0.95, { confidenceBA: 0.9, lift: 5 }),
        edge("src/a.ts", "src/real.ts", 20, 0.95, { confidenceBA: 0.9, lift: 3 }),
      ],
      ["src/a.ts"],
    );
    const payload = (await incompleteChangeSectionProvider.run(context)) as {
      partners: IncompleteChangePartner[];
    };
    expect(payload.partners.map((p) => p.missingPartner)).toEqual(["src/real.ts"]);
  });

  // bd tea-rags-mcp-s2nes: a release bumps a version manifest with whatever
  // shipped — measured, plugin.json <-> ~22 skill/rule docs on half the
  // review runs of one session, every one dismissed as version-bump noise.
  it("a version-manifest partner is excluded and counted, never listed", async () => {
    const context = makeContext(
      [
        edge("src/a.ts", ".claude-plugin/tea-rags/.claude-plugin/plugin.json", 30, 0.95, {
          confidenceBA: 0.9,
          lift: 5,
        }),
        edge("package.json", "src/a.ts", 30, 0.9, { confidenceBA: 0.95, lift: 5 }),
        edge("src/a.ts", "src/real.ts", 20, 0.95, { confidenceBA: 0.9, lift: 3 }),
      ],
      ["src/a.ts"],
    );
    const payload = (await incompleteChangeSectionProvider.run(context)) as {
      partners: IncompleteChangePartner[];
      versionManifestPairs?: number;
    };
    expect(payload.partners.map((p) => p.missingPartner)).toEqual(["src/real.ts"]);
    expect(payload.versionManifestPairs).toBe(2);
  });

  it("a changed version manifest's own partners are excluded and counted, never listed", async () => {
    const context = makeContext(
      [
        edge(".claude-plugin/tea-rags/.claude-plugin/plugin.json", "docs/skill.md", 30, 0.95, {
          confidenceBA: 0.9,
          lift: 5,
        }),
        edge("src/b.ts", "package-lock.json", 30, 0.5, { confidenceBA: 0.95, lift: 5 }),
        edge("src/b.ts", "src/real.ts", 20, 0.95, { confidenceBA: 0.9, lift: 3 }),
      ],
      [".claude-plugin/tea-rags/.claude-plugin/plugin.json", "package-lock.json", "src/b.ts"],
    );
    const payload = (await incompleteChangeSectionProvider.run(context)) as {
      partners: IncompleteChangePartner[];
      versionManifestPairs?: number;
    };
    expect(payload.partners.map((p) => `${p.file} -> ${p.missingPartner}`)).toEqual(["src/b.ts -> src/real.ts"]);
    expect(payload.versionManifestPairs).toBe(1);
  });

  it("a missing TEST update is the first-class signal — it ranks above a stronger source partner", async () => {
    const context = makeContext(
      [
        // Test partner: strength 0.601 — weaker than the source partner's
        // 0.886, but the kind is the top tier.
        edge("src/a.ts", "src/a.test.ts", 12, 0.85, { confidenceBA: 0.8, lift: 3 }),
        edge("src/a.ts", "src/strong-source.ts", 30, 1, { confidenceBA: 0.95, lift: 3 }),
      ],
      ["src/a.ts"],
    );
    const payload = (await incompleteChangeSectionProvider.run(context)) as {
      partners: IncompleteChangePartner[];
    };
    expect(payload.partners).toHaveLength(2);
    expect(payload.partners[0]).toMatchObject({ missingPartner: "src/a.test.ts", partnerKind: "test" });
    expect(payload.partners[1]).toMatchObject({ missingPartner: "src/strong-source.ts", partnerKind: "source" });
  });

  it("a documentation partner surfaces in its own low tier, below every source partner", async () => {
    const context = makeContext(
      [
        edge("src/a.ts", "docs/guide.md", 20, 0.95, { confidenceBA: 0.9, lift: 3 }),
        edge("src/a.ts", "src/real.ts", 12, 0.85, { confidenceBA: 0.8, lift: 3 }),
      ],
      ["src/a.ts"],
    );
    const payload = (await incompleteChangeSectionProvider.run(context)) as {
      partners: IncompleteChangePartner[];
    };
    expect(payload.partners.map((p) => [p.missingPartner, p.partnerKind])).toEqual([
      ["src/real.ts", "source"],
      ["docs/guide.md", "documentation"],
    ]);
  });

  // The cut is drawn over the corpus's candidate strengths: four pairs at
  // ~0.55, the victim at 0.670, five at ~0.912 — Otsu splits between the
  // victim and the high mode (threshold 0.791, separability 0.962), so the
  // victim is above the majority floor yet below the corpus's own cut.
  it("a partner above the majority floor but below the corpus's Otsu cut is suppressed — the cut, consumed honestly", async () => {
    const corpus = [
      ...Array.from({ length: 4 }, (_, i) =>
        edge("corpus/low.ts", `corpus/peer${i}.ts`, 60, 0.65, { confidenceBA: 0.6, lift: 3 }),
      ),
      ...Array.from({ length: 4 }, (_, i) =>
        edge("corpus/high.ts", `corpus/mate${i}.ts`, 40, 1, { confidenceBA: 1, lift: 3 }),
      ),
    ];
    const context = makeContext(
      [
        ...corpus, // neither endpoint in the diff: draws the cut, never a finding
        edge("src/a.ts", "src/victim.ts", 40, 0.8, { confidenceBA: 0.8, lift: 3 }), // strength 0.670
        edge("src/a.ts", "src/keeper.ts", 40, 1, { confidenceBA: 1, lift: 3 }), // strength 0.912
      ],
      ["src/a.ts"],
    );
    const payload = (await incompleteChangeSectionProvider.run(context)) as {
      partners: IncompleteChangePartner[];
      strengthThreshold: number;
      strengthThresholdMethod: string;
      strengthSeparability?: number;
    };
    expect(payload.strengthThresholdMethod).toBe("otsu");
    expect(payload.strengthThreshold).toBeCloseTo(0.7910008699, 8);
    expect(payload.strengthSeparability).toBeCloseTo(0.9617920374, 8);
    expect(payload.partners.map((p) => p.missingPartner)).toEqual(["src/keeper.ts"]);
  });

  it("a structurally linked partner ranks above a history-only partner of equal kind and greater strength", async () => {
    const context = makeContext(
      [
        edge("src/a.ts", "src/linked.ts", 20, 0.85, { confidenceBA: 0.8, lift: 3, structurallyLinked: true }),
        edge("src/a.ts", "src/history-only.ts", 30, 1, { confidenceBA: 0.95, lift: 3 }),
      ],
      ["src/a.ts"],
    );
    const payload = (await incompleteChangeSectionProvider.run(context)) as {
      partners: IncompleteChangePartner[];
    };
    expect(payload.partners.map((p) => [p.missingPartner, p.structurallyLinked])).toEqual([
      ["src/linked.ts", true],
      ["src/history-only.ts", false],
    ]);
  });
});

describe("incompleteChangeSectionProvider — a touched test whose SUBJECT is the source covers its missing test partner (bd tea-rags-mcp-89k7k.34)", () => {
  const SOURCE = "src/core/ops/widget-ops.ts";
  const HISTORICAL_TEST = "tests/core/ops/widget-ops.test.ts";
  const SIBLING_TEST = "tests/core/ops/widget-diff.test.ts";
  const OTHER_COMPONENT_TEST = "tests/core/gadget/gadget.test.ts";
  const SOURCE_IMPORT = "../../../src/core/ops/widget-ops.js";
  const SOURCE_ROWS: ReviewTreeChunkRow[] = [
    { symbolId: "WidgetOps" },
    { symbolId: "WidgetOps#review#part2" },
    { symbolId: "widgetDefaults" },
  ];
  type CoveragePayload = { partners: IncompleteChangePartner[]; coveredPartners?: IncompleteChangeCoveredPartner[] };

  function testRows(top: string, imports: string[]): ReviewTreeChunkRow[] {
    return [
      { symbolId: `${top}.describe "${top}"`, isTest: true, imports },
      { symbolId: `${top}.describe "${top}".it "does the thing"`, isTest: true, imports },
    ];
  }

  function withTree(
    files: string[],
    rows: Record<string, ReviewTreeChunkRow[]>,
    requested: string[][] = [],
  ): ReviewSectionContext {
    return {
      ...makeContext([edge(SOURCE, HISTORICAL_TEST, 12, 0.85, { confidenceBA: 0.8, lift: 3 })], files),
      readTreeChunks: async (relPaths) => {
        requested.push([...relPaths]);
        return new Map(relPaths.flatMap((relPath) => (rows[relPath] ? [[relPath, rows[relPath]] as const] : [])));
      },
    };
  }

  it("a touched sibling test whose top scope names a symbol the source declares, and which imports the source, demotes the partner to a note naming it", async () => {
    const requested: string[][] = [];
    const context = withTree(
      [SOURCE, SIBLING_TEST],
      { [SOURCE]: SOURCE_ROWS, [SIBLING_TEST]: testRows("WidgetOps — diff mode", ["vitest", SOURCE_IMPORT]) },
      requested,
    );
    const payload = (await incompleteChangeSectionProvider.run(context)) as CoveragePayload;
    expect(payload.partners).toEqual([]);
    expect(payload.coveredPartners).toEqual([
      { file: SOURCE, missingPartner: HISTORICAL_TEST, coveredBy: SIBLING_TEST, subject: "WidgetOps" },
    ]);
    // Only the touched test and the source are read from the tree.
    expect(requested.flat().sort()).toEqual([SIBLING_TEST, SOURCE].sort());
  });

  it("a NEW test file that exists only in the working tree covers the partner — its subject comes from the tree read, not the index", async () => {
    // An untracked test the diff adds: the index has never seen it, only the tree read knows its rows.
    const NEW_TEST = "tests/core/ops/widget-ops-review.test.ts";
    const context = withTree([SOURCE, NEW_TEST], {
      [SOURCE]: SOURCE_ROWS,
      [NEW_TEST]: testRows("WidgetOps#review", [SOURCE_IMPORT]),
    });
    const payload = (await incompleteChangeSectionProvider.run(context)) as CoveragePayload;
    expect(payload.partners).toEqual([]);
    expect(payload.coveredPartners).toEqual([
      { file: SOURCE, missingPartner: HISTORICAL_TEST, coveredBy: NEW_TEST, subject: "WidgetOps" },
    ]);
  });

  it("reach is not subject: a touched test of ANOTHER component that imports the source keeps the finding", async () => {
    const context = withTree([SOURCE, OTHER_COMPONENT_TEST], {
      [SOURCE]: SOURCE_ROWS,
      [OTHER_COMPONENT_TEST]: testRows("GadgetService — uses widgets", [SOURCE_IMPORT]),
    });
    const payload = (await incompleteChangeSectionProvider.run(context)) as CoveragePayload;
    expect(payload.partners).toMatchObject([{ file: SOURCE, missingPartner: HISTORICAL_TEST, partnerKind: "test" }]);
    expect(payload.coveredPartners).toBeUndefined();
  });

  it("a subject naming the source's symbol keeps the finding when the test does not import the source", async () => {
    const context = withTree([SOURCE, SIBLING_TEST], {
      [SOURCE]: SOURCE_ROWS,
      [SIBLING_TEST]: testRows("WidgetOps — diff mode", ["../../../src/core/ops/other-ops.js"]),
    });
    const payload = (await incompleteChangeSectionProvider.run(context)) as CoveragePayload;
    expect(payload.partners).toHaveLength(1);
    expect(payload.coveredPartners).toBeUndefined();
  });

  it("the leading token is a whole identifier: `WidgetOpsHelper` does not name `WidgetOps`", async () => {
    const context = withTree([SOURCE, SIBLING_TEST], {
      [SOURCE]: SOURCE_ROWS,
      [SIBLING_TEST]: testRows("WidgetOpsHelper", [SOURCE_IMPORT]),
    });
    const payload = (await incompleteChangeSectionProvider.run(context)) as CoveragePayload;
    expect(payload.partners).toHaveLength(1);
  });

  it("no subject can be read — no tree reader, or the test did not parse — keeps the finding (the safe default)", async () => {
    const noReader = makeContext(
      [edge(SOURCE, HISTORICAL_TEST, 12, 0.85, { confidenceBA: 0.8, lift: 3 })],
      [SOURCE, SIBLING_TEST],
    );
    const unparsed = withTree([SOURCE, SIBLING_TEST], { [SOURCE]: SOURCE_ROWS });
    for (const context of [noReader, unparsed]) {
      const payload = (await incompleteChangeSectionProvider.run(context)) as CoveragePayload;
      expect(payload.partners).toHaveLength(1);
      expect(payload.coveredPartners).toBeUndefined();
    }
  });
});
