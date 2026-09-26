/**
 * `TSProgramCache` resolves a bulk pass through closure-batch Programs (bd
 * tea-rags-mcp-vtuu4), replacing the whole-project Program and its file-count
 * segments (bd tea-rags-mcp-6aytq).
 *
 * The whole Program OOMed taxdome's pass-2 worker at ~5.4 GB. Batches bound
 * the peak to one Program over a closure union of at most 40 MB of text and
 * 15k call sites, plus the shared parse cache — measured at 1,881 MB max live
 * over 33 sequential batches. What these cases pin is the part a heap number
 * cannot show: which Program serves which file, that a batch is released
 * before the next is built, that parses survive across batches, and where
 * oversize roots and the admission verdict route.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TSProgramCache } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import type { TSProgramHeapBudget } from "../../../../../../src/core/domains/language/typescript/resolver/ts-program-heap-admission.js";

const tsOptions = { baseUrl: ".", paths: {} };
const MB = 1024 * 1024;

/**
 * A 100 MB base with nothing else charged per byte, and 1 MB per root, so a
 * ceiling just under 100 refuses the batches and one at 102 refuses a
 * four-root coverage floor (100 + 4).
 */
const BYTE_SCALED_BUDGET: TSProgramHeapBudget = {
  baseMb: 100,
  perTextMb: 0,
  perThousandCallSitesMb: 0,
  perThousandRootsMb: 1000,
  usableHeapPct: 100,
};

