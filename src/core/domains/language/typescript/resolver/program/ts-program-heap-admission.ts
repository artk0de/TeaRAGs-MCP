/**
 * Will a `ts.Program` FIT the isolate that is about to build it?
 * (bd tea-rags-mcp-6aytq; re-based on text and call sites by bd
 * tea-rags-mcp-vtuu4)
 *
 * The Program cache's other bounds are cache policy. None of them can answer
 * the question that actually kills a run: is there enough heap for the Program
 * at all? A V8 heap OOM kills the worker isolate outright — no exception reaches
 * `TSProgramCache#buildFrom`'s try/catch — so the thread dies with
 * `ERR_WORKER_OUT_OF_MEMORY`, the dispatch rejects, and the run loses every
 * codegraph signal it had accumulated, with no retry. Refusing the build and
 * resolving without type information loses precision on one pass; letting it
 * proceed loses the whole run.
 *
 * **What a Program's heap is made of** — measured by the closure-batch spike
 * on taxdome with `NODE_OPTIONS` stripped (`$J/vtuu4-spike/`):
 *
 * - AST ≈ 22 MB per MB of source text, AST + binder ≈ 28–31 MB per MB;
 * - checker ≈ 110 MB fixed + 17–34 KB per resolved call site (mean 25–30 KB);
 * - a bound SourceFile retained by the shared parse cache costs the same
 *   whether or not a Program holds it, so the RETAINED cache is charged too.
 *
 * So a batch projects as `base + perText × text + perCall × calls`, where
 * `text` is the union of the batch's own text and what the parse cache retains
 * beyond it. The planned 40 MB / 15k configuration projects 1,760 MB; the
 * sequential spike run of that configuration measured a max live heap of
 * 1,881 MB over 33 Programs. File count, which the whole-Program projection
 * read, predicts neither term.
 *
 * The COVERAGE strategy keeps its own floor, measured on taxdome: one covering
 * Program over the main connectivity component, which a 2048-declared worker
 * died building — `base + roots × perRoot`.
 *
 * Every term is env-tunable, because a repository of a different shape
 * (declaration-dense, generated clients) sits elsewhere on the same curve.
 */

import { getHeapStatistics } from "node:v8";

const BYTES_PER_MB = 1024 * 1024;

/**
 * Fixed heap of a resolve pass's Program before its text and calls, in MB: the
 * checker's own base (≈ 110 MB measured) — the extraction pass's symbol table
 * and run state already live in the isolate's baseline.
 */
export const TS_PROGRAM_HEAP_BASE_MB_DEFAULT = 110;
/** Heap per MB of source text a Program holds, in MB — AST + binder, 28–31 measured. */
export const TS_PROGRAM_HEAP_PER_TEXT_MB_DEFAULT = 30;
/** Checker heap per THOUSAND resolved call sites, in MB — 17–34 KB each measured. */
export const TS_PROGRAM_HEAP_PER_1K_CALL_SITES_MB_DEFAULT = 30;
/**
 * Coverage-mode Program cost per THOUSAND project roots, in MB.
 *
 * 200 (0.20 MB per root): taxdome's 12,335-root tsconfig produced a Program at
 * ~2.6 GB live — the coverage floor, because one covering Program over the main
 * connectivity component is most of the project.
 */
export const TS_PROGRAM_HEAP_PER_1K_ROOTS_MB_DEFAULT = 200;
/**
 * Percentage of the isolate's heap ceiling a projection may claim.
 *
 * 80, i.e. a fifth of the ceiling stays free. V8 needs room for the young
 * generation, for fragmentation, and for the collection itself — a run pressed
 * against its ceiling does not fail gracefully, it GC-thrashes (measured 3.9x
 * on a 3072-declared build) and then dies.
 */
export const TS_PROGRAM_HEAP_USABLE_PCT_DEFAULT = 80;

