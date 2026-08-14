/**
 * Heap-budget admission for the TypeScript Program strategies (bd
 * tea-rags-mcp-6aytq).
 *
 * The matrix below is not taste — every row is a measured taxdome outcome under
 * honest `resourceLimits` enforcement (`NODE_OPTIONS` stripped), and the
 * constants exist to reproduce exactly those verdicts:
 *
 * | declared MB | V8 reports | measured outcome                        | verdict        |
 * | ----------- | ---------- | --------------------------------------- | -------------- |
 * | 2048        | 2240       | coverage mode dies at the first build   | typecheckerOff |
 * | 3072        | 3264       | whole mode dies, 3.9x GC-thrashed build | coverage       |
 * | 4096        | 4288       | whole dies at ~6500 files UNSEGMENTED,  | whole          |
 * |             |            | completes with the default segment      |                |
 * | 6144        | 6336       | the shipping ceiling, ample             | whole          |
 */

import { describe, expect, it } from "vitest";

import {
  TS_PROGRAM_WHOLE_SEGMENT_FILES_DEFAULT,
  TSProgramCache,
} from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import {
  assessTSProgramAdmission,
  describeTSProgramTypecheckerDowngrade,
  readHeapSizeLimitMb,
  TS_PROGRAM_HEAP_BASE_MB_DEFAULT,
  TS_PROGRAM_HEAP_CHECKER_PER_1K_FILES_MB_DEFAULT,
  TS_PROGRAM_HEAP_PER_1K_ROOTS_MB_DEFAULT,
  TS_PROGRAM_HEAP_USABLE_PCT_DEFAULT,
  type TSProgramHeapBudget,
} from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-heap-admission.js";
import { resolveProgramHeapBudget } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";

const shippingBudget: TSProgramHeapBudget = {
  baseMb: TS_PROGRAM_HEAP_BASE_MB_DEFAULT,
  perThousandRootsMb: TS_PROGRAM_HEAP_PER_1K_ROOTS_MB_DEFAULT,
  checkerPerThousandFilesMb: TS_PROGRAM_HEAP_CHECKER_PER_1K_FILES_MB_DEFAULT,
  usableHeapPct: TS_PROGRAM_HEAP_USABLE_PCT_DEFAULT,
};

/** taxdome's real tsconfig expansion — the corpus every constant is sized on. */
const TAXDOME_ROOTS = 12_335;

function assessTaxdome(heapSizeLimitMb: number, segmentFiles = TS_PROGRAM_WHOLE_SEGMENT_FILES_DEFAULT) {
  return assessTSProgramAdmission({
    rootCount: TAXDOME_ROOTS,
    segmentFiles,
    heapSizeLimitMb,
    budget: shippingBudget,
  });
}

describe("assessTSProgramAdmission (bd tea-rags-mcp-6aytq)", () => {
  it("projects the whole-mode peak as base + roots + one segment of checker growth", () => {
    // 128 + 12,335 x 0.20 + 5,000 x 0.16 = 3,395 MB, which is the ~3.4 GB the
    // segmented design targets against the 4.31 GB unsegmented live set.
    expect(assessTaxdome(6336).wholeProjectionMb).toBe(3395);
  });

  it("projects the coverage-mode floor as the same Program without the checker growth", () => {
    // One covering Program over the main connectivity component: 128 + 2,467.
    expect(assessTaxdome(6336).coverageProjectionMb).toBe(2595);
  });

  it("requires the projection plus a fifth of it as headroom", () => {
    const assessment = assessTaxdome(6336);
    expect(assessment.wholeRequiredMb).toBe(Math.round(3395 / 0.8));
    expect(assessment.coverageRequiredMb).toBe(Math.round(2595 / 0.8));
  });

  it("admits whole mode on the 4096-declared worker that completes with the default segment", () => {
    expect(assessTaxdome(4288).verdict).toBe("whole");
  });

  it("admits whole mode on the shipping 6144 ceiling", () => {
    expect(assessTaxdome(6336).verdict).toBe("whole");
  });

  it("falls back to coverage on the 3072-declared worker whose whole build GC-thrashed to death", () => {
    expect(assessTaxdome(3264).verdict).toBe("coverage");
  });

  it("refuses BOTH strategies on the 2048-declared worker where coverage mode also dies", () => {
    expect(assessTaxdome(2240).verdict).toBe("typecheckerOff");
  });

  it("refuses whole mode on a 4096 worker once segmentation is disabled by a huge segment", () => {
    // The measured death: 4096 unsegmented dies at ~6,500 files. A segment
    // larger than the corpus is how an operator turns segmentation off, and the
    // projection must follow them there rather than keep quoting 3.4 GB.
    const unsegmented = assessTaxdome(4288, 1_000_000);
    expect(unsegmented.wholeProjectionMb).toBeGreaterThan(4300);
    expect(unsegmented.verdict).toBe("coverage");
  });

  it("leaves a small project admissible under a modest heap", () => {
    // The gate must not regress projects that never had a memory problem: 500
    // roots project a few hundred MB, so a 2 GB worker still gets whole mode.
    const small = assessTSProgramAdmission({
      rootCount: 500,
      segmentFiles: TS_PROGRAM_WHOLE_SEGMENT_FILES_DEFAULT,
      heapSizeLimitMb: 2240,
      budget: shippingBudget,
    });
    expect(small.verdict).toBe("whole");
  });

  it("carries the heap limit it judged, so a report never has to re-read it", () => {
    expect(assessTaxdome(4288).heapSizeLimitMb).toBe(4288);
  });

  it("takes an unreadable heap limit as no evidence and admits whole mode", () => {
    // A host whose V8 will not report a limit is not a host known to be small.
    expect(assessTaxdome(0).verdict).toBe("whole");
    expect(assessTaxdome(Number.NaN).verdict).toBe("whole");
  });
});

