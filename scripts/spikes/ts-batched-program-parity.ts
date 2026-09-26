/**
 * Whole vs closure-batched `ts.Program` resolution parity on a real corpus,
 * and the batched path's heap peak (bd tea-rags-mcp-vtuu4).
 *
 * ## What it measures
 *
 * The batch design claims a Program over a root's full forward closure, plus
 * the prelude, types every call site the way the whole project's Program does.
 * This harness checks that claim on taxdome through the PRODUCTION path. It
 * builds a `TSCallResolver` with the env-derived budgets, primes it with
 * `prepareResolvePass`, visits files in `planResolveVisits` order, acquires
 * each file's Program through `programCache.acquire`, and ends each group
 * with `endResolveVisitGroup`. For every call and new expression in every
 * visited file it asks the checker for the resolved declaration, so the
 * checker carries pass-2's real load. It keeps the answers for a
 * deterministic sample of at least `--sample-calls` call sites.
 *
 * A second isolate builds ONE `ts.createProgram` over the same root union,
 * with the compiler options the batches used, and answers the same question
 * for the sample. The parent compares the two answers call site by call site.
 *
 * ## Isolation
 *
 * Each phase runs in its own worker thread with production-shaped
 * `resourceLimits`: a 16 MB stack, and an old-generation ceiling of
 * `--batched-heap-mb` (default 2304 — the 2 GB target with headroom) for the
 * batched phase and `--whole-heap-mb` (default 12288) for the whole
 * reference. Completing under the batched ceiling bounds the peak from above.
 * The report also carries the sampled `heapUsed` maximum and the live heap
 * after a forced GC at each group end.
 *
 *   env -u NODE_OPTIONS npx tsx scripts/spikes/ts-batched-program-parity.ts \
 *     [--repo /Users/artk0re/Dev/Job/taxdome] [--sample-calls 4000] \
 *     [--batched-heap-mb 2304] [--whole-heap-mb 12288] [--out DIR]
 *
 * Run it with `env -u NODE_OPTIONS`: a process-wide `--max_old_space_size`
 * OVERRIDES per-worker `resourceLimits`, so the ceiling would not be there.
 * No index, no DuckDB, no Qdrant: this is an offline re-resolution.
 */

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";

import ts from "typescript";

import {
  loadTsConfig,
  loadTsConfigFileNames,
} from "../../src/core/domains/language/typescript/resolver/ts-config-loader.js";
import { readHeapSizeLimitMb } from "../../src/core/domains/language/typescript/resolver/ts-program-heap-admission.js";
import { TSCallResolver } from "../../src/core/domains/language/typescript/resolver/ts-resolver.js";

type Phase = "batched" | "whole";

/** `file:pos` of each sampled call site's declaration, keyed `relPath` → call `pos`. */
type SampleDeclarations = Record<string, Record<number, string>>;

interface PhaseInput {
  readonly phase: Phase;
  readonly repoRoot: string;
  /** The corpus with pass-1-style call counts, counted in the parent so the measured isolate holds none of it. */
  readonly corpus: readonly (readonly [string, number])[];
  /** Files whose call-site answers are kept. The batched phase adds the oversize roots. */
  readonly sampleRelPaths: readonly string[];
  /** Whole phase only: the options the batch Programs used. */
  readonly compilerOptions?: ts.CompilerOptions;
}

interface BatchedResult {
  readonly sample: SampleDeclarations;
  readonly compilerOptions: ts.CompilerOptions;
  readonly corpusFiles: number;
  readonly corpusCallSites: number;
  readonly visitedFiles: number;
  readonly resolvedCallSites: number;
  readonly groups: number;
  readonly heapSizeLimitMb: number;
  readonly peakHeapUsedMb: number;
  readonly maxLiveAfterGroupMb: number;
  readonly elapsedMs: number;
  readonly diagnostics: Record<string, unknown> | undefined;
}

interface WholeResult {
  readonly sample: SampleDeclarations;
  readonly programFiles: number;
  readonly heapSizeLimitMb: number;
  readonly peakHeapUsedMb: number;
  readonly elapsedMs: number;
}

const MB = 1024 * 1024;
const TS_SOURCE = /\.(?:ts|tsx|mts|cts)$/;

function argOf(argv: readonly string[], name: string, fallback: string): string {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : fallback;
}

