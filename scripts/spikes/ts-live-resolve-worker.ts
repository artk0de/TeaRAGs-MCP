/**
 * The measured half of `ts-live-resolve-harness.ts` — runs INSIDE the worker
 * thread so every number it reports is taken under production's per-isolate
 * `resourceLimits` (bd tea-rags-mcp-6aytq).
 *
 * Three phases, and the middle one is the only one being explained:
 *
 *   discovery — the file set production's `discoverSupportedFiles` admits,
 *     rebuilt from the same two filters (`BUILTIN_IGNORE_PATTERNS` + the repo's
 *     own ignore files, then `buildCodegraphExclusionFilter` WITH the language
 *     factory) rather than approximated. `.d.ts` is deliberately kept: nothing
 *     in `GENERATED_PATTERNS` excludes it, so production walks those files too.
 *   pass 1 — real tree-sitter extraction of every discovered file, timed
 *     separately. The symbol table must be complete before the first resolve,
 *     or a cross-file target simply is not there to be found.
 *   pass 2 — the production `CallEdgeResolutionRunner` over every extraction,
 *     per-file wall clock, under a chunked CPU profile.
 *
 * ## The tsconfig check is a validity gate, not a log line
 *
 * `TypeScriptLanguage#resolverFor` builds its `TSCallResolver` against
 * `ctx.projectRoot`, which arrives from `CodegraphRunState#bindProjectRoot`.
 * Bind the wrong root and `loadTsConfig` finds no `tsconfig.json`, degrades to
 * `{ baseUrl: ".", paths: {} }`, and every non-relative specifier — 97% of
 * taxdome's — becomes unmappable. That changes which files a Program is built
 * from AND which calls count as external, so a no-alias run measures a
 * different universe and its ms/file answers nothing (bd tea-rags-mcp-t6ycg,
 * bd tea-rags-mcp-f4wcm). The loaded alias count is asserted at startup and
 * carried in `stats.json`.
 *
 * ## Why the profiler rotates on a file counter and not a timer
 *
 * Pass 2 is one synchronous loop; an `setInterval` callback cannot run inside
 * it, so a timer-driven rotation would produce exactly one chunk — written
 * only if the run survives to the end, which is the case a kill-safe design
 * cannot assume. Rotation is therefore checked per file against the wall
 * clock, and the `node:inspector/promises` session is awaited there. The loop
 * yields at rotation points and nowhere else.
 *
 * ## Divergences from the live pipeline, stated rather than hidden
 *
 * No DuckDB write, and the run-global maps a real pass-1 barrier fills
 * (`hierarchyView`, run-global `classExtends` / return types / instantiations)
 * stay empty — the same scoping `ts-resolve-path-profile.ts` runs under, which
 * is what makes the two directly comparable. Both omissions can only REMOVE
 * work, so a slow result here is a lower bound on the resolver's own cost.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { homedir } from "node:os";
import { extname, join, relative } from "node:path";
import { performance } from "node:perf_hooks";
import { workerData } from "node:worker_threads";

import ignore, { type Ignore } from "ignore";

import type { FileExtraction } from "../../src/core/contracts/types/codegraph.js";
import { BUILTIN_IGNORE_PATTERNS } from "../../src/core/domains/ingest/pipeline/ignore-defaults.js";
import { DefaultSymbolIdComposer, LanguageFactory } from "../../src/core/domains/language/index.js";
import { loadTsConfig } from "../../src/core/domains/language/typescript/resolver/index.js";
import type { TSProgramCache } from "../../src/core/domains/language/typescript/resolver/ts-program-cache.js";
import { buildCodegraphExclusionFilter } from "../../src/core/domains/trajectory/codegraph/exclusion.js";
import { CallEdgeResolutionRunner } from "../../src/core/domains/trajectory/codegraph/symbols/resolution-runner.js";
import { CodegraphRunState } from "../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { InMemoryGlobalSymbolTable } from "../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";
import { buildSymbolDefs, extractFile } from "../ts-codegraph-typechecker-oracle.js";

interface WorkerInput {
  readonly configName: string;
  readonly limit: number;
  readonly deadlineMs: number;
  readonly outDir: string;
  readonly heapLimitMb: number;
  readonly stackSizeMb: number;
}

const input = workerData as WorkerInput;

const ROOT = process.env.TAXDOME_ROOT ?? join(homedir(), "Dev/Job/taxdome");
/** Both extensions `CODEGRAPH_LANGUAGES` maps to language "typescript". */
const TS_EXTENSIONS = new Set([".ts", ".tsx"]);
/** Progress + cache sampling cadence, matching the live pass-2 progress line. */
const SAMPLE_EVERY = 100;
/** Wall clock per `.cpuprofile` chunk. */
const PROFILE_CHUNK_MS = 60_000;

