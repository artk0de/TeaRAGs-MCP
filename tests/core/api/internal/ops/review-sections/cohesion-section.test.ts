/**
 * `cohesionSectionProvider` (bd tea-rags-mcp-89k7k.1.4, F3 slice 1): per
 * changed file, the A3 behavioral-cohesion analysis (`analyzeFileCohesion`)
 * over the persisted per-symbol commit sets (S1). A file whose read yields no
 * report is a notJudged entry — absence, never a zero.
 */
import { describe, expect, it, vi } from "vitest";

import type { DiffScopeRead } from "../../../../../../src/core/api/internal/ops/diff-scope-reader.js";
import { cohesionSectionProvider } from "../../../../../../src/core/api/internal/ops/review-sections/cohesion-section.js";
import type { ReviewSectionContext } from "../../../../../../src/core/api/internal/ops/review-sections/index.js";
import type { TemporalSymbolCommitFileSnapshot } from "../../../../../../src/core/contracts/types/codegraph.js";

/** Two symbols sharing three commits, each holding one commit of its own — survives the mass-commit fence and both gates. */
const SHARED: ReadonlySet<string> = new Set(["c1", "c2", "c3"]);
function snapshot(
  relPath: string,
  symbols: { symbolId: string; commitShas: string[] }[],
): TemporalSymbolCommitFileSnapshot {
  return { relPath, symbols };
}

const RICH = snapshot("src/a.ts", [
  { symbolId: "A", commitShas: [...SHARED, "aOnly"] },
  { symbolId: "B", commitShas: [...SHARED, "bOnly"] },
]);

function makeContext(
  reads: Record<string, TemporalSymbolCommitFileSnapshot>,
  files: string[],
  windowMonths = 6,
): ReviewSectionContext {
  return {
    scope: {
      workTree: "/w",
      base: "HEAD",
      mergeBase: "mb",
      notices: [],
      changedFiles: files.length,
      wholeFiles: 0,
      files,
      addedRanges: new Map(),
      nonProduction: new Set(),
      skipped: 0,
    } satisfies DiffScopeRead,
    graphDb: { readTemporalSymbolCommits: vi.fn(async (relPath: string) => reads[relPath] ?? snapshot(relPath, [])) },
    temporalCochange: undefined,
    temporalCochangeError: undefined,
    lexiconOps: undefined,
    addressing: {},
    collectionName: "c",
    windowMonths,
    diffRequest: {},
  };
}

describe("cohesionSectionProvider — isBuilt", () => {
  it("needs a codegraph reader", () => {
    expect(cohesionSectionProvider.isBuilt(makeContext({}, []))).toEqual({ built: true });
    expect(cohesionSectionProvider.isBuilt({ ...makeContext({}, []), graphDb: undefined })).toEqual({
      built: false,
      reason: expect.stringMatching(/codegraph/),
    });
  });
});

describe("cohesionSectionProvider — run", () => {
  it("reports the analyzed file and notJudges the file with no data — windowMonths threaded", async () => {
    const context = makeContext({ "src/a.ts": RICH }, ["src/a.ts", "src/b.ts"], 9);
    const payload = (await cohesionSectionProvider.run(context)) as {
      reports: { file: string; analyzedSymbols: number; windowMonths?: number }[];
      analyzedFiles: number;
      nullReports: number;
      notJudged?: { relPath: string; reason: string }[];
    };

    expect(payload.reports).toHaveLength(1);
    expect(payload.reports[0].file).toBe("src/a.ts");
    expect(payload.reports[0].analyzedSymbols).toBe(2);
    expect(payload.reports[0].windowMonths).toBe(9);
    expect(payload.analyzedFiles).toBe(1);
    expect(payload.nullReports).toBe(1);
    expect(payload.notJudged).toEqual([{ relPath: "src/b.ts", reason: "noCohesionData" }]);
    expect(context.graphDb?.readTemporalSymbolCommits).toHaveBeenCalledTimes(2);
  });

  it("caps the reports at 50 and counts the cut", async () => {
    const files = Array.from({ length: 55 }, (_, i) => `src/f${String(i).padStart(2, "0")}.ts`);
    const reads = Object.fromEntries(files.map((relPath) => [relPath, RICH]));
    const payload = (await cohesionSectionProvider.run(makeContext(reads, files))) as {
      reports: unknown[];
      analyzedFiles: number;
      nullReports: number;
      truncated?: number;
    };
    expect(payload.reports).toHaveLength(50);
    expect(payload.analyzedFiles).toBe(55);
    expect(payload.nullReports).toBe(0);
    expect(payload.truncated).toBe(5);
  });

  it("an empty diff is a built section with nothing to analyze", async () => {
    const payload = (await cohesionSectionProvider.run(makeContext({}, []))) as {
      reports: unknown[];
      analyzedFiles: number;
      nullReports: number;
    };
    expect(payload.reports).toEqual([]);
    expect(payload.analyzedFiles).toBe(0);
    expect(payload.nullReports).toBe(0);
  });
});