/** Tracked TypeScript sources of `repoRoot`, repo-relative and sorted. */
function corpusOf(repoRoot: string): string[] {
  return execSync("git ls-files", { cwd: repoRoot, maxBuffer: 1 << 28 })
    .toString()
    .split("\n")
    .filter((relPath) => TS_SOURCE.test(relPath) && !relPath.includes("node_modules/"))
    .filter((relPath) => !relPath.startsWith(".claude/worktrees/"))
    .sort();
}

/** Call and new expressions in `sourceFile`, in visit order. */
function callSitesIn(sourceFile: ts.SourceFile): ts.CallLikeExpression[] {
  const out: ts.CallLikeExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

/** Where `call` resolves: its signature's declaration, else the callee symbol's first declaration. */
function declarationKeyOf(checker: ts.TypeChecker, call: ts.CallLikeExpression, repoRoot: string): string {
  try {
    let declaration: ts.Node | undefined = checker.getResolvedSignature(call)?.declaration;
    if (declaration === undefined && (ts.isCallExpression(call) || ts.isNewExpression(call))) {
      const callee = ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression;
      let symbol = checker.getSymbolAtLocation(callee);
      if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
        symbol = checker.getAliasedSymbol(symbol);
      }
      declaration = symbol?.declarations?.[0];
    }
    if (declaration === undefined) return "-";
    const { fileName } = declaration.getSourceFile();
    const shown = fileName.startsWith(`${repoRoot}/`) ? relative(repoRoot, fileName) : basename(fileName);
    return `${shown}:${declaration.pos}`;
  } catch {
    return "ERR";
  }
}

/** A `gc()` usable in this isolate, exposed without a process flag. */
function exposedGc(): () => void {
  setFlagsFromString("--expose-gc");
  return runInNewContext("gc") as () => void;
}

/**
 * Sample files by stride over the sorted corpus until the sample holds at
 * least `sampleCalls` call sites. Only files that have calls are sampled.
 */
function sampleFiles(counts: ReadonlyMap<string, number>, sampleCalls: number): Set<string> {
  const withCalls = [...counts].filter(([, calls]) => calls > 0);
  const total = withCalls.reduce((sum, [, calls]) => sum + calls, 0);
  const averageCalls = total / Math.max(1, withCalls.length);
  // Aim a quarter over the target, so the stride alone usually clears it.
  const wantedFiles = Math.ceil((sampleCalls * 1.25) / Math.max(1, averageCalls));
  const stride = Math.max(1, Math.floor(withCalls.length / Math.max(1, wantedFiles)));
  const sample = new Set<string>();
  let taken = 0;
  withCalls.forEach(([relPath, calls], index) => {
    if (index % stride !== 0) return;
    sample.add(relPath);
    taken += calls;
  });
  for (const [relPath, calls] of withCalls) {
    if (taken >= sampleCalls) break;
    if (sample.has(relPath)) continue;
    sample.add(relPath);
    taken += calls;
  }
  return sample;
}

