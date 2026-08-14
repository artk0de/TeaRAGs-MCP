/**
 * Segmented whole-project Program + heap-budget admission (bd
 * tea-rags-mcp-6aytq).
 *
 * Both mechanisms answer the same measurement on taxdome's 10,912 TypeScript
 * files under honest `resourceLimits` enforcement: one whole Program costs
 * ~2.6 GB to build and then the CHECKER grows monotonically by 1.69 GB across
 * the resolve, for a 4.31 GB live set at the end. A 4096-declared worker dies at
 * about file 6,500; a 2048-declared worker cannot even build coverage mode's
 * first covering Program. And the failure is catastrophic rather than graceful —
 * V8 kills the worker isolate, so `ERR_WORKER_OUT_OF_MEMORY` costs the run every
 * codegraph signal with no retry.
 *
 * Segmenting bounds the checker to one segment's worth of growth; admission
 * refuses the strategies whose projection does not fit the isolate at all.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  TS_PROGRAM_WHOLE_SEGMENT_FILES_DEFAULT,
  TSProgramCache,
} from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import type { TSProgramHeapBudget } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-heap-admission.js";
import { resolveProgramCacheStrategy } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";

const tsOptions = { baseUrl: ".", paths: {} };

/**
 * A budget whose terms are large enough that two tiny files straddle the
 * thresholds: 1,000 MB of base, 500 MB per root, 1,000 MB of checker growth per
 * segment file. Over a 2-root project with a 1-file segment that puts the
 * coverage floor at 2,000 MB (needs 2,500 at 80% usable) and the whole-mode peak
 * at 3,000 MB (needs 3,750).
 */
const STRADDLING_BUDGET: TSProgramHeapBudget = {
  baseMb: 1000,
  perThousandRootsMb: 500_000,
  checkerPerThousandFilesMb: 1_000_000,
  usableHeapPct: 80,
};