describe("describeTSProgramTypecheckerDowngrade (bd tea-rags-mcp-6aytq)", () => {
  it("says nothing when the run keeps a Program strategy", () => {
    expect(describeTSProgramTypecheckerDowngrade(assessTaxdome(6336))).toBeUndefined();
    expect(describeTSProgramTypecheckerDowngrade(assessTaxdome(3264))).toBeUndefined();
  });

  it("names the limit, the projection and the knobs that would change the decision", () => {
    const message = describeTSProgramTypecheckerDowngrade(assessTaxdome(2240));

    expect(message).toBeDefined();
    expect(message).toContain("2240");
    expect(message).toContain("2595");
    expect(message).toContain("ENRICHMENT_WORKER_MEMORY_LIMIT_MB");
    expect(message).toContain("CODEGRAPH_TS_PROGRAM_HEAP_USABLE_PCT");
    expect(message).toContain("CODEGRAPH_TS_PROGRAM_WHOLE_SEGMENT_FILES");
  });
});

describe("readHeapSizeLimitMb (bd tea-rags-mcp-6aytq)", () => {
  it("reports this isolate's own V8 old-generation ceiling in MB", () => {
    // Whatever the runner's limit is, it is a real positive number of MB — the
    // reading has to come from the isolate that will hold the Program, so there
    // is nothing to compare it against but plausibility.
    const limit = readHeapSizeLimitMb();
    expect(limit).toBeGreaterThan(64);
    expect(Number.isInteger(limit)).toBe(true);
  });
});

describe("resolveProgramHeapBudget (bd tea-rags-mcp-6aytq)", () => {
  it("defaults to the constants measured on taxdome", () => {
    expect(resolveProgramHeapBudget({})).toEqual(shippingBudget);
  });

  it("reads each term from its own CODEGRAPH_TS_PROGRAM_HEAP_* knob", () => {
    expect(
      resolveProgramHeapBudget({
        CODEGRAPH_TS_PROGRAM_HEAP_BASE_MB: "256",
        CODEGRAPH_TS_PROGRAM_HEAP_PER_1K_ROOTS_MB: "300",
        CODEGRAPH_TS_PROGRAM_HEAP_CHECKER_PER_1K_FILES_MB: "200",
        CODEGRAPH_TS_PROGRAM_HEAP_USABLE_PCT: "90",
      }),
    ).toEqual({
      baseMb: 256,
      perThousandRootsMb: 300,
      checkerPerThousandFilesMb: 200,
      usableHeapPct: 90,
    });
  });

  it("falls back to the default on a non-positive or unparseable knob", () => {
    expect(
      resolveProgramHeapBudget({
        CODEGRAPH_TS_PROGRAM_HEAP_BASE_MB: "0",
        CODEGRAPH_TS_PROGRAM_HEAP_USABLE_PCT: "not-a-number",
      }),
    ).toEqual(shippingBudget);
  });

  it("refuses a usable percentage above 100 — a budget cannot exceed the heap", () => {
    expect(resolveProgramHeapBudget({ CODEGRAPH_TS_PROGRAM_HEAP_USABLE_PCT: "150" }).usableHeapPct).toBe(
      TS_PROGRAM_HEAP_USABLE_PCT_DEFAULT,
    );
  });
});

describe("TSProgramCache admission wiring (bd tea-rags-mcp-6aytq)", () => {
  it("exposes the heap budget it was constructed with through its verdict", () => {
    // A cache with no project roots never assesses anything — the guard rail is
    // that construction with a budget is legal and inert.
    const cache = new TSProgramCache({
      repoRoot: process.cwd(),
      tsOptions: { baseUrl: ".", paths: {} },
      strategy: "whole",
      projectRoots: () => [],
      heapBudget: shippingBudget,
      readHeapSizeLimitMb: () => 2240,
    });

    expect(cache.typeCheckerDisabled).toBe(false);
  });
});