/** The terms of the heap projection, each independently env-tunable. */
export interface TSProgramHeapBudget {
  /** Checker base. Default {@link TS_PROGRAM_HEAP_BASE_MB_DEFAULT}. */
  readonly baseMb: number;
  /** Heap per MB of source text. Default {@link TS_PROGRAM_HEAP_PER_TEXT_MB_DEFAULT}. */
  readonly perTextMb: number;
  /** Checker heap per 1,000 call sites. Default {@link TS_PROGRAM_HEAP_PER_1K_CALL_SITES_MB_DEFAULT}. */
  readonly perThousandCallSitesMb: number;
  /** Coverage-mode Program per 1,000 roots. Default {@link TS_PROGRAM_HEAP_PER_1K_ROOTS_MB_DEFAULT}. */
  readonly perThousandRootsMb: number;
  /** Share of the ceiling a projection may claim. Default {@link TS_PROGRAM_HEAP_USABLE_PCT_DEFAULT}. */
  readonly usableHeapPct: number;
}

/** The two quantities a Program unit — a batch or one oversize root — is sized by. */
export interface TSProgramUnitShape {
  /** Source text the Program holds, prelude included. */
  readonly textBytes: number;
  /** Call sites resolved against it. */
  readonly callSites: number;
}

/**
 * What this isolate may run.
 *
 * - `batched` — closure-batch Programs over the whole project, the bulk path.
 * - `coverage` — per-entry Programs with coverage reuse.
 * - `typecheckerOff` — no `ts.Program` at all, which is what
 *   `CODEGRAPH_TS_TYPECHECKER=0` configures and what a host below the chosen
 *   strategy's projection gets whether it configured it or not.
 */
export type TSProgramAdmissionVerdict = "batched" | "coverage" | "typecheckerOff";

/** The verdict plus every number it was reached from, so a report re-derives nothing. */
export interface TSProgramAdmissionAssessment {
  readonly verdict: TSProgramAdmissionVerdict;
  /** Which strategy was judged — the one the verdict admits or refuses. */
  readonly strategy: "batched" | "coverage";
  readonly heapSizeLimitMb: number;
  readonly projectionMb: number;
  readonly requiredMb: number;
}

export interface TSProgramBatchAdmissionRequest {
  readonly batches: readonly TSProgramUnitShape[];
  /**
   * Text the shared parse cache may retain beside a batch: its byte budget,
   * or the project's whole text when that is smaller.
   */
  readonly retainedTextBytes: number;
  /** `v8.getHeapStatistics().heap_size_limit` in MB, read in THIS isolate. */
  readonly heapSizeLimitMb: number;
  readonly budget: TSProgramHeapBudget;
}

export interface TSProgramCoverageAdmissionRequest {
  /** Files the project claims — the root set coverage mode's floor is measured on. */
  readonly rootCount: number;
  readonly heapSizeLimitMb: number;
  readonly budget: TSProgramHeapBudget;
}

/** This isolate's own V8 old-generation ceiling, in MB. */
export function readHeapSizeLimitMb(): number {
  return Math.round(getHeapStatistics().heap_size_limit / BYTES_PER_MB);
}

/**
 * Projected heap of ONE Program unit, in MB.
 *
 * `retainedTextBytes` is what the shared parse cache may hold at the same time.
 * The unit's own parses sit inside that cache when the unit fits it, so the
 * live text is the UNION — the larger of the two, not their sum. An oversize
 * unit is built after the cache is cleared and passes `0`.
 */
export function projectTSProgramUnitHeapMb(
  unit: TSProgramUnitShape,
  retainedTextBytes: number,
  budget: TSProgramHeapBudget,
): number {
  const liveTextMb = Math.max(unit.textBytes, retainedTextBytes) / BYTES_PER_MB;
  return Math.round(
    budget.baseMb + budget.perTextMb * liveTextMb + (budget.perThousandCallSitesMb * unit.callSites) / 1000,
  );
}

/** Does a projection fit `heapSizeLimitMb` with the budget's headroom? The MB it needs, and the answer. */
export function fitsTSProgramHeap(
  projectionMb: number,
  heapSizeLimitMb: number,
  budget: TSProgramHeapBudget,
): { requiredMb: number; fits: boolean } {
  const requiredMb = Math.round(projectionMb / (budget.usableHeapPct / 100));
  // An unusable reading is NO EVIDENCE: a host whose V8 will not report a
  // ceiling is not a host known to be small, and refusing type information on
  // a failed introspection would silently degrade every run everywhere.
  const fits = !isUsableLimit(heapSizeLimitMb) || heapSizeLimitMb >= requiredMb;
  return { requiredMb, fits };
}