function writeSource(repoRoot: string, relPath: string, content: string): string {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

describe("TSProgramCache whole-Program segmentation (bd tea-rags-mcp-6aytq)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-program-segment-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** Six files with no import relationship, so only the whole Program covers them all. */
  function writeCorpus(): readonly string[] {
    return ["a", "b", "c", "d", "e", "f"].map((name, index) =>
      writeSource(repoRoot, `src/${name}.ts`, `export function ${name}(): number {\n  return ${index};\n}\n`),
    );
  }

  function segmentedCache(wholeSegmentFiles: number, roots: readonly string[]): TSProgramCache {
    return new TSProgramCache({ repoRoot, tsOptions, strategy: "whole", wholeSegmentFiles, projectRoots: () => roots });
  }

  it("serves a whole segment off one Program and rebuilds once the segment is full", () => {
    const cache = segmentedCache(2, writeCorpus());

    const a = cache.acquire("src/a.ts");
    const b = cache.acquire("src/b.ts");
    const c = cache.acquire("src/c.ts");

    // a and b are the first segment; c is the file that overflows it, so c is
    // already served off the Program that replaced them.
    expect(a?.program).toBe(b?.program);
    expect(c?.program).not.toBe(b?.program);
    expect(cache.wholeProgramBuildCount).toBe(2);
    expect(cache.segmentFileCount).toBe(1);
  });

  it("counts files served, not acquires — a file asked about repeatedly is one served file", () => {
    // Production acquires ~43 times per file (467,308 acquires over 10,912
    // files on taxdome), so a segment counted in acquires would rebuild every
    // ~116 files instead of every 5,000.
    const cache = segmentedCache(3, writeCorpus());

    for (let repeat = 0; repeat < 10; repeat++) {
      cache.acquire("src/a.ts");
      cache.acquire("src/b.ts");
    }

    expect(cache.wholeProgramBuildCount).toBe(1);
  });

  it("keeps exactly one whole Program — the replaced one is reachable from nothing", () => {
    const cache = segmentedCache(2, writeCorpus());
    const first = cache.acquire("src/a.ts");
    cache.acquire("src/b.ts");
    cache.acquire("src/c.ts");

    // Re-acquiring a file from the retired segment must come back on the NEW
    // Program: if the cache still held the old one, `findCovering` would serve
    // its memoized handle and the retired Program would never be collectable.
    const again = cache.acquire("src/a.ts");

    expect(again?.program).not.toBe(first?.program);
    expect(cache.size).toBe(1);
    expect(cache.wholeProgramFileCount).toBeGreaterThanOrEqual(6);
  });

  it("drops the replaced Program's reference before building its successor", async () => {
    // The point of segmenting is a lower PEAK, so the two Programs must not be
    // live at the same time. WeakRef is the only way to assert that, and the
    // dependency-growth probe established the idiom.
    const { setFlagsFromString } = await import("node:v8");
    const { runInNewContext } = await import("node:vm");
    setFlagsFromString("--expose-gc");
    const forceGc = runInNewContext("gc") as () => void;

    const cache = segmentedCache(2, writeCorpus());
    let retired: WeakRef<object> | null = null;
    // Scoped so the handle itself is unreachable before the sweep.
    ((): void => {
      const first = cache.acquire("src/a.ts");
      retired = new WeakRef(first?.program as object);
      cache.acquire("src/b.ts");
      cache.acquire("src/c.ts");
    })();

    await new Promise((resolve) => setTimeout(resolve, 0));
    forceGc();
    forceGc();

    expect((retired as unknown as WeakRef<object>).deref()).toBeUndefined();
  });

  it("reuses the shared parses across the rebuild rather than re-reading the corpus", () => {
    // The AST is the largest population in the heap (1,331 MB of the 5.84 GB
    // snapshot); segmenting exists to release the CHECKER, not to re-parse.
    const cache = segmentedCache(2, writeCorpus());
    const before = cache.acquire("src/a.ts");
    cache.acquire("src/b.ts");
    cache.acquire("src/c.ts");
    const after = cache.acquire("src/a.ts");

    expect(after?.program).not.toBe(before?.program);
    expect(after?.sourceFile).toBe(before?.sourceFile);
  });

  it("never rebuilds when the segment is larger than the corpus", () => {
    const cache = segmentedCache(TS_PROGRAM_WHOLE_SEGMENT_FILES_DEFAULT, writeCorpus());

    for (const name of ["a", "b", "c", "d", "e", "f"]) cache.acquire(`src/${name}.ts`);

    expect(cache.wholeProgramBuildCount).toBe(1);
  });

  it("degrades to per-entry coverage when the rebuild itself produces nothing", () => {
    const roots = writeCorpus();
    const cache = segmentedCache(2, roots);

    cache.acquire("src/b.ts");
    cache.acquire("src/c.ts");
    // The rebuild is handed the same roots, and roots[0] is the file it points
    // the new Program at — removing it makes `buildFrom` return null exactly as
    // a failed `ts.createProgram` does.
    rmSync(roots[0], { force: true });
    cache.acquire("src/d.ts");

    expect(cache.wholeProgramFileCount).toBe(0);
    expect(cache.acquire("src/e.ts")).not.toBeNull();
    // d and e each opened their own closure — the per-entry path, unassisted.
    expect(cache.size).toBe(2);
  });

  it("retires the per-entry LRU at the boundary too, not only the whole Program", () => {
    // Measured reason: on taxdome the whole Program answers ~145 distinct
    // acquires and the per-entry LRU serves the rest, so eight per-entry
    // checkers accumulate exactly the state the segment exists to bound.
    const roots = writeCorpus();
    // A root set of one leaves every other file to the per-entry path.
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "whole",
      wholeSegmentFiles: 2,
      projectRoots: () => [roots[0]],
    });

    const b = cache.acquire("src/b.ts");
    cache.acquire("src/c.ts");
    expect(cache.size).toBeGreaterThan(1);

    cache.acquire("src/d.ts");

    // b's Program was retained in the LRU and is now gone: re-acquiring it
    // builds a new one rather than serving the retired checker.
    expect(cache.acquire("src/b.ts")?.program).not.toBe(b?.program);
  });

  it("reads the segment size from CODEGRAPH_TS_PROGRAM_WHOLE_SEGMENT_FILES", () => {
    expect(resolveProgramCacheStrategy({}).wholeSegmentFiles).toBe(TS_PROGRAM_WHOLE_SEGMENT_FILES_DEFAULT);
    expect(resolveProgramCacheStrategy({ CODEGRAPH_TS_PROGRAM_WHOLE_SEGMENT_FILES: "1000" }).wholeSegmentFiles).toBe(
      1000,
    );
    expect(resolveProgramCacheStrategy({ CODEGRAPH_TS_PROGRAM_WHOLE_SEGMENT_FILES: "0" }).wholeSegmentFiles).toBe(
      TS_PROGRAM_WHOLE_SEGMENT_FILES_DEFAULT,
    );
    expect(resolveProgramCacheStrategy({ CODEGRAPH_TS_PROGRAM_WHOLE_SEGMENT_FILES: "junk" }).wholeSegmentFiles).toBe(
      TS_PROGRAM_WHOLE_SEGMENT_FILES_DEFAULT,
    );
  });
});

