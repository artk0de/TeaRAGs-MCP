/**
 * Will a `ts.Program` strategy FIT the isolate that is about to build it?
 * (bd tea-rags-mcp-6aytq)
 *
 * The Program cache's other bounds are all cache policy — how many Programs to
 * retain, how much parsed text to pin. None of them can answer the question
 * that actually kills a run, because the compiler's own resolution walk sets a
 * Program's size and no cache policy shrinks it: is there enough heap for ONE
 * of these at all?
 *
 * Measured on taxdome's 10,912 TypeScript files with `NODE_OPTIONS` stripped, so
 * the worker's `resourceLimits` were genuinely in force:
 *
 * - the whole-project build alone reaches ~2.6 GB live over a 12,335-root
 *   tsconfig, and the CHECKER then grows monotonically by 1.69 GB across the
 *   resolve — a 4.31 GB live set by the last file;
 * - a 5120-declared worker completes at 6.94 ms/file; a 4096-declared worker
 *   dies at about file 6,500; a 3072-declared worker dies earlier, after a build
 *   that GC-thrashed to 3.9x its normal cost;
 * - coverage mode is NOT a small-machine fallback: its floor is one covering
 *   Program over the main connectivity component (~15-16k files), and a
 *   2048-declared worker dies building it.
 *
 * What makes this worth a gate rather than a comment is the failure MODE. A V8
 * heap OOM kills the worker isolate outright — no exception reaches
 * `TSProgramCache#buildFrom`'s try/catch — so the thread dies with
 * `ERR_WORKER_OUT_OF_MEMORY`, the dispatch rejects, and the run loses every
 * codegraph signal it had accumulated, with no retry. Refusing the build and
 * resolving without type information loses precision on one pass; letting it
 * proceed loses the whole run.
 *
 * The projection deliberately reads the ROOT COUNT rather than measuring
 * anything: it has to answer before the first `ts.createProgram`, and by the
 * time a measurement exists the memory has already been spent. Its terms are
 * fitted to the numbers above and every one of them is env-tunable, because a
 * different repository shape (declaration-dense, monorepo, no barrels) will sit
 * somewhere else on the same curve.
 */

import { getHeapStatistics } from "node:v8";

const BYTES_PER_MB = 1024 * 1024;

/**
 * Fixed heap cost of a resolve pass before any Program exists, in MB.
 *
 * 128 rather than 0: the isolate is already holding the extraction pass's
 * symbol table, the run state and the resolver's own maps when the build
 * starts. Measured on the 5.84 GB heap snapshot, tea-rags' own structures are
 * 44 MB of that; the rest is boot and the parse map's overhead. 128 + 12,335
 * roots x {@link TS_PROGRAM_HEAP_PER_1K_ROOTS_MB_DEFAULT} reproduces the ~2.6 GB
 * post-build live set.
 */
export const TS_PROGRAM_HEAP_BASE_MB_DEFAULT = 128;
/**
 * Heap the built Program costs per THOUSAND root files, in MB.
 *
 * 200 (0.20 MB per root). taxdome's 12,335-root tsconfig produced a Program
 * holding 16,313 files at ~2.6 GB live, so the ratio already carries the
 * compiler's own transitive expansion — the roots are what a caller can count
 * before paying for the walk, and the number is fitted against them on purpose.
 * Attribution over the snapshot: TS AST 1,331 MB, anonymous backing arrays
 * 919 MB, strings 756 MB (only ~70 MB of it retained source text).
 */
export const TS_PROGRAM_HEAP_PER_1K_ROOTS_MB_DEFAULT = 200;
/**
 * Checker growth per THOUSAND files SERVED off one Program, in MB.
 *
 * 160 (0.16 MB per file). The checker's state is monotonic within a Program —
 * measured +1.69 GB over 10,912 resolved taxdome files — and it is the term
 * segmentation bounds: with the default segment the whole-mode projection stops
 * at one segment's worth instead of the corpus's.
 */
export const TS_PROGRAM_HEAP_CHECKER_PER_1K_FILES_MB_DEFAULT = 160;
/**
 * Percentage of the isolate's heap ceiling a projection may claim.
 *
 * 80, i.e. a fifth of the ceiling stays free. V8 needs room for the young
 * generation, for fragmentation, and for the collection itself — a run pressed
 * against its ceiling does not fail gracefully, it GC-thrashes (measured 3.9x
 * on the 3072-declared build) and then dies. The margin is what turns "it fit
 * once" into "it fits".
 */
export const TS_PROGRAM_HEAP_USABLE_PCT_DEFAULT = 80;

/** The four terms of the heap projection, each independently env-tunable. */
export interface TSProgramHeapBudget {
  /** Fixed cost before any Program. Default {@link TS_PROGRAM_HEAP_BASE_MB_DEFAULT}. */
  readonly baseMb: number;
  /** Built-Program cost per 1,000 roots. Default {@link TS_PROGRAM_HEAP_PER_1K_ROOTS_MB_DEFAULT}. */
  readonly perThousandRootsMb: number;
  /** Checker growth per 1,000 served files. Default {@link TS_PROGRAM_HEAP_CHECKER_PER_1K_FILES_MB_DEFAULT}. */
  readonly checkerPerThousandFilesMb: number;
  /** Share of the ceiling a projection may claim. Default {@link TS_PROGRAM_HEAP_USABLE_PCT_DEFAULT}. */
  readonly usableHeapPct: number;
}