function runBatched(input: PhaseInput): BatchedResult {
  const startedAt = Date.now();
  const gc = exposedGc();
  const { repoRoot } = input;
  const counts = new Map(input.corpus);
  const corpus = [...counts.keys()];
  const corpusCallSites = [...counts.values()].reduce((sum, calls) => sum + calls, 0);
  const sample = new Set(input.sampleRelPaths);
  const stage = (name: string): void => {
    gc();
    process.stderr.write(
      `${JSON.stringify({ stage: name, liveMb: Math.round(process.memoryUsage().heapUsed / MB), elapsedMs: Date.now() - startedAt })}\n`,
    );
  };
  stage("started");

  const resolver = new TSCallResolver(loadTsConfig(repoRoot), undefined, repoRoot);
  const cache = resolver.programCache;
  if (cache === null) throw new Error("CODEGRAPH_TS_TYPECHECKER is off — nothing to measure");
  // Plans the batches and builds the first one, as pass-2's prepare does.
  resolver.prepareResolvePass({
    expectedFileCount: corpus.length,
    expectedRelPaths: corpus,
    expectedCallSites: new Map([...counts].filter(([, calls]) => calls > 0)),
    projectRoot: repoRoot,
  });
  stage("primed");
  const groups = resolver.planResolveVisits();
  if (groups === undefined) throw new Error(`no batch plan: ${JSON.stringify(cache.diagnostics())}`);
  // Every oversize root joins the sample: they are the units most likely to differ.
  const batchCount = Number(cache.diagnostics().batches);
  for (const group of groups.slice(batchCount)) for (const relPath of group) sample.add(relPath);

  const declarations: SampleDeclarations = {};
  let compilerOptions: ts.CompilerOptions | undefined;
  let peakHeapUsed = 0;
  let maxLiveAfterGroup = 0;
  let visitedFiles = 0;
  let resolvedCallSites = 0;
  let groupIndex = 0;
  process.stderr.write(
    `${JSON.stringify({ planned: cache.diagnostics(), heapSizeLimitMb: readHeapSizeLimitMb(), elapsedMs: Date.now() - startedAt })}\n`,
  );
  for (const group of groups) {
    for (const relPath of group) {
      const handle = cache.acquire(relPath);
      visitedFiles += 1;
      if (handle === null) continue;
      compilerOptions ??= handle.program.getCompilerOptions();
      const keep = sample.has(relPath);
      const byCall: Record<number, string> = {};
      for (const call of callSitesIn(handle.sourceFile)) {
        const key = declarationKeyOf(handle.checker, call, repoRoot);
        if (keep) byCall[call.pos] = key;
        resolvedCallSites += 1;
      }
      if (keep) declarations[relPath] = byCall;
      peakHeapUsed = Math.max(peakHeapUsed, process.memoryUsage().heapUsed);
    }
    // Measured with the group's Program still alive: its live set is the peak.
    gc();
    const liveBytes = process.memoryUsage().heapUsed;
    maxLiveAfterGroup = Math.max(maxLiveAfterGroup, liveBytes);
    const diagnostics = cache.diagnostics();
    process.stderr.write(
      `${JSON.stringify({
        group: groupIndex,
        files: group.length,
        liveMb: Math.round(liveBytes / MB),
        peakHeapUsedMb: Math.round(peakHeapUsed / MB),
        programFiles: diagnostics.wholeProgramFiles,
        parsedTextMb: Math.round(Number(diagnostics.parsedSourceTextBytes) / MB),
        elapsedMs: Date.now() - startedAt,
      })}\n`,
    );
    groupIndex += 1;
    resolver.endResolveVisitGroup();
  }
  if (compilerOptions === undefined) throw new Error("no Program was ever served");

  return {
    sample: declarations,
    compilerOptions,
    corpusFiles: corpus.length,
    corpusCallSites,
    visitedFiles,
    resolvedCallSites,
    groups: groups.length,
    heapSizeLimitMb: readHeapSizeLimitMb(),
    peakHeapUsedMb: Math.round(peakHeapUsed / MB),
    maxLiveAfterGroupMb: Math.round(maxLiveAfterGroup / MB),
    elapsedMs: Date.now() - startedAt,
    diagnostics: resolver.diagnostics(),
  };
}

function runWhole(input: PhaseInput): WholeResult {
  const startedAt = Date.now();
  const { repoRoot, sampleRelPaths } = input;
  const roots = new Set<string>(loadTsConfigFileNames(repoRoot));
  for (const [relPath] of input.corpus) roots.add(join(repoRoot, relPath));
  const program = ts.createProgram({ rootNames: [...roots], options: input.compilerOptions ?? {} });
  const checker = program.getTypeChecker();
  const sample: SampleDeclarations = {};
  let peakHeapUsed = 0;
  for (const relPath of sampleRelPaths) {
    const sourceFile = program.getSourceFile(join(repoRoot, relPath));
    if (sourceFile === undefined) continue;
    const byCall: Record<number, string> = {};
    for (const call of callSitesIn(sourceFile)) byCall[call.pos] = declarationKeyOf(checker, call, repoRoot);
    sample[relPath] = byCall;
    peakHeapUsed = Math.max(peakHeapUsed, process.memoryUsage().heapUsed);
  }
  return {
    sample,
    programFiles: program.getSourceFiles().length,
    heapSizeLimitMb: readHeapSizeLimitMb(),
    peakHeapUsedMb: Math.round(peakHeapUsed / MB),
    elapsedMs: Date.now() - startedAt,
  };
}

/** Run one phase in a worker with production-shaped limits; resolve its result. */
async function runPhase<T>(input: PhaseInput, heapMb: number): Promise<T> {
  const entry = new URL(import.meta.url).href;
  // A worker has a fresh module registry, so tsx is registered again inside it
  // before the TypeScript entry is imported.
  const boot = `(async () => { const { register } = await import("tsx/esm/api"); register(); await import(${JSON.stringify(entry)}); })();`;
  return new Promise<T>((resolve, reject) => {
    const worker = new Worker(boot, {
      eval: true,
      workerData: input,
      resourceLimits: { maxOldGenerationSizeMb: heapMb, stackSizeMb: 16 },
    });
    worker.once("message", (result: T) => {
      resolve(result);
    });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      if (code !== 0) reject(new Error(`${input.phase} phase exited with code ${code}`));
    });
  });
}

