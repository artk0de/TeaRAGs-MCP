/**
 * Heap admission for the TypeScript resolver's Programs (bd tea-rags-mcp-6aytq,
 * re-based on source text and call sites by bd tea-rags-mcp-vtuu4).
 *
 * The batch spike measured what a Program's heap is made of: AST + binder
 * state ≈ 28–31 MB per MB of source text, the checker ≈ 110 MB fixed plus
 * 17–34 KB per resolved call site. A projection built on those two axes
 * predicts the planned 40 MB / 15k configuration at ~1.76 GB against a
 * measured max live heap of 1,881 MB over taxdome's 33 batches — which is why
 * the counting-files projection this replaces could not size a batch at all.
 *
 * The coverage strategy's floor keeps its root-count form: one covering
 * Program over the main connectivity component, measured on taxdome.
 */

import { describe, expect, it } from "vitest";

import {
  assessTSProgramBatchAdmission,
  assessTSProgramCoverageAdmission,
  describeTSProgramTypecheckerDowngrade,
  projectTSProgramUnitHeapMb,
  readHeapSizeLimitMb,
  TS_PROGRAM_HEAP_BASE_MB_DEFAULT,
  TS_PROGRAM_HEAP_PER_1K_CALL_SITES_MB_DEFAULT,
  TS_PROGRAM_HEAP_PER_1K_ROOTS_MB_DEFAULT,
  TS_PROGRAM_HEAP_PER_TEXT_MB_DEFAULT,
  TS_PROGRAM_HEAP_USABLE_PCT_DEFAULT,
  type TSProgramHeapBudget,
} from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-heap-admission.js";
import { resolveProgramHeapBudget } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";

const MB = 1024 * 1024;

const shippingBudget: TSProgramHeapBudget = {
  baseMb: TS_PROGRAM_HEAP_BASE_MB_DEFAULT,
  perTextMb: TS_PROGRAM_HEAP_PER_TEXT_MB_DEFAULT,
  perThousandCallSitesMb: TS_PROGRAM_HEAP_PER_1K_CALL_SITES_MB_DEFAULT,
  perThousandRootsMb: TS_PROGRAM_HEAP_PER_1K_ROOTS_MB_DEFAULT,
  usableHeapPct: TS_PROGRAM_HEAP_USABLE_PCT_DEFAULT,
};

/** The planned configuration at its limits: a full 40 MB batch resolving 15k calls. */
const FULL_BATCH = { textBytes: 40 * MB, callSites: 15_000 };

describe("projectTSProgramUnitHeapMb (bd tea-rags-mcp-vtuu4)", () => {
  it("projects a batch as base + text + call sites", () => {
    // 110 + 30 x 40 + 30 x 15 = 1,760 MB.
    expect(projectTSProgramUnitHeapMb(FULL_BATCH, 0, shippingBudget)).toBe(1760);
  });

  it("charges the retained parse cache beyond the batch's own text", () => {
    // A 10 MB batch under a 40 MB retained cache: the union is 40 MB, not 10.
    expect(projectTSProgramUnitHeapMb({ textBytes: 10 * MB, callSites: 0 }, 40 * MB, shippingBudget)).toBe(
      110 + 30 * 40,
    );
    // A batch larger than the cache holds its own text and nothing more.
    expect(projectTSProgramUnitHeapMb({ textBytes: 42 * MB, callSites: 0 }, 40 * MB, shippingBudget)).toBe(
      110 + 30 * 42,
    );
  });

  it("projects one oversize unit on its full closure", () => {
    // taxdome's oversize roots: ~42 MB of text, 151 calls over 4 roots.
    expect(projectTSProgramUnitHeapMb({ textBytes: 42 * MB, callSites: 151 }, 0, shippingBudget)).toBe(1375);
  });
});

describe("assessTSProgramBatchAdmission (bd tea-rags-mcp-vtuu4)", () => {
  it("admits the planned 40 MB / 15k configuration on the shipping 6144 ceiling", () => {
    const assessment = assessTSProgramBatchAdmission({
      batches: [FULL_BATCH, { textBytes: 12 * MB, callSites: 400 }],
      retainedTextBytes: 40 * MB,
      heapSizeLimitMb: 6336,
      budget: shippingBudget,
    });

    expect(assessment.verdict).toBe("batched");
    expect(assessment.projectionMb).toBe(1760);
    expect(assessment.requiredMb).toBe(Math.round(1760 / 0.8));
  });

  it("admits it on a 2,304 MB ceiling — the 2 GB peak target with headroom", () => {
    expect(
      assessTSProgramBatchAdmission({
        batches: [FULL_BATCH],
        retainedTextBytes: 40 * MB,
        heapSizeLimitMb: 2304,
        budget: shippingBudget,
      }).verdict,
    ).toBe("batched");
  });

  it("refuses the batched strategy when its largest batch does not fit", () => {
    const assessment = assessTSProgramBatchAdmission({
      batches: [{ textBytes: MB, callSites: 10 }, FULL_BATCH],
      retainedTextBytes: 40 * MB,
      heapSizeLimitMb: 2048,
      budget: shippingBudget,
    });

    expect(assessment.verdict).toBe("typecheckerOff");
    expect(assessment.projectionMb).toBe(1760);
  });

  it("leaves a small project admissible under a modest heap", () => {
    // Retained text never exceeds what the project has: 2 MB of source is a
    // few hundred MB of projection whatever the cache budget says.
    expect(
      assessTSProgramBatchAdmission({
        batches: [{ textBytes: 2 * MB, callSites: 3000 }],
        retainedTextBytes: 2 * MB,
        heapSizeLimitMb: 1024,
        budget: shippingBudget,
      }).verdict,
    ).toBe("batched");
  });

  it("takes an unreadable heap limit as no evidence and admits the batches", () => {
    for (const heapSizeLimitMb of [0, Number.NaN]) {
      expect(
        assessTSProgramBatchAdmission({
          batches: [FULL_BATCH],
          retainedTextBytes: 40 * MB,
          heapSizeLimitMb,
          budget: shippingBudget,
        }).verdict,
      ).toBe("batched");
    }
  });
});

