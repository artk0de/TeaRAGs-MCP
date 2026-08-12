/**
 * Run-scale profile of the TypeScript type-checker fallback's Program cost (bd
 * tea-rags-mcp-d77bl).
 *
 * The three fixes before this one each profiled ONE `ts.Program` build — host
 * syscalls, retained parses, allocation counts. None of them asked what the
 * cost does across a whole run of thousands of entry files, which is the shape
 * of the 9-minute stall this exists to explain.
 *
 * Reports, per entry file: the closure walk's own time, `ts.createProgram`'s
 * time, the first checker query's time, and — the number the caps are supposed
 * to bound — how many SourceFiles the Program ACTUALLY contains versus how many
 * root names it was handed.
 *
 *   npx tsx scripts/spikes/ts-program-cache-run-profile.ts [--features N] [--no-barrels] [--entries N]
 */

import { performance } from "node:perf_hooks";

import { loadTsConfig } from "../../src/core/domains/language/typescript/resolver/ts-config-loader.js";
import { TSProgramCache } from "../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { collectProjectFiles, FIXTURE_ROOT, parseShapeArgs } from "./ts-fixture-corpus.js";
import { DEFAULT_SHAPE, generateFixture, type FixtureShape } from "./ts-fixture-gen.js";

interface EntryProfile {
  relPath: string;
  closureMs: number;
  createProgramMs: number;
  checkerMs: number;
  rootFiles: number;
  programFilesProject: number;
  programFilesTotal: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx] ?? 0;
}

function summarize(values: number[]): { sum: number; mean: number; p50: number; p95: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((acc, v) => acc + v, 0);
  return {
    sum,
    mean: values.length > 0 ? sum / values.length : 0,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function profile(shape: FixtureShape, entryLimit: number | null): void {
  const generated = generateFixture(FIXTURE_ROOT, shape);
  const files = collectProjectFiles(FIXTURE_ROOT);
  const entries = entryLimit === null ? files : files.slice(0, entryLimit);
  console.log(
    `fixture: ${generated} files declared, ${files.length} on disk, ${entries.length} used as entries, barrels=${shape.useBarrels}`,
  );

  const tsOptions = loadTsConfig(FIXTURE_ROOT);
  const cache = new TSProgramCache({ repoRoot: FIXTURE_ROOT, tsOptions });

  // The cost split needs finer granularity than `acquire` exposes, so wrap the
  // two private steps a build is made of. The `ts` namespace itself is
  // getter-only and cannot be patched, so `ts.createProgram`'s share is taken as
  // the build remainder — everything `build` does apart from the closure walk is
  // `createProgram` plus two O(1) lookups.
  let buildMs = 0;
  let buildCalls = 0;
  let closureMs = 0;
  const cacheInternals = cache as unknown as {
    collectClosure: (entry: string) => string[];
    build: (entry: string) => unknown;
  };
  const realCollectClosure = cacheInternals.collectClosure.bind(cache);
  cacheInternals.collectClosure = (entry: string): string[] => {
    const started = performance.now();
    const roots = realCollectClosure(entry);
    closureMs += performance.now() - started;
    return roots;
  };
  const realBuild = cacheInternals.build.bind(cache);
  cacheInternals.build = (entry: string): unknown => {
    const started = performance.now();
    const handle = realBuild(entry);
    buildMs += performance.now() - started;
    buildCalls += 1;
    return handle;
  };
  const createProgramMsOf = (): number => buildMs - closureMs;

  const profiles: EntryProfile[] = [];
  const runStarted = performance.now();

  for (const relPath of entries) {
    const closureBefore = closureMs;
    const createBefore = createProgramMsOf();
    const handle = cache.acquire(relPath as never);
    if (!handle) continue;
    const entryClosureMs = closureMs - closureBefore;
    const entryCreateMs = createProgramMsOf() - createBefore;

    // The checker binds and resolves lazily, so the first real query is where
    // that cost lands — asking for the entry file's own symbol is the cheapest
    // query that forces it.
    const checkerStarted = performance.now();
    handle.checker.getSymbolAtLocation(handle.sourceFile);
    handle.program.getTypeChecker().getSymbolAtLocation(handle.sourceFile);
    const entryCheckerMs = performance.now() - checkerStarted;

    const all = handle.program.getSourceFiles();
    profiles.push({
      relPath,
      closureMs: entryClosureMs,
      createProgramMs: entryCreateMs,
      checkerMs: entryCheckerMs,
      rootFiles: handle.rootFiles.length,
      programFilesProject: all.filter((f) => f.fileName.startsWith(FIXTURE_ROOT)).length,
      programFilesTotal: all.length,
    });
  }

  const totalMs = performance.now() - runStarted;

  const closure = summarize(profiles.map((p) => p.closureMs));
  const create = summarize(profiles.map((p) => p.createProgramMs));
  const checker = summarize(profiles.map((p) => p.checkerMs));
  const roots = summarize(profiles.map((p) => p.rootFiles));
  const included = summarize(profiles.map((p) => p.programFilesProject));

  console.log(
    JSON.stringify(
      {
        entriesResolved: profiles.length,
        programBuilds: buildCalls,
        distinctEntries: new Set(profiles.map((p) => p.relPath)).size,
        totalWallMs: Math.round(totalMs),
        filesPerSec: +(profiles.length / (totalMs / 1000)).toFixed(2),
        phaseMs: {
          closureWalk: Math.round(closure.sum),
          createProgram: Math.round(create.sum),
          firstCheckerQuery: Math.round(checker.sum),
          unattributed: Math.round(totalMs - closure.sum - create.sum - checker.sum),
        },
        perEntryMs: {
          closureWalk: { p50: +closure.p50.toFixed(2), p95: +closure.p95.toFixed(2) },
          createProgram: { p50: +create.p50.toFixed(2), p95: +create.p95.toFixed(2), max: +create.max.toFixed(2) },
        },
        rootFilesHandedToCreateProgram: { p50: roots.p50, p95: roots.p95, max: roots.max },
        projectFilesActuallyInProgram: { p50: included.p50, p95: included.p95, max: included.max },
        parseCache: {
          projectSources: cache.parsedProjectFileCount,
          dependencySources: cache.parsedDependencyFileCount,
        },
        rssMb: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
      },
      null,
      2,
    ),
  );
}

const args = parseShapeArgs(process.argv.slice(2), DEFAULT_SHAPE);
profile(args.shape, args.entryLimit);