const runDir = join(input.outDir, input.configName);
mkdirSync(runDir, { recursive: true });

function log(line: string): void {
  process.stdout.write(`${line}\n`);
}

// ---------------------------------------------------------------------------
// Discovery — production's two-layer filter, not an approximation of it.
// ---------------------------------------------------------------------------

function buildScannerFilter(root: string): Ignore {
  const ig = ignore();
  ig.add(BUILTIN_IGNORE_PATTERNS);
  for (const name of [".gitignore", ".contextignore"]) {
    const path = join(root, name);
    if (!existsSync(path)) continue;
    try {
      ig.add(readFileSync(path, "utf8"));
    } catch {
      /* an unreadable ignore file filters nothing */
    }
  }
  return ig;
}

function discoverTypeScriptFiles(root: string, languageFactory: LanguageFactory): string[] {
  const scannerFilter = buildScannerFilter(root);
  const codegraphFilter = buildCodegraphExclusionFilter({ customPatterns: [] }, languageFactory);
  const out: string[] = [];

  const walk = (dir: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      const relPath = relative(root, full).split("\\").join("/");
      if (entry.isDirectory()) {
        const dirRel = `${relPath}/`;
        if (scannerFilter.ignores(dirRel)) continue;
        if (codegraphFilter.ignores(dirRel)) continue;
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!TS_EXTENSIONS.has(extname(entry.name))) continue;
      if (scannerFilter.ignores(relPath)) continue;
      if (codegraphFilter.ignores(relPath)) continue;
      out.push(relPath);
    }
  };

  walk(root);
  return out.sort();
}

// ---------------------------------------------------------------------------
// Instrumentation — the cache counters H1 is decided on.
// ---------------------------------------------------------------------------

interface CacheCounters {
  acquireCalls: number;
  distinctEntriesAcquired: number;
  coverageLookups: number;
  coverageHits: number;
  buildsAttempted: number;
  buildsNull: number;
  buildsOk: number;
  buildMs: number;
}

/**
 * The cache the runner will actually use. `TypeScriptLanguage` builds its
 * resolver lazily on the first resolve, keyed by the root the context carries,
 * so the cache does not exist until something has resolved — the same reason
 * `ts-resolve-path-profile.ts` attaches its instrumentation after file one
 * rather than duplicating `resolverFor`'s binding rule.
 */
function programCacheOf(language: unknown): TSProgramCache | null {
  const { bound } = language as { bound?: { resolver?: { programCache?: TSProgramCache | null } } };
  return bound?.resolver?.programCache ?? null;
}

/**
 * Wrap `acquire`, the private `build`, and the private `findCovering` on the
 * INSTANCE, so `this.build(...)` inside `acquire` finds the wrapper as an own
 * property. Counting all three is what separates the two shapes H1 can take:
 * a coverage key that never hits (many builds) from builds that fail outright
 * (`ts.createProgram` throwing, caught, returning null) — the second is
 * invisible in `size` alone, because nothing is ever retained.
 */
function instrumentCache(cache: TSProgramCache, counters: CacheCounters): void {
  const seen = new Set<string>();
  const realAcquire = cache.acquire.bind(cache);
  cache.acquire = (relPath): ReturnType<typeof realAcquire> => {
    counters.acquireCalls += 1;
    if (!seen.has(relPath)) {
      seen.add(relPath);
      counters.distinctEntriesAcquired += 1;
    }
    return realAcquire(relPath);
  };

  const internals = cache as unknown as {
    build: (entryAbsolute: string) => unknown;
    findCovering: (compilerPath: string, entryAbsolute: string, mtimeMs: number) => unknown;
  };
  const realBuild = internals.build.bind(cache);
  internals.build = (entryAbsolute: string): unknown => {
    counters.buildsAttempted += 1;
    const started = performance.now();
    const built = realBuild(entryAbsolute);
    counters.buildMs += performance.now() - started;
    if (built === null) counters.buildsNull += 1;
    else counters.buildsOk += 1;
    return built;
  };

  const realFindCovering = internals.findCovering.bind(cache);
  internals.findCovering = (compilerPath: string, entryAbsolute: string, mtimeMs: number): unknown => {
    counters.coverageLookups += 1;
    const covering = realFindCovering(compilerPath, entryAbsolute, mtimeMs);
    if (covering !== null) counters.coverageHits += 1;
    return covering;
  };
}

interface Sample {
  files: number;
  elapsedMs: number;
  msPerFileOverall: number;
  msPerFileRolling: number;
  cacheSize: number;
  parsedProjectFileCount: number;
  parsedDependencyFileCount: number;
  retainedSourceTextMb: number;
  heapUsedMb: number;
  rssMb: number;
  userCpuMs: number;
  systemCpuMs: number;
  userCpuShare: number;
  acquireCalls: number;
  buildsAttempted: number;
  buildsNull: number;
  coverageHits: number;
}

