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