describe("assessTSProgramCoverageAdmission (bd tea-rags-mcp-6aytq)", () => {
  /** taxdome's real tsconfig expansion — the corpus the coverage floor was measured on. */
  const TAXDOME_ROOTS = 12_335;

  it("keeps the coverage floor as base + roots", () => {
    // 110 + 12,335 x 0.20 = 2,577 MB: one covering Program over the main component.
    expect(
      assessTSProgramCoverageAdmission({ rootCount: TAXDOME_ROOTS, heapSizeLimitMb: 6336, budget: shippingBudget })
        .projectionMb,
    ).toBe(2577);
  });

  it("refuses coverage on the 2048-declared worker where its first build died", () => {
    expect(
      assessTSProgramCoverageAdmission({ rootCount: TAXDOME_ROOTS, heapSizeLimitMb: 2240, budget: shippingBudget })
        .verdict,
    ).toBe("typecheckerOff");
  });

  it("admits coverage on the 4096-declared worker", () => {
    expect(
      assessTSProgramCoverageAdmission({ rootCount: TAXDOME_ROOTS, heapSizeLimitMb: 4288, budget: shippingBudget })
        .verdict,
    ).toBe("coverage");
  });
});

describe("describeTSProgramTypecheckerDowngrade (bd tea-rags-mcp-6aytq)", () => {
  const refused = assessTSProgramBatchAdmission({
    batches: [FULL_BATCH],
    retainedTextBytes: 40 * MB,
    heapSizeLimitMb: 1500,
    budget: shippingBudget,
  });

  it("says nothing when the run keeps a Program strategy", () => {
    const admitted = assessTSProgramBatchAdmission({
      batches: [FULL_BATCH],
      retainedTextBytes: 40 * MB,
      heapSizeLimitMb: 6336,
      budget: shippingBudget,
    });
    expect(describeTSProgramTypecheckerDowngrade(admitted)).toBeUndefined();
  });

  it("names the limit, the projection and the knobs that would change the decision", () => {
    const message = describeTSProgramTypecheckerDowngrade(refused);

    expect(message).toBeDefined();
    expect(message).toContain("1500");
    expect(message).toContain("1760");
    expect(message).toContain("ENRICHMENT_WORKER_MEMORY_LIMIT_MB");
    expect(message).toContain("CODEGRAPH_TS_PROGRAM_BATCH_TEXT_MB");
    expect(message).toContain("CODEGRAPH_TS_PROGRAM_BATCH_CALLS");
    expect(message).toContain("CODEGRAPH_TS_PROGRAM_HEAP_USABLE_PCT");
  });

  // bd tea-rags-mcp-t5cji: without a Program a member call is no longer matched
  // by name — the operator has to know which calls the run gives up. An
  // inherited `this` member is no longer among them: the class hierarchy answers it.
  it("says member calls on untyped receivers resolve only through structural evidence", () => {
    const message = describeTSProgramTypecheckerDowngrade(refused);

    expect(message).toContain("resolves only through structural evidence");
    expect(message).toContain("for `this`, the enclosing class and the bases its file declares or imports");
    expect(message).toContain("one on an untyped local or a parameter stays unresolved");
    expect(message).not.toContain("inherited `this` member");
    expect(message).not.toContain("resolve without type information");
  });

  it("explains a refused coverage run too", () => {
    const coverage = assessTSProgramCoverageAdmission({
      rootCount: 12_335,
      heapSizeLimitMb: 2240,
      budget: shippingBudget,
    });

    expect(describeTSProgramTypecheckerDowngrade(coverage)).toContain("2240");
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
        CODEGRAPH_TS_PROGRAM_HEAP_PER_TEXT_MB: "35",
        CODEGRAPH_TS_PROGRAM_HEAP_PER_1K_CALLS_MB: "25",
        CODEGRAPH_TS_PROGRAM_HEAP_PER_1K_ROOTS_MB: "300",
        CODEGRAPH_TS_PROGRAM_HEAP_USABLE_PCT: "90",
      }),
    ).toEqual({
      baseMb: 256,
      perTextMb: 35,
      perThousandCallSitesMb: 25,
      perThousandRootsMb: 300,
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
