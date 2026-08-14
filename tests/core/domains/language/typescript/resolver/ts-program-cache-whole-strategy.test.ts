/**
 * Whole-project Program strategy (bd tea-rags-mcp-6aytq).
 *
 * Measured on taxdome's real corpus (10,912 TS files) with the offline harness
 * `scripts/spikes/ts-live-resolve-harness.ts`: the per-entry coverage strategy
 * spends 83% of pass 2 inside `ts.createProgram` and never stops paying, while
 * ONE Program built from every project file costs 10.1 s once and serves every
 * later acquire — 2.64 ms/file over the whole corpus against a 452-900 s
 * projection for coverage mode. These cases pin the selection rules and the
 * fallbacks; the numbers live in the docblocks they justify.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadTsConfigFileNames } from "../../../../../../src/core/domains/language/typescript/resolver/ts-config-loader.js";
import {
  TS_PROGRAM_STRATEGY_DEFAULT,
  TS_PROGRAM_WHOLE_MIN_ENTRIES_DEFAULT,
  TS_PROGRAM_WHOLE_ROOT_FILES_MAX_DEFAULT,
  TS_PROGRAM_WHOLE_SEGMENT_FILES_DEFAULT,
  TSProgramCache,
} from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { resolveProgramCacheStrategy } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";

const tsOptions = { baseUrl: ".", paths: {} };

function writeSource(repoRoot: string, relPath: string, content: string): string {
  const abs = join(repoRoot, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content, "utf8");
  return abs;
}

describe("resolveProgramCacheStrategy (bd tea-rags-mcp-6aytq)", () => {
  it("defaults to auto with the compiled-in root cap when nothing is set", () => {
    expect(resolveProgramCacheStrategy({})).toEqual({
      strategy: TS_PROGRAM_STRATEGY_DEFAULT,
      wholeRootFilesMax: TS_PROGRAM_WHOLE_ROOT_FILES_MAX_DEFAULT,
      wholeMinEntries: TS_PROGRAM_WHOLE_MIN_ENTRIES_DEFAULT,
      // The segment size joined this resolver when the whole Program stopped
      // being one Program for the run's length (bd tea-rags-mcp-6aytq).
      wholeSegmentFiles: TS_PROGRAM_WHOLE_SEGMENT_FILES_DEFAULT,
    });
  });

  it("reads each of the three strategies from CODEGRAPH_TS_PROGRAM_STRATEGY", () => {
    for (const strategy of ["coverage", "whole", "auto"] as const) {
      expect(resolveProgramCacheStrategy({ CODEGRAPH_TS_PROGRAM_STRATEGY: strategy }).strategy).toBe(strategy);
    }
  });

  it("falls back to the default strategy on an unknown value", () => {
    expect(resolveProgramCacheStrategy({ CODEGRAPH_TS_PROGRAM_STRATEGY: "everything" }).strategy).toBe(
      TS_PROGRAM_STRATEGY_DEFAULT,
    );
  });

  it("reads the root cap from CODEGRAPH_TS_PROGRAM_WHOLE_ROOT_MAX and refuses a non-positive one", () => {
    expect(resolveProgramCacheStrategy({ CODEGRAPH_TS_PROGRAM_WHOLE_ROOT_MAX: "500" }).wholeRootFilesMax).toBe(500);
    expect(resolveProgramCacheStrategy({ CODEGRAPH_TS_PROGRAM_WHOLE_ROOT_MAX: "0" }).wholeRootFilesMax).toBe(
      TS_PROGRAM_WHOLE_ROOT_FILES_MAX_DEFAULT,
    );
  });

  it("reads the warm-up gate from CODEGRAPH_TS_PROGRAM_WHOLE_MIN_ENTRIES", () => {
    expect(resolveProgramCacheStrategy({}).wholeMinEntries).toBe(TS_PROGRAM_WHOLE_MIN_ENTRIES_DEFAULT);
    expect(resolveProgramCacheStrategy({ CODEGRAPH_TS_PROGRAM_WHOLE_MIN_ENTRIES: "1" }).wholeMinEntries).toBe(1);
    expect(resolveProgramCacheStrategy({ CODEGRAPH_TS_PROGRAM_WHOLE_MIN_ENTRIES: "-3" }).wholeMinEntries).toBe(
      TS_PROGRAM_WHOLE_MIN_ENTRIES_DEFAULT,
    );
  });
});

describe("TSProgramCache whole-project strategy (bd tea-rags-mcp-6aytq)", () => {
  let repoRoot: string;

  beforeEach(() => {
    // realpath: macOS `/var` → `/private/var`, and the compiler host reports
    // realpaths — the cache must agree with them for relPath math.
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-program-whole-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** Two entry files with no import relationship — neither closure covers the other. */
  function writeTwoUnrelatedEntries(): readonly string[] {
    return [
      writeSource(repoRoot, "src/a.ts", `export function a(): number {\n  return 1;\n}\n`),
      writeSource(repoRoot, "src/b.ts", `export function b(): number {\n  return 2;\n}\n`),
    ];
  }

  it("serves unrelated entries off ONE Program instead of building per entry", () => {
    const roots = writeTwoUnrelatedEntries();
    const cache = new TSProgramCache({ repoRoot, tsOptions, strategy: "whole", projectRoots: () => roots });

    const a = cache.acquire("src/a.ts");
    const b = cache.acquire("src/b.ts");

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // The identity IS the claim: coverage mode gives these two files two
    // Programs, because neither closure reaches the other.
    expect(a?.program).toBe(b?.program);
    expect(a?.sourceFile.fileName).not.toBe(b?.sourceFile.fileName);
    expect(cache.wholeProgramFileCount).toBeGreaterThanOrEqual(2);
  });

  it("builds two Programs for the same two entries under the coverage strategy", () => {
    const roots = writeTwoUnrelatedEntries();
    const cache = new TSProgramCache({ repoRoot, tsOptions, strategy: "coverage", projectRoots: () => roots });

    const a = cache.acquire("src/a.ts");
    const b = cache.acquire("src/b.ts");

    expect(a?.program).not.toBe(b?.program);
    expect(cache.wholeProgramFileCount).toBe(0);
    expect(cache.size).toBe(2);
  });

  it("auto takes the whole Program when the root set is within the cap", () => {
    const roots = writeTwoUnrelatedEntries();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "auto",
      wholeRootFilesMax: 10,
      wholeMinEntries: 1,
      projectRoots: () => roots,
    });

    expect(cache.acquire("src/a.ts")?.program).toBe(cache.acquire("src/b.ts")?.program);
  });

  it("auto falls back to coverage when the root set exceeds the cap", () => {
    const roots = writeTwoUnrelatedEntries();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "auto",
      wholeRootFilesMax: 1,
      wholeMinEntries: 1,
      projectRoots: () => roots,
    });

    expect(cache.acquire("src/a.ts")?.program).not.toBe(cache.acquire("src/b.ts")?.program);
    expect(cache.wholeProgramFileCount).toBe(0);
  });

  it("auto stays on coverage until the run has touched wholeMinEntries distinct files", () => {
    // The incremental-reindex shape: a handful of files must not pay a
    // whole-project build (taxdome: 10.1 s and ~4 GB for three changed files).
    const roots = writeTwoUnrelatedEntries();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "auto",
      wholeMinEntries: 2,
      projectRoots: () => roots,
    });

    cache.acquire("src/a.ts");
    expect(cache.wholeProgramFileCount).toBe(0);

    cache.acquire("src/b.ts");
    expect(cache.wholeProgramFileCount).toBeGreaterThanOrEqual(2);
  });

  it("counts DISTINCT entries towards the warm-up gate, not repeated acquires", () => {
    const roots = writeTwoUnrelatedEntries();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "auto",
      wholeMinEntries: 2,
      projectRoots: () => roots,
    });

    cache.acquire("src/a.ts");
    cache.acquire("src/a.ts");
    cache.acquire("src/a.ts");

    expect(cache.wholeProgramFileCount).toBe(0);
  });

  it("primes on the first acquire under an explicit whole, gate or no gate", () => {
    const roots = writeTwoUnrelatedEntries();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "whole",
      wholeMinEntries: TS_PROGRAM_WHOLE_MIN_ENTRIES_DEFAULT,
      projectRoots: () => roots,
    });

    cache.acquire("src/a.ts");

    expect(cache.wholeProgramFileCount).toBeGreaterThanOrEqual(2);
  });

  it("falls back to coverage when the root set is empty — a project with no tsconfig", () => {
    writeTwoUnrelatedEntries();
    const cache = new TSProgramCache({ repoRoot, tsOptions, strategy: "whole", projectRoots: () => [] });

    expect(cache.acquire("src/a.ts")).not.toBeNull();
    expect(cache.wholeProgramFileCount).toBe(0);
  });

  it("still builds a per-entry Program for a file the root set does not contain", () => {
    const [a] = writeTwoUnrelatedEntries();
    writeSource(repoRoot, "src/outside.ts", `export function outside(): number {\n  return 3;\n}\n`);
    const cache = new TSProgramCache({ repoRoot, tsOptions, strategy: "whole", projectRoots: () => [a] });

    const covered = cache.acquire("src/a.ts");
    const uncovered = cache.acquire("src/outside.ts");

    expect(covered).not.toBeNull();
    expect(uncovered).not.toBeNull();
    expect(uncovered?.program).not.toBe(covered?.program);
  });

  it("discovers the roots once, not per acquire", () => {
    const roots = writeTwoUnrelatedEntries();
    let discoveries = 0;
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "whole",
      projectRoots: () => {
        discoveries += 1;
        return roots;
      },
    });

    cache.acquire("src/a.ts");
    cache.acquire("src/b.ts");
    cache.acquire("src/a.ts");

    expect(discoveries).toBe(1);
  });

  it("refuses to serve a file changed after the whole Program was built", () => {
    const roots = writeTwoUnrelatedEntries();
    const cache = new TSProgramCache({ repoRoot, tsOptions, strategy: "whole", projectRoots: () => roots });
    const before = cache.acquire("src/b.ts");

    // A Program cannot re-stat what it holds, so a file touched after the build
    // must be rebuilt rather than served from the stale copy.
    writeSource(repoRoot, "src/b.ts", `export function b(): number {\n  return 22;\n}\n`);
    const after = cache.acquire("src/b.ts");

    expect(after).not.toBeNull();
    expect(after?.program).not.toBe(before?.program);
  });

  it("drops the whole Program on reset and re-primes on the next acquire", () => {
    const roots = writeTwoUnrelatedEntries();
    const cache = new TSProgramCache({ repoRoot, tsOptions, strategy: "whole", projectRoots: () => roots });
    const first = cache.acquire("src/a.ts");

    cache.reset();
    expect(cache.wholeProgramFileCount).toBe(0);

    const second = cache.acquire("src/a.ts");
    expect(second).not.toBeNull();
    expect(second?.program).not.toBe(first?.program);
    expect(cache.wholeProgramFileCount).toBeGreaterThanOrEqual(2);
  });

  it("keeps the whole Program while the byte budget evicts the per-entry ones", () => {
    // A budget far below one file of text: coverage-mode Programs are evicted
    // down to the floor, and the whole Program — the thing every later acquire
    // is served off — must not be what the eviction reaches for.
    const roots = writeTwoUnrelatedEntries();
    writeSource(repoRoot, "src/outside.ts", `export function outside(): number {\n  return 3;\n}\n`);
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "whole",
      projectRoots: () => roots,
      maxRetainedSourceTextBytes: 1,
    });

    const a = cache.acquire("src/a.ts");
    cache.acquire("src/outside.ts");

    expect(cache.acquire("src/b.ts")?.program).toBe(a?.program);
    expect(cache.wholeProgramFileCount).toBeGreaterThanOrEqual(2);
  });
});

