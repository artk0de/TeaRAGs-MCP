/**
 * `incompleteChangeSectionProvider` (bd tea-rags-mcp-89k7k.1.4 / the review
 * half of bd tea-rags-mcp-3kykc): a co-change partner of a diff file that the
 * diff does NOT touch is the finding — history says the two change together,
 * this change carries only one side. Partners inside the diff are not findings
 * (the change carries the pair); the cap keeps the section bounded.
 */
import { describe, expect, it } from "vitest";

import type { DiffScopeRead } from "../../../../../../src/core/api/internal/ops/diff-scope-reader.js";
import { incompleteChangeSectionProvider } from "../../../../../../src/core/api/internal/ops/review-sections/incomplete-change-section.js";
import type { ReviewSectionContext } from "../../../../../../src/core/api/internal/ops/review-sections/index.js";
import type { TemporalCochangeEdgeWithLinkage } from "../../../../../../src/core/contracts/types/codegraph.js";

function edge(
  relPathA: string,
  relPathB: string,
  support: number,
  confidenceAB = 0.8,
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
      partners: { file: string; missingPartner: string; support: number; confidence: number; lastCoChangeAt: number }[];
    };
    expect(payload.partners).toEqual([
      {
        file: "src/a.ts",
        missingPartner: "src/partner.ts",
        support: 7,
        confidence: 0.9,
        lastCoChangeAt: 1_700_000_000,
      },
    ]);
  });

  it("uses the file's own direction: a diff file named as relPathB reports confidenceBA", async () => {
    const context = makeContext([edge("src/partner.ts", "src/b.ts", 4, 0.9)], ["src/b.ts"]);
    const payload = (await incompleteChangeSectionProvider.run(context)) as {
      partners: { file: string; missingPartner: string; confidence: number }[];
    };
    expect(payload.partners).toEqual([
      {
        file: "src/b.ts",
        missingPartner: "src/partner.ts",
        support: 4,
        confidence: 0.5,
        lastCoChangeAt: 1_700_000_000,
      },
    ]);
  });

  it("keeps the 50 strongest findings and counts the cut", async () => {
    const edges = Array.from({ length: 60 }, (_, i) =>
      edge("src/a.ts", `src/p${String(i).padStart(2, "0")}.ts`, i + 1),
    );
    const context = makeContext(edges, ["src/a.ts"]);
    const payload = (await incompleteChangeSectionProvider.run(context)) as {
      partners: { missingPartner: string }[];
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