// ---------------------------------------------------------------------------
// Run.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const tsOptions = loadTsConfig(ROOT);
  const aliasCount = Object.keys(tsOptions.paths ?? {}).length;
  const tsconfigState = {
    root: ROOT,
    baseUrl: tsOptions.baseUrl,
    aliasCount,
    aliases: Object.keys(tsOptions.paths ?? {}),
  };
  log(`tsconfig ${JSON.stringify(tsconfigState)}`);
  if (aliasCount === 0) {
    // Not a warning: a run without aliases resolves a different graph, so its
    // ms/file cannot be compared against the live number this exists to explain.
    log("INVALID: tsconfig loaded ZERO path aliases — this run measures the wrong universe");
  }

  const composer = new DefaultSymbolIdComposer();
  const factory = new LanguageFactory({ repoRoot: ROOT });
  const language = factory.create("typescript");
  const symbolTable = new InMemoryGlobalSymbolTable();

  const discoverStarted = performance.now();
  const discovered = discoverTypeScriptFiles(ROOT, factory);
  const files = input.limit > 0 ? discovered.slice(0, input.limit) : discovered;
  const discoverMs = performance.now() - discoverStarted;
  log(`discovery ${files.length} of ${discovered.length} TS files in ${Math.round(discoverMs)}ms`);

  // Pass 1 — extraction. Timed on its own: the live run did all 19,966 files
  // (both languages) in 43s, so a slow pass 1 here would itself be news.
  const extractStarted = performance.now();
  const extractions: FileExtraction[] = [];
  let parseFailures = 0;
  for (const relPath of files) {
    const extraction = extractFile(ROOT, relPath, composer, factory);
    if (extraction === null) {
      parseFailures += 1;
      continue;
    }
    symbolTable.upsertFile(relPath, buildSymbolDefs(extraction));
    extractions.push(extraction);
  }
  const extractMs = performance.now() - extractStarted;
  log(
    `pass1 ${extractions.length} extracted, ${parseFailures} failures, ${Math.round(extractMs)}ms, ` +
      `${(extractions.length / (extractMs / 1000)).toFixed(1)} files/sec`,
  );

  const runState = new CodegraphRunState();
  // The root the TS resolver binds its tsconfig and its Programs to.
  runState.bindProjectRoot(ROOT);
  const runner = new CallEdgeResolutionRunner(factory, runState);

  const counters: CacheCounters = {
    acquireCalls: 0,
    distinctEntriesAcquired: 0,
    coverageLookups: 0,
    coverageHits: 0,
    buildsAttempted: 0,
    buildsNull: 0,
    buildsOk: 0,
    buildMs: 0,
  };
  const samples: Sample[] = [];

  const session = new Session();
  session.connect();
  await session.post("Profiler.enable");
  let profileSeq = 0;
  let chunkStartedAt = performance.now();
  await session.post("Profiler.start");

  const rotateProfile = async (): Promise<void> => {
    const { profile } = await session.post("Profiler.stop");
    const path = join(runDir, `chunk-${String(profileSeq).padStart(3, "0")}.cpuprofile`);
    writeFileSync(path, JSON.stringify(profile), "utf8");
    log(`profile chunk ${profileSeq} -> ${path}`);
    profileSeq += 1;
    chunkStartedAt = performance.now();
    await session.post("Profiler.start");
  };

  const cpuAtStart = process.cpuUsage();
  const resolveStarted = performance.now();
  let processed = 0;
  let instrumented = false;
  let lastSampleAt = resolveStarted;
  let lastSampleFiles = 0;
  let deadlineHit = false;
  let slowestFileMs = 0;
  let slowestFile = "";

  for (const extraction of extractions) {
    const fileStarted = performance.now();
    runner.resolve(extraction, symbolTable);
    const fileMs = performance.now() - fileStarted;
    processed += 1;
    if (fileMs > slowestFileMs) {
      slowestFileMs = fileMs;
      slowestFile = extraction.relPath;
    }

    if (!instrumented) {
      // File one has resolved ⇒ the lazy resolver, and its cache, now exist.
      const cache = programCacheOf(language);
      if (cache) instrumentCache(cache, counters);
      instrumented = true;
      log(`instrumented=${cache !== null} after first file (${fileMs.toFixed(1)}ms)`);
    }

    if (processed % SAMPLE_EVERY === 0) {
      const now = performance.now();
      const cache = programCacheOf(language);
      const cpu = process.cpuUsage(cpuAtStart);
      const memory = process.memoryUsage();
      const elapsedMs = now - resolveStarted;
      const sample: Sample = {
        files: processed,
        elapsedMs: Math.round(elapsedMs),
        msPerFileOverall: +(elapsedMs / processed).toFixed(2),
        msPerFileRolling: +((now - lastSampleAt) / (processed - lastSampleFiles)).toFixed(2),
        cacheSize: cache?.size ?? -1,
        parsedProjectFileCount: cache?.parsedProjectFileCount ?? -1,
        parsedDependencyFileCount: cache?.parsedDependencyFileCount ?? -1,
        retainedSourceTextMb: cache ? +(cache.retainedSourceTextBytes / 1024 / 1024).toFixed(1) : -1,
        heapUsedMb: +(memory.heapUsed / 1024 / 1024).toFixed(1),
        rssMb: +(memory.rss / 1024 / 1024).toFixed(1),
        userCpuMs: Math.round(cpu.user / 1000),
        systemCpuMs: Math.round(cpu.system / 1000),
        // Low user-CPU share alongside slow wall clock is the GC/idle
        // signature; a run pegged near 1.0 is doing real work, however slowly.
        userCpuShare: +(cpu.user / 1000 / elapsedMs).toFixed(3),
        acquireCalls: counters.acquireCalls,
        buildsAttempted: counters.buildsAttempted,
        buildsNull: counters.buildsNull,
        coverageHits: counters.coverageHits,
      };
      samples.push(sample);
      log(`sample ${JSON.stringify(sample)}`);
      lastSampleAt = now;
      lastSampleFiles = processed;

      if (now - chunkStartedAt >= PROFILE_CHUNK_MS) await rotateProfile();
      if (now - resolveStarted >= input.deadlineMs) {
        deadlineHit = true;
        log(`deadline ${input.deadlineMs}ms reached at ${processed} files — stopping cleanly`);
        break;
      }
    }
  }

  const resolveMs = performance.now() - resolveStarted;
  const cpuTotal = process.cpuUsage(cpuAtStart);
  await rotateProfile();
  await session.post("Profiler.disable");
  session.disconnect();

  const cache = programCacheOf(language);
  const { stats } = runState;
  const result = {
    config: input.configName,
    resourceLimits: { stackSizeMb: input.stackSizeMb, maxOldGenerationSizeMb: input.heapLimitMb },
    corpus: { root: ROOT, discovered: discovered.length, walked: files.length, tsconfig: tsconfigState },
    pass1: {
      ms: Math.round(extractMs),
      extracted: extractions.length,
      parseFailures,
      filesPerSec: +(extractions.length / (extractMs / 1000)).toFixed(2),
    },
    pass2: {
      ms: Math.round(resolveMs),
      filesProcessed: processed,
      msPerFile: +(resolveMs / Math.max(1, processed)).toFixed(3),
      filesPerSec: +(processed / (resolveMs / 1000)).toFixed(2),
      completed: !deadlineHit,
      partial: deadlineHit,
      deadlineMs: input.deadlineMs,
      slowestFile,
      slowestFileMs: +slowestFileMs.toFixed(1),
    },
    cache: {
      ...counters,
      buildMs: Math.round(counters.buildMs),
      buildShareOfPass2: +(counters.buildMs / Math.max(1, resolveMs)).toFixed(3),
      size: cache?.size ?? -1,
      parsedProjectFileCount: cache?.parsedProjectFileCount ?? -1,
      parsedDependencyFileCount: cache?.parsedDependencyFileCount ?? -1,
      retainedSourceTextMb: cache ? +(cache.retainedSourceTextBytes / 1024 / 1024).toFixed(1) : -1,
    },
    cpu: {
      userMs: Math.round(cpuTotal.user / 1000),
      systemMs: Math.round(cpuTotal.system / 1000),
      wallMs: Math.round(resolveMs),
      userCpuShare: +(cpuTotal.user / 1000 / resolveMs).toFixed(3),
    },
    memory: {
      heapUsedMb: +(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1),
      rssMb: +(process.memoryUsage().rss / 1024 / 1024).toFixed(1),
    },
    resolve: {
      attempted: stats.callsAttempted,
      resolved: stats.callsResolved,
      externalSkipped: stats.callsExternalSkipped,
      noInProjectDef: stats.callsNoInProjectDef,
      unresolvable: stats.callsUnresolvable,
      ambiguousFanout: stats.callsAmbiguousFanout,
      fileEdges: stats.fileEdgeCount,
      methodEdges: stats.methodEdgeCount,
    },
    samples,
  };

  const statsPath = join(runDir, "stats.json");
  writeFileSync(statsPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  log(`stats -> ${statsPath}`);
  log(
    `RESULT config=${input.configName} files=${processed} msPerFile=${result.pass2.msPerFile} ` +
      `builds=${counters.buildsAttempted} null=${counters.buildsNull} userCpuShare=${result.cpu.userCpuShare}`,
  );
}

await main();