describe("TSProgramCache eager prime on a declared bulk pass (bd tea-rags-mcp-6aytq)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-program-eager-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeTwoUnrelatedEntries(): readonly string[] {
    return [
      writeSource(repoRoot, "src/a.ts", `export function a(): number {\n  return 1;\n}\n`),
      writeSource(repoRoot, "src/b.ts", `export function b(): number {\n  return 2;\n}\n`),
    ];
  }

  it("builds the whole Program before the first acquire when the pass declares a bulk volume", () => {
    // A force-resolve knows its file count up front, so the warm-up gate's
    // per-entry builds (66 of them on taxdome, 9-13 s) buy nothing.
    const roots = writeTwoUnrelatedEntries();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "auto",
      wholeMinEntries: 2,
      projectRoots: () => roots,
    });

    cache.primeForExpectedEntries(2);

    expect(cache.wholeProgramFileCount).toBeGreaterThanOrEqual(2);
    expect(cache.acquire("src/a.ts")?.program).toBe(cache.acquire("src/b.ts")?.program);
    // Nothing landed in the per-entry LRU: every acquire was a coverage hit.
    expect(cache.size).toBe(1);
  });

  it("leaves the warm-up gate in charge when the declared volume is below it", () => {
    // The incremental-reindex shape must behave exactly as it did before the
    // hint existed: no eager build, and the per-acquire gate still governs.
    const roots = writeTwoUnrelatedEntries();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "auto",
      wholeMinEntries: 2,
      projectRoots: () => roots,
    });

    cache.primeForExpectedEntries(1);
    expect(cache.wholeProgramFileCount).toBe(0);

    cache.acquire("src/a.ts");
    expect(cache.wholeProgramFileCount).toBe(0);

    cache.acquire("src/b.ts");
    expect(cache.wholeProgramFileCount).toBeGreaterThanOrEqual(2);
  });

  it("declines to prime under the coverage strategy however large the declared volume", () => {
    const roots = writeTwoUnrelatedEntries();
    const cache = new TSProgramCache({ repoRoot, tsOptions, strategy: "coverage", projectRoots: () => roots });

    cache.primeForExpectedEntries(10000);

    expect(cache.wholeProgramFileCount).toBe(0);
    expect(cache.acquire("src/a.ts")?.program).not.toBe(cache.acquire("src/b.ts")?.program);
  });

  it("primes for an explicit whole strategy however small the declared volume", () => {
    const roots = writeTwoUnrelatedEntries();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "whole",
      wholeMinEntries: TS_PROGRAM_WHOLE_MIN_ENTRIES_DEFAULT,
      projectRoots: () => roots,
    });

    cache.primeForExpectedEntries(1);

    expect(cache.wholeProgramFileCount).toBeGreaterThanOrEqual(2);
  });

  it("still refuses a root set over the auto ceiling, declared volume or not", () => {
    const roots = writeTwoUnrelatedEntries();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "auto",
      wholeRootFilesMax: 1,
      projectRoots: () => roots,
    });

    cache.primeForExpectedEntries(10000);

    expect(cache.wholeProgramFileCount).toBe(0);
    expect(cache.acquire("src/a.ts")?.program).not.toBe(cache.acquire("src/b.ts")?.program);
  });

  it("falls back to per-entry coverage when the eager build produces nothing, without retrying", () => {
    writeTwoUnrelatedEntries();
    let discoveries = 0;
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "auto",
      wholeMinEntries: 1,
      projectRoots: () => {
        discoveries += 1;
        // A root set naming a file that is not on disk: `ts.createProgram`
        // returns a Program with no SourceFile for it, so the build yields null.
        return [join(repoRoot, "src/missing.ts")];
      },
    });

    cache.primeForExpectedEntries(1000);

    expect(cache.wholeProgramFileCount).toBe(0);
    expect(cache.acquire("src/a.ts")).not.toBeNull();
    expect(discoveries).toBe(1);
  });
});

