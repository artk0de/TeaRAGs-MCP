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
import type { ReviewSectionContext } from "../../../../../../src/core/api/internal/ops/review-sections/index.js";
import type { IncompleteChangePartner } from "../../../../../../src/core/api/public/dto/review.js";
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

function scopeOf(files: string[], skipped = 0): DiffScopeRead {
  return {
    workTree: "/w",
    base: "HEAD",
    mergeBase: "mb",
    notices: [],
    changedFiles: files.length,
    wholeFiles: 0,
    files,
    addedRanges: new Map(),
    nonProduction: new Set(),
    skipped,
  };
}

function makeContext(edges: TemporalCochangeEdgeWithLinkage[], files: string[], skipped = 0): ReviewSectionContext {
  return {
    scope: scopeOf(files, skipped),
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