function uptime(): string {
  return execSync("uptime").toString().trim();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repoRoot = argOf(argv, "--repo", "/Users/artk0re/Dev/Job/taxdome");
  const sampleCalls = Number(argOf(argv, "--sample-calls", "4000"));
  const batchedHeapMb = Number(argOf(argv, "--batched-heap-mb", "2304"));
  const wholeHeapMb = Number(argOf(argv, "--whole-heap-mb", "12288"));
  const outDir = argOf(argv, "--out", join(process.cwd(), ".tmp", "ts-batched-program-parity"));
  mkdirSync(outDir, { recursive: true });

  // Counted here, in the unmeasured parent: the batched isolate must hold
  // nothing but what production's pass-2 worker holds.
  const counts = new Map<string, number>();
  for (const relPath of corpusOf(repoRoot)) {
    const text = readFileSync(join(repoRoot, relPath), "utf8");
    counts.set(relPath, callSitesIn(ts.createSourceFile(relPath, text, ts.ScriptTarget.ES2022, false)).length);
  }
  const corpus = [...counts];
  const sampled = [...sampleFiles(counts, sampleCalls)];
  console.error(JSON.stringify({ stage: "counted", corpusFiles: corpus.length, sampledFiles: sampled.length }));

  const batchedUptime = uptime();
  const batched = await runPhase<BatchedResult>(
    { phase: "batched", repoRoot, corpus, sampleRelPaths: sampled },
    batchedHeapMb,
  );
  const wholeUptime = uptime();
  const whole = await runPhase<WholeResult>(
    {
      phase: "whole",
      repoRoot,
      corpus,
      sampleRelPaths: Object.keys(batched.sample),
      compilerOptions: batched.compilerOptions,
    },
    wholeHeapMb,
  );

  let compared = 0;
  let matched = 0;
  const mismatchKinds = new Map<string, number>();
  const mismatchExamples: string[] = [];
  for (const [relPath, byCall] of Object.entries(batched.sample)) {
    const reference = whole.sample[relPath] ?? {};
    for (const [pos, key] of Object.entries(byCall)) {
      compared += 1;
      const expected = reference[Number(pos)];
      if (expected === key) {
        matched += 1;
        continue;
      }
      const kind = key === "-" ? "batchedUnresolved" : expected === "-" ? "wholeUnresolved" : "different";
      mismatchKinds.set(kind, (mismatchKinds.get(kind) ?? 0) + 1);
      if (mismatchExamples.length < 25) mismatchExamples.push(`${relPath}@${pos}: whole=${expected} batched=${key}`);
    }
  }

  const report = {
    repoRoot,
    batched: {
      uptime: batchedUptime,
      heapCeilingMb: batchedHeapMb,
      corpusFiles: batched.corpusFiles,
      corpusCallSites: batched.corpusCallSites,
      visitedFiles: batched.visitedFiles,
      resolvedCallSites: batched.resolvedCallSites,
      groups: batched.groups,
      peakHeapUsedMb: batched.peakHeapUsedMb,
      maxLiveAfterGroupMb: batched.maxLiveAfterGroupMb,
      elapsedMs: batched.elapsedMs,
      diagnostics: batched.diagnostics,
    },
    whole: {
      uptime: wholeUptime,
      heapCeilingMb: wholeHeapMb,
      programFiles: whole.programFiles,
      peakHeapUsedMb: whole.peakHeapUsedMb,
      elapsedMs: whole.elapsedMs,
    },
    parity: {
      sampledFiles: Object.keys(batched.sample).length,
      comparedCallSites: compared,
      matchedCallSites: matched,
      parityPct: compared === 0 ? 0 : Math.round((matched / compared) * 100_000) / 1000,
      mismatchKinds: Object.fromEntries(mismatchKinds),
      mismatchExamples,
    },
    finishedUptime: uptime(),
  };
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}

if (isMainThread) {
  await main();
} else {
  const input = workerData as PhaseInput;
  const result = input.phase === "batched" ? runBatched(input) : runWhole(input);
  parentPort?.postMessage(result);
}