describe("TSProgramCache run-corpus root union (bd tea-rags-mcp-6aytq)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-program-union-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /**
   * The production shape, in miniature: a file the tsconfig claims and one the
   * run resolves but the config excludes. Measured on taxdome — 9,976 of the
   * run's 10,912 TypeScript files are in the 12,335-name tsconfig expansion and
   * 936 are not, and those 936 are what the per-entry builds were being paid
   * for.
   */
  function writeConfiguredAndUnconfigured(): { readonly configured: string; readonly outside: string } {
    return {
      configured: writeSource(repoRoot, "src/a.ts", `export function a(): number {\n  return 1;\n}\n`),
      outside: writeSource(repoRoot, "excluded/b.ts", `export function b(): number {\n  return 2;\n}\n`),
    };
  }

  it("serves a corpus file the tsconfig omits off the whole Program instead of building for it", () => {
    const { configured } = writeConfiguredAndUnconfigured();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "auto",
      wholeMinEntries: 1,
      projectRoots: () => [configured],
    });

    cache.primeForExpectedEntries(1000, ["src/a.ts", "excluded/b.ts"]);

    expect(cache.wholeProgramBuildCount).toBe(1);
    expect(cache.acquire("excluded/b.ts")?.program).toBe(cache.acquire("src/a.ts")?.program);
    // Nothing reached the per-entry LRU: the union made both a coverage hit.
    expect(cache.size).toBe(1);
  });

  it("normalizes a repo-relative corpus path into the form the coverage membership test reads", () => {
    // The root set arrives absolute from `loadTsConfigFileNames` and the corpus
    // arrives as `RelPath`s off the run state. The membership key is the
    // compiler's own file name, so the two have to meet there — if they do not,
    // the Program holds the file and `findCovering` still misses it.
    const { configured } = writeConfiguredAndUnconfigured();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "whole",
      projectRoots: () => [configured],
    });

    cache.primeForExpectedEntries(1000, ["excluded/b.ts"]);
    const first = cache.acquire("excluded/b.ts");
    const second = cache.acquire("excluded/b.ts");

    expect(first).not.toBeNull();
    // Same handle identity: served off the whole Program's `derived` memo, not
    // rebuilt per acquire.
    expect(second).toBe(first);
    expect(cache.size).toBe(1);
  });

  it("measures the heap projection against the UNION size, not the tsconfig set alone", () => {
    const { configured, outside } = writeConfiguredAndUnconfigured();
    const third = writeSource(repoRoot, "src/c.ts", `export function c(): number {\n  return 3;\n}\n`);
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "whole",
      // Requirement is `rootCount * 1000 MB`; the build term is zero, so
      // coverage is always affordable and the verdict can only be whole ⇄
      // coverage. Two roots fit 2,500 MB, three do not.
      heapBudget: { baseMb: 0, perThousandRootsMb: 0, checkerPerThousandFilesMb: 1_000_000, usableHeapPct: 100 },
      readHeapSizeLimitMb: () => 2500,
      projectRoots: () => [configured, third],
    });

    cache.primeForExpectedEntries(1000, ["excluded/b.ts"]);

    expect(cache.wholeProgramBuildCount).toBe(0);
    expect(cache.typeCheckerDisabled).toBe(false);
    expect(outside).toContain("excluded");
  });

  it("hands the same union to the lazy warm-up gate when the declared volume was below it", () => {
    const { configured } = writeConfiguredAndUnconfigured();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "auto",
      wholeMinEntries: 2,
      projectRoots: () => [configured],
    });

    // Below the gate: nothing is built, but the corpus the pass declared is
    // still what the eventual build must be rooted at.
    cache.primeForExpectedEntries(1, ["src/a.ts", "excluded/b.ts"]);
    expect(cache.wholeProgramBuildCount).toBe(0);

    // The first acquire is still a warm-up build; the second opens the gate.
    cache.acquire("src/a.ts");
    const warmUpBuilds = cache.diagnostics().entryBuilds;
    cache.acquire("excluded/b.ts");

    expect(cache.wholeProgramBuildCount).toBe(1);
    // The corpus-only file came off the Program the gate built, not off a
    // per-entry build of its own — which is only possible if the lazy path saw
    // the union the eager prime declared.
    expect(cache.diagnostics().entryBuilds).toBe(warmUpBuilds);
    expect(cache.diagnostics().wholeHits).toBe(1);
  });

  it("rebuilds a rotated segment from the union rather than from the tsconfig set", () => {
    const { configured } = writeConfiguredAndUnconfigured();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "whole",
      wholeSegmentFiles: 1,
      projectRoots: () => [configured],
    });

    cache.primeForExpectedEntries(1000, ["src/a.ts", "excluded/b.ts"]);
    cache.acquire("src/a.ts");
    // The second distinct file overflows the one-file segment and rotates.
    const afterRotation = cache.acquire("excluded/b.ts");

    expect(cache.wholeProgramBuildCount).toBe(2);
    expect(afterRotation).not.toBeNull();
    expect(cache.size).toBe(1);
  });

  it("reports what the cache actually did, so a production run says so in its log", () => {
    const { configured } = writeConfiguredAndUnconfigured();
    const cache = new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "whole",
      projectRoots: () => [configured],
    });

    cache.primeForExpectedEntries(1000, ["src/a.ts", "excluded/b.ts"]);
    cache.acquire("src/a.ts");
    cache.acquire("excluded/b.ts");

    expect(cache.diagnostics()).toMatchObject({
      strategy: "whole",
      wholeProgramFiles: expect.any(Number),
      wholeProgramBuilds: 1,
      segmentFiles: 2,
      acquires: 2,
      wholeHits: 2,
      coverageHits: 0,
      entryBuilds: 0,
      typeCheckerDisabled: false,
    });
  });
});