/**
 * What this isolate may run.
 *
 * - `whole` — the segmented whole-project Program, the fast path.
 * - `coverage` — per-entry Programs with coverage reuse; 17x slower per file
 *   but its peak is one closure rather than one closure plus a corpus of
 *   checker state.
 * - `typecheckerOff` — no `ts.Program` at all, which is what
 *   `CODEGRAPH_TS_TYPECHECKER=0` configures and what a host below coverage
 *   mode's own floor gets whether it configured it or not.
 */
export type TSProgramAdmissionVerdict = "whole" | "coverage" | "typecheckerOff";

/** The verdict plus every number it was reached from, so a report re-derives nothing. */
export interface TSProgramAdmissionAssessment {
  readonly verdict: TSProgramAdmissionVerdict;
  readonly heapSizeLimitMb: number;
  readonly rootCount: number;
  readonly segmentFiles: number;
  readonly wholeProjectionMb: number;
  readonly wholeRequiredMb: number;
  readonly coverageProjectionMb: number;
  readonly coverageRequiredMb: number;
}

export interface TSProgramAdmissionRequest {
  /** Files the project claims — the root set a whole Program would be built from. */
  readonly rootCount: number;
  /** Files one Program serves before it is replaced (`TSProgramCacheOptions.wholeSegmentFiles`). */
  readonly segmentFiles: number;
  /** `v8.getHeapStatistics().heap_size_limit` in MB, read in THIS isolate. */
  readonly heapSizeLimitMb: number;
  readonly budget: TSProgramHeapBudget;
}

/** This isolate's own V8 old-generation ceiling, in MB. */
export function readHeapSizeLimitMb(): number {
  return Math.round(getHeapStatistics().heap_size_limit / BYTES_PER_MB);
}

function isUsableLimit(heapSizeLimitMb: number): boolean {
  return Number.isFinite(heapSizeLimitMb) && heapSizeLimitMb > 0;
}

/**
 * Which Program strategy fits `heapSizeLimitMb`, and the arithmetic behind it.
 *
 * Two projections, sharing the build term and differing only in the checker:
 * whole mode holds ONE Program for the length of a segment, so it carries a
 * segment's worth of checker growth; coverage mode replaces its Programs
 * constantly, so its floor is the build alone — one full closure, which for a
 * barrel-connected repository is most of the project either way. That shared
 * term is why the gap between the two floors is narrow, and why a host below
 * the coverage floor has nowhere left to fall but out of the type checker.
 *
 * An unusable reading is treated as NO EVIDENCE and admits the fast path. A
 * host whose V8 will not report a ceiling is not a host known to be small, and
 * refusing type information on a failed introspection would be a worse default
 * than the crash this exists to prevent — that crash is bounded to
 * memory-constrained hosts, whereas a broken reading would silently degrade
 * every run everywhere.
 */
export function assessTSProgramAdmission(request: TSProgramAdmissionRequest): TSProgramAdmissionAssessment {
  const { rootCount, segmentFiles, heapSizeLimitMb, budget } = request;
  const buildMb = budget.baseMb + (rootCount * budget.perThousandRootsMb) / 1000;
  // The checker cannot grow past the corpus, however large the segment: a
  // segment bigger than the project is how an operator turns segmentation off,
  // and the projection has to follow them there rather than keep quoting the
  // segmented figure.
  const checkerMb = (Math.min(segmentFiles, rootCount) * budget.checkerPerThousandFilesMb) / 1000;
  const usable = budget.usableHeapPct / 100;

  const wholeProjectionMb = Math.round(buildMb + checkerMb);
  const coverageProjectionMb = Math.round(buildMb);
  const wholeRequiredMb = Math.round(wholeProjectionMb / usable);
  const coverageRequiredMb = Math.round(coverageProjectionMb / usable);

  const verdict = !isUsableLimit(heapSizeLimitMb)
    ? "whole"
    : heapSizeLimitMb >= wholeRequiredMb
      ? "whole"
      : heapSizeLimitMb >= coverageRequiredMb
        ? "coverage"
        : "typecheckerOff";

  return {
    verdict,
    heapSizeLimitMb,
    rootCount,
    segmentFiles,
    wholeProjectionMb,
    wholeRequiredMb,
    coverageProjectionMb,
    coverageRequiredMb,
  };
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
  return (
    `TypeScript type checker DISABLED for this run: this isolate's V8 heap ceiling is ` +
    `${assessment.heapSizeLimitMb} MB, but one covering ts.Program over ${assessment.rootCount} roots ` +
    `projects ${assessment.coverageProjectionMb} MB and needs ${assessment.coverageRequiredMb} MB with headroom ` +
    `(the whole-project strategy projects ${assessment.wholeProjectionMb} MB and needs ` +
    `${assessment.wholeRequiredMb} MB). Building it would kill this worker with ERR_WORKER_OUT_OF_MEMORY and ` +
    `lose every codegraph signal in the run, so codegraph TypeScript edges resolve without type information. ` +
    `Raise ENRICHMENT_WORKER_MEMORY_LIMIT_MB, or retune CODEGRAPH_TS_PROGRAM_HEAP_BASE_MB / ` +
    `CODEGRAPH_TS_PROGRAM_HEAP_PER_1K_ROOTS_MB / CODEGRAPH_TS_PROGRAM_HEAP_CHECKER_PER_1K_FILES_MB / ` +
    `CODEGRAPH_TS_PROGRAM_HEAP_USABLE_PCT / CODEGRAPH_TS_PROGRAM_WHOLE_SEGMENT_FILES.`
  );
}