describe("TSProgramCache closure batches (bd tea-rags-mcp-vtuu4)", () => {
  let repoRoot: string;
  let stderr: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    repoRoot = realpathSync(mkdtempSync(join(tmpdir(), "ts-program-batches-")));
    stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  });

  afterEach(() => {
    stderr.mockRestore();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function write(relPath: string, content: string): string {
    const abs = join(repoRoot, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return abs;
  }

  /** Four unrelated files; a call cap of 20 at 10 calls each packs them two per batch. */
  function writeFourUnrelated(): { relPaths: string[]; callSites: Map<string, number> } {
    const relPaths = ["a", "b", "c", "d"].map((name) => `src/${name}.ts`);
    relPaths.forEach((relPath, index) => {
      write(relPath, `export function f${index}(): number {\n  return ${index};\n}\n`);
    });
    return { relPaths, callSites: new Map(relPaths.map((relPath) => [relPath, 10])) };
  }

  function batchedCache(overrides: Partial<ConstructorParameters<typeof TSProgramCache>[0]> = {}): TSProgramCache {
    return new TSProgramCache({
      repoRoot,
      tsOptions,
      strategy: "whole",
      projectRoots: () => [],
      batchCallSites: 20,
      ...overrides,
    });
  }

  it("serves every file of a batch off that batch's Program", () => {
    const { relPaths, callSites } = writeFourUnrelated();
    const cache = batchedCache();
    cache.primeForExpectedEntries(relPaths.length, relPaths, callSites);

    const groups = cache.planResolveVisits() ?? [];
    expect(groups).toHaveLength(2);
    const [first, second] = groups.map((group) => group.map((relPath) => cache.acquire(relPath)?.program));

    expect(first[0]).toBe(first[1]);
    expect(second[0]).toBe(second[1]);
    expect(second[0]).not.toBe(first[0]);
    expect(cache.wholeProgramBuildCount).toBe(2);
  });

  it("orders pass-2 groups batch by batch, every corpus file in exactly one group", () => {
    const { relPaths, callSites } = writeFourUnrelated();
    const cache = batchedCache();
    cache.primeForExpectedEntries(relPaths.length, relPaths, callSites);

    const visited = (cache.planResolveVisits() ?? []).flat();

    expect([...visited].sort()).toEqual([...relPaths].sort());
  });

  it("releases the current batch Program before it builds the next one", async () => {
    const { setFlagsFromString } = await import("node:v8");
    const { runInNewContext } = await import("node:vm");
    setFlagsFromString("--expose-gc");
    const forceGc = runInNewContext("gc") as () => void;

    const { relPaths, callSites } = writeFourUnrelated();
    const cache = batchedCache();
    cache.primeForExpectedEntries(relPaths.length, relPaths, callSites);
    const [first, second] = cache.planResolveVisits() ?? [];
    let retired: WeakRef<object> | null = null;
    // Scoped so no handle of the first batch outlives the switch.
    ((): void => {
      retired = new WeakRef(cache.acquire(first[0])?.program as object);
      cache.acquire(second[0]);
    })();

    await new Promise((resolve) => setImmediate(resolve));
    forceGc();
    forceGc();

    expect(retired.deref()).toBeUndefined();
  });

  it("drops the current batch at the end of a pass-2 group", () => {
    const { relPaths, callSites } = writeFourUnrelated();
    const cache = batchedCache();
    cache.primeForExpectedEntries(relPaths.length, relPaths, callSites);
    const [first] = cache.planResolveVisits() ?? [];
    cache.acquire(first[0]);
    expect(cache.wholeProgramFileCount).toBeGreaterThan(0);

    cache.endResolveVisitGroup();

    expect(cache.wholeProgramFileCount).toBe(0);
    expect(cache.size).toBe(0);
  });

  it("reuses bound parses across batches rather than re-reading them", () => {
    write("src/shared.ts", `export function shared(): number {\n  return 0;\n}\n`);
    write("src/a.ts", `import { shared } from "./shared";\nexport const a = shared();\n`);
    write("src/b.ts", `import { shared } from "./shared";\nexport const b = shared();\n`);
    const relPaths = ["src/a.ts", "src/b.ts"];
    const cache = batchedCache({ batchCallSites: 10 });
    cache.primeForExpectedEntries(relPaths.length, relPaths, new Map(relPaths.map((relPath) => [relPath, 10])));
    const [first, second] = cache.planResolveVisits() ?? [];
    const sharedPath = join(repoRoot, "src/shared.ts");

    const before = cache.acquire(first[0])?.program.getSourceFile(sharedPath);
    const after = cache.acquire(second[0])?.program.getSourceFile(sharedPath);

    expect(before).toBeDefined();
    expect(after).toBe(before);
  });

  it("carries the prelude into every batch Program", () => {
    const globals = write("src/globals.d.ts", `declare function projectGlobal(): void;\n`);
    const { relPaths, callSites } = writeFourUnrelated();
    const cache = batchedCache({ projectRoots: () => [globals] });
    cache.primeForExpectedEntries(relPaths.length, relPaths, callSites);

    for (const group of cache.planResolveVisits() ?? []) {
      const program = cache.acquire(group[0])?.program;
      expect(program?.getSourceFile(globals)).toBeDefined();
    }
  });

  /**
   * Text of the prelude a batch carries — the default lib dominates it — read
   * off a probe cache, so a fixture can size its budget ABOVE it: every batch
   * pays it, so a budget below it makes every root oversize.
   */
  function preludeTextBytes(projectRoots: readonly string[], corpus: readonly string[]): number {
    const probe = batchedCache({ projectRoots: () => projectRoots });
    probe.primeForExpectedEntries(corpus.length, corpus, new Map(corpus.map((relPath) => [relPath, 1])));
    return Number(probe.diagnostics().preludeTextBytes);
  }

  /** A comment line of `mb` MiB — enough text to push a root past a budget set just above the prelude. */
  function paddingOf(mb: number): string {
    return `// ${"x".repeat(mb * MB)}\n`;
  }

  it("runs oversize roots last, after clearing the parse cache, prelude kept", () => {
    const globals = write("src/globals.d.ts", `declare function projectGlobal(): void;\n`);
    write("src/shared.ts", `export function shared(): number {\n  return 0;\n}\n`);
    write("src/small.ts", `import { shared } from "./shared";\nexport const small = shared();\n`);
    write("src/big.ts", `import { shared } from "./shared";\n${paddingOf(2)}export const big = shared();\n`);
    const relPaths = ["src/small.ts", "src/big.ts"];
    const prelude = preludeTextBytes([globals], ["src/small.ts"]);
    const cache = batchedCache({ projectRoots: () => [globals], batchTextBytes: prelude + MB });
    cache.primeForExpectedEntries(relPaths.length, relPaths, new Map(relPaths.map((relPath) => [relPath, 1])));

    const groups = cache.planResolveVisits() ?? [];
    expect(groups.at(-1)).toEqual(["src/big.ts"]);
    const small = cache.acquire("src/small.ts")?.program;
    const big = cache.acquire("src/big.ts")?.program;

    const sharedPath = join(repoRoot, "src/shared.ts");
    expect(big?.getSourceFile(sharedPath)).not.toBe(small?.getSourceFile(sharedPath));
    expect(big?.getSourceFile(globals)).toBe(small?.getSourceFile(globals));
    expect(cache.diagnostics()).toMatchObject({ oversizeRoots: 1, oversizeRootsWithoutChecker: 0 });
  });

  it("resolves an oversize root over the heap budget without the checker and counts it", () => {
    write("src/small.ts", `export const small = 1;\n`);
    write("src/big.ts", `${paddingOf(4)}export const big = 2;\n`);
    const relPaths = ["src/small.ts", "src/big.ts"];
    const prelude = preludeTextBytes([], ["src/small.ts"]);
    const cache = batchedCache({
      batchTextBytes: prelude + MB,
      // One MB of heap per MB of text and nothing else: the batch (prelude +
      // a line) projects under the ceiling, the oversize root (prelude + 4 MB)
      // over it.
      heapBudget: { baseMb: 0, perTextMb: 1, perThousandCallSitesMb: 0, perThousandRootsMb: 0, usableHeapPct: 100 },
      readHeapSizeLimitMb: () => Math.ceil((prelude + MB) / MB),
      maxParsedSourceTextBytes: 1,
    });
    cache.primeForExpectedEntries(relPaths.length, relPaths, new Map(relPaths.map((relPath) => [relPath, 1])));

    expect(cache.acquire("src/small.ts")).not.toBeNull();
    expect(cache.acquire("src/big.ts")).toBeNull();
    expect(cache.acquire("src/big.ts")).toBeNull();
    expect(cache.typeCheckerDisabled).toBe(false);
    expect(cache.diagnostics()).toMatchObject({ oversizeRootsWithoutChecker: 1 });
    const warnings = stderr.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("oversize"));
    expect(warnings).toHaveLength(1);
  });

  it("serves a file no batch names through the per-entry path", () => {
    const { relPaths, callSites } = writeFourUnrelated();
    write("src/outside.ts", `export const outside = 5;\n`);
    const cache = batchedCache();
    cache.primeForExpectedEntries(relPaths.length, relPaths, callSites);

    const inside = cache.acquire(relPaths[0]);
    const outside = cache.acquire("src/outside.ts");

    expect(outside).not.toBeNull();
    expect(outside?.program).not.toBe(inside?.program);
    expect(cache.diagnostics()).toMatchObject({ entryBuilds: 1 });
  });

  it("refuses every Program when the batched projection does not fit, and says so once", () => {
    const { relPaths, callSites } = writeFourUnrelated();
    const cache = batchedCache({ heapBudget: BYTE_SCALED_BUDGET, readHeapSizeLimitMb: () => 99 });
    cache.primeForExpectedEntries(relPaths.length, relPaths, callSites);

    expect(cache.typeCheckerDisabled).toBe(true);
    expect(cache.acquire(relPaths[0])).toBeNull();
    expect(cache.acquire(relPaths[1])).toBeNull();
    const warnings = stderr.mock.calls.map((call) => String(call[0])).filter((line) => line.includes("99 MB"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("[enrichment-worker]");
    expect(warnings[0]).toContain("CODEGRAPH_TS_PROGRAM_BATCH_TEXT_MB");
  });

  it("re-arms the verdict on reset, because the next run may be a different shape", () => {
    const { relPaths, callSites } = writeFourUnrelated();
    const cache = batchedCache({ heapBudget: BYTE_SCALED_BUDGET, readHeapSizeLimitMb: () => 99 });
    cache.primeForExpectedEntries(relPaths.length, relPaths, callSites);
    expect(cache.typeCheckerDisabled).toBe(true);

    cache.reset();

    expect(cache.typeCheckerDisabled).toBe(false);
    expect(cache.planResolveVisits()).toBeUndefined();
  });

  it("gates a declared BULK run under the coverage strategy on the coverage floor", () => {
    // Coverage mode's floor is one covering Program over the main connectivity
    // component; on taxdome a 2048-declared worker died at that first build.
    const { relPaths } = writeFourUnrelated();
    const roots = relPaths.map((relPath) => join(repoRoot, relPath));
    const cache = batchedCache({
      strategy: "coverage",
      wholeMinEntries: 2,
      projectRoots: () => roots,
      heapBudget: BYTE_SCALED_BUDGET,
      readHeapSizeLimitMb: () => 102,
    });

    cache.primeForExpectedEntries(1000);

    expect(cache.typeCheckerDisabled).toBe(true);
    expect(cache.acquire(relPaths[0])).toBeNull();
  });

  it("leaves an INCREMENTAL coverage run alone — a handful of files reaches no floor", () => {
    const { relPaths } = writeFourUnrelated();
    const roots = relPaths.map((relPath) => join(repoRoot, relPath));
    const cache = batchedCache({
      strategy: "coverage",
      wholeMinEntries: 200,
      projectRoots: () => roots,
      heapBudget: BYTE_SCALED_BUDGET,
      readHeapSizeLimitMb: () => 102,
    });

    cache.primeForExpectedEntries(3);

    expect(cache.typeCheckerDisabled).toBe(false);
    expect(cache.acquire(relPaths[0])).not.toBeNull();
  });

  it("offers no visit order while it has no batch plan", () => {
    const { relPaths } = writeFourUnrelated();
    const cache = batchedCache({ strategy: "coverage" });

    cache.primeForExpectedEntries(relPaths.length, relPaths);

    expect(cache.planResolveVisits()).toBeUndefined();
  });
});