/**
 * May this isolate run the batched strategy? Judged on the LARGEST batch
 * projection — batches run one at a time, so the peak is the worst one, not a
 * sum. Oversize roots are judged one by one where they are built.
 */
export function assessTSProgramBatchAdmission(request: TSProgramBatchAdmissionRequest): TSProgramAdmissionAssessment {
  let projectionMb = 0;
  for (const batch of request.batches) {
    projectionMb = Math.max(projectionMb, projectTSProgramUnitHeapMb(batch, request.retainedTextBytes, request.budget));
  }
  const { requiredMb, fits } = fitsTSProgramHeap(projectionMb, request.heapSizeLimitMb, request.budget);
  return {
    verdict: fits ? "batched" : "typecheckerOff",
    strategy: "batched",
    heapSizeLimitMb: request.heapSizeLimitMb,
    projectionMb,
    requiredMb,
  };
}

/** May this isolate run a bulk coverage pass? One covering Program over the main component is its floor. */
export function assessTSProgramCoverageAdmission(
  request: TSProgramCoverageAdmissionRequest,
): TSProgramAdmissionAssessment {
  const projectionMb = Math.round(
    request.budget.baseMb + (request.rootCount * request.budget.perThousandRootsMb) / 1000,
  );
  const { requiredMb, fits } = fitsTSProgramHeap(projectionMb, request.heapSizeLimitMb, request.budget);
  return {
    verdict: fits ? "coverage" : "typecheckerOff",
    strategy: "coverage",
    heapSizeLimitMb: request.heapSizeLimitMb,
    projectionMb,
    requiredMb,
  };
}

function isUsableLimit(heapSizeLimitMb: number): boolean {
  return Number.isFinite(heapSizeLimitMb) && heapSizeLimitMb > 0;
}

/**
 * One line explaining a run that lost its type checker to the heap, or
 * `undefined` when it kept a Program strategy — silence is the expected
 * outcome, matching `heap-ceiling-enforcement.ts`.
 *
 * It names the knobs rather than merely the numbers because every input to the
 * verdict is tunable, and an operator reading this in a log has no other way to
 * find out which lever moves it. `ENRICHMENT_WORKER_MEMORY_LIMIT_MB` comes
 * first: raising the ceiling is the fix, the rest are for a repository whose
 * shape the fitted constants do not describe.
 */
export function describeTSProgramTypecheckerDowngrade(assessment: TSProgramAdmissionAssessment): string | undefined {
  if (assessment.verdict !== "typecheckerOff") return undefined;
  const what =
    assessment.strategy === "batched"
      ? "the largest closure-batch ts.Program"
      : "one covering ts.Program over the project's roots";
  return (
    `TypeScript type checker DISABLED for this run: this isolate's V8 heap ceiling is ` +
    `${assessment.heapSizeLimitMb} MB, but ${what} projects ${assessment.projectionMb} MB and needs ` +
    `${assessment.requiredMb} MB with headroom. Building it would kill this worker with ` +
    `ERR_WORKER_OUT_OF_MEMORY and lose every codegraph signal in the run, so this run resolves TypeScript ` +
    `without it: a member call on a receiver the walker did not type resolves only through structural evidence ` +
    `(a namespace or named import whose module declares the member, or, for \`this\`, the enclosing class and the ` +
    `bases its file declares or imports), so one on an untyped local or a parameter stays unresolved. ` +
    `Raise ENRICHMENT_WORKER_MEMORY_LIMIT_MB, shrink CODEGRAPH_TS_PROGRAM_BATCH_TEXT_MB / ` +
    `CODEGRAPH_TS_PROGRAM_BATCH_CALLS / CODEGRAPH_TS_PROGRAM_PARSED_TEXT_MB, or retune ` +
    `CODEGRAPH_TS_PROGRAM_HEAP_BASE_MB / CODEGRAPH_TS_PROGRAM_HEAP_PER_TEXT_MB / ` +
    `CODEGRAPH_TS_PROGRAM_HEAP_PER_1K_CALLS_MB / CODEGRAPH_TS_PROGRAM_HEAP_PER_1K_ROOTS_MB / ` +
    `CODEGRAPH_TS_PROGRAM_HEAP_USABLE_PCT.`
  );
}