describe("TSProgramCache heap admission (bd tea-rags-mcp-6aytq)", () => {
  let repoRoot: string;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-program-admit-")));
    stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stderr.mockRestore();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeTwoEntries(): readonly string[] {
    return [
      writeSource(repoRoot, "src/a.ts", `export function a(): number {\n  return 1;\n}\n`),
      writeSource(repoRoot, "src/b.ts", `export function b(): number {\n  return 2;\n}\n`),
    ];
  }

  function admittedCache(heapSizeLimitMb: number, roots: readonly string[]): TSProgramCache {
    return new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "whole",
      wholeSegmentFiles: 1,
      projectRoots: () => roots,
      heapBudget: STRADDLING_BUDGET,
      readHeapSizeLimitMb: () => heapSizeLimitMb,
    });
  }

  it("builds the whole Program when the isolate clears the whole-mode projection", () => {
    const cache = admittedCache(4000, writeTwoEntries());

    expect(cache.acquire("src/a.ts")).not.toBeNull();
    expect(cache.wholeProgramFileCount).toBeGreaterThanOrEqual(2);
    expect(cache.typeCheckerDisabled).toBe(false);
  });

  it("falls back to per-entry coverage between the two floors", () => {
    const cache = admittedCache(3000, writeTwoEntries());

    const a = cache.acquire("src/a.ts");
    const b = cache.acquire("src/b.ts");

    expect(cache.wholeProgramFileCount).toBe(0);
    expect(a?.program).not.toBe(b?.program);
    expect(cache.typeCheckerDisabled).toBe(false);
  });

  it("refuses every Program below the coverage floor and hands out no type information", () => {
    const cache = admittedCache(2000, writeTwoEntries());

    expect(cache.acquire("src/a.ts")).toBeNull();
    expect(cache.typeCheckerDisabled).toBe(true);
    expect(cache.wholeProgramFileCount).toBe(0);
    expect(cache.size).toBe(0);
  });

  it("says so once, naming the limit and the knobs, not once per acquire", () => {
    const cache = admittedCache(2000, writeTwoEntries());

    cache.acquire("src/a.ts");
    cache.acquire("src/b.ts");
    cache.acquire("src/a.ts");

    const warnings = stderr.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("2000"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[enrichment-worker]");
    expect(warnings[0]).toContain("CODEGRAPH_TS_PROGRAM_WHOLE_SEGMENT_FILES");
  });

  it("refuses an explicit whole strategy too — an operator cannot opt into an OOM kill", () => {
    // The root-count ceiling IS second-guessed for an explicit `whole` because
    // it is a preference. A projection above the isolate's ceiling is not a
    // preference; it is `ERR_WORKER_OUT_OF_MEMORY` and the loss of every
    // codegraph signal in the run.
    const cache = admittedCache(2000, writeTwoEntries());

    cache.primeForExpectedEntries(10_000);

    expect(cache.typeCheckerDisabled).toBe(true);
  });

  it("gates a declared BULK run under the coverage strategy as well", () => {
    // Coverage mode has its own floor — one covering Program over the main
    // connectivity component — and on taxdome a 2048-declared worker died at
    // that first build. The declared volume is what says the run is bulk.
    const roots = writeTwoEntries();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "coverage",
      wholeMinEntries: 2,
      projectRoots: () => roots,
      heapBudget: { ...STRADDLING_BUDGET, perThousandRootsMb: 1000 },
      readHeapSizeLimitMb: () => 2000,
    });

    cache.primeForExpectedEntries(1000);

    expect(cache.typeCheckerDisabled).toBe(true);
    expect(cache.acquire("src/a.ts")).toBeNull();
  });

  it("leaves an INCREMENTAL coverage run alone — a handful of files reaches no floor", () => {
    const roots = writeTwoEntries();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "coverage",
      wholeMinEntries: 200,
      projectRoots: () => roots,
      heapBudget: { ...STRADDLING_BUDGET, perThousandRootsMb: 1000 },
      readHeapSizeLimitMb: () => 2000,
    });

    cache.primeForExpectedEntries(3);

    expect(cache.typeCheckerDisabled).toBe(false);
    expect(cache.acquire("src/a.ts")).not.toBeNull();
  });

  it("re-arms the verdict on reset, because the next run may be a different shape", () => {
    const cache = admittedCache(2000, writeTwoEntries());
    cache.acquire("src/a.ts");
    expect(cache.typeCheckerDisabled).toBe(true);

    cache.reset();

    expect(cache.typeCheckerDisabled).toBe(false);
  });
});