describe("loadTsConfigFileNames (bd tea-rags-mcp-6aytq)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-config-filenames-")));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it("expands the config's include globs into absolute file names", () => {
    writeSource(repoRoot, "tsconfig.json", `{ "include": ["src/**/*"] }\n`);
    writeSource(repoRoot, "src/a.ts", `export const a = 1;\n`);
    writeSource(repoRoot, "src/nested/b.tsx", `export const b = <div />;\n`);
    writeSource(repoRoot, "other/c.ts", `export const c = 3;\n`);

    const fileNames = loadTsConfigFileNames(repoRoot);

    expect(fileNames).toContain(join(repoRoot, "src/a.ts"));
    expect(fileNames).toContain(join(repoRoot, "src/nested/b.tsx"));
    expect(fileNames).not.toContain(join(repoRoot, "other/c.ts"));
  });

  it("honours the config's exclude globs", () => {
    writeSource(repoRoot, "tsconfig.json", `{ "include": ["src/**/*"], "exclude": ["src/generated/**/*"] }\n`);
    writeSource(repoRoot, "src/a.ts", `export const a = 1;\n`);
    writeSource(repoRoot, "src/generated/g.ts", `export const g = 2;\n`);

    const fileNames = loadTsConfigFileNames(repoRoot);

    expect(fileNames).toContain(join(repoRoot, "src/a.ts"));
    expect(fileNames).not.toContain(join(repoRoot, "src/generated/g.ts"));
  });

  it("returns nothing when the project has no tsconfig", () => {
    writeSource(repoRoot, "src/a.ts", `export const a = 1;\n`);

    expect(loadTsConfigFileNames(repoRoot)).toEqual([]);
  });
});
