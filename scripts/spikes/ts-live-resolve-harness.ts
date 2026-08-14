/**
 * Offline re-resolution of taxdome's REAL TypeScript corpus, inside a worker
 * thread carrying production's `resourceLimits`, under a CPU profiler
 * (bd tea-rags-mcp-6aytq).
 *
 * ## What this exists to discriminate
 *
 * A live `--force-enrichments codegraph` run over taxdome spent ~1320-1380s of
 * its 1502s pass-2 on ~10,580 TypeScript files — ~125-130 ms/file. The SAME
 * production `CallEdgeResolutionRunner`, driven by
 * `ts-resolve-path-profile.ts` over a 19,005-file SYNTHETIC corpus, costs
 * 0.64 ms/file. That is a ~200x gap on the same code, and pass-1 extraction of
 * all 19,966 real files took 43s in the same live run, so parsing is not it.
 *
 * Three candidate explanations, and the harness is built so the numbers pick:
 *
 *   H1 real-graph cache collapse — taxdome's actual import topology defeats
 *      `TSProgramCache`'s coverage key, so the run pays `ts.createProgram` (or
 *      a caught `RangeError` returning null) far more often than the synthetic
 *      corpus does. Reproduces offline in BOTH configs.
 *   H2 heap-cap GC thrash — the Programs retained at real scale press against
 *      the enrichment worker's 2 GB `maxOldGenerationSizeMb`, and V8 spends the
 *      run collecting. Reproduces in config A, disappears in config B.
 *   H3 the resolver is innocent — both configs are fast, and the cost lives in
 *      something only the live pipeline wraps around the resolver.
 *
 * ## Why a worker thread and not just a process
 *
 * Production resolves inside a `worker_threads` worker whose `resourceLimits`
 * carry BOTH a 16 MB V8 stack (`ENRICHMENT_WORKER_STACK_SIZE_MB`, without
 * which `ts.createProgram`'s recursive module-resolution walk overflows on a
 * barrel-connected corpus) and a 2 GB old-generation ceiling
 * (`ENRICHMENT_WORKER_MEMORY_LIMIT_MB`). Both are per-ISOLATE, so measuring
 * them means spawning an isolate that has them — `ThreadTransport#spawn` is
 * mirrored here rather than described.
 *
 *   npx tsx --import tsx scripts/spikes/ts-live-resolve-harness.ts \
 *     [--config A|B|W] [--limit N] [--deadline-ms MS] [--out DIR] \
 *     [--heap-limit-mb MB] [--no-profile] [--env KEY=VALUE …]
 *
 * Config A is the production mirror; config B lifts the heap ceiling and
 * changes nothing else. Everything the run learns lands in `stats.json`,
 * `progress.log` and `chunk-*.cpuprofile` under `<out>/<config>/`.
 *
 * Run it with `env -u NODE_OPTIONS`, always. A process-wide
 * `--max_old_space_size` OVERRIDES per-worker `resourceLimits`, so a heap
 * question asked with it set measures a ceiling that is not there — the same
 * silent override `enrichment/infra/heap-ceiling-enforcement.ts` reports at
 * worker boot.
 */

import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

/** Production mirror, read off `pool-defaults.ts` at the time of writing. */
const PRODUCTION_STACK_SIZE_MB = 16;
const PRODUCTION_HEAP_LIMIT_MB = 2048;
/** Config B's ceiling. High enough that the run never reaches it. */
const UNCAPPED_HEAP_LIMIT_MB = 8192;

/**
 * Pass-2 stops here whether or not the corpus is exhausted. A verdict needs
 * ms/file, not a complete run: at the live rate 270s buys ~2,000 files, which
 * is already two orders of magnitude more signal than the gap being explained.
 */
const DEFAULT_DEADLINE_MS = 270_000;

const DEFAULT_OUT_DIR = "/Users/artk0re/.claude/jobs/ced710ff/tmp/ts-harness";

interface HarnessConfig {
  readonly name: string;
  readonly stackSizeMb: number;
  readonly maxOldGenerationSizeMb: number;
  /**
   * How pass 2 gets its Programs. `coverage` is production's per-entry build
   * with `findCovering` reuse; `whole` primes ONE `ts.createProgram` over every
   * discovered project file before the loop starts and expects every later
   * acquire to be served off it — see the worker's `primeWholeProgram`.
   */
  readonly strategy: "coverage" | "whole";
}

const CONFIGS: Readonly<Record<string, HarnessConfig>> = {
  A: {
    name: "A-production-mirror",
    stackSizeMb: PRODUCTION_STACK_SIZE_MB,
    maxOldGenerationSizeMb: PRODUCTION_HEAP_LIMIT_MB,
    strategy: "coverage",
  },
  B: {
    name: "B-heap-uncapped",
    stackSizeMb: PRODUCTION_STACK_SIZE_MB,
    maxOldGenerationSizeMb: UNCAPPED_HEAP_LIMIT_MB,
    strategy: "coverage",
  },
  W: {
    name: "W-whole-program",
    stackSizeMb: PRODUCTION_STACK_SIZE_MB,
    maxOldGenerationSizeMb: UNCAPPED_HEAP_LIMIT_MB,
    strategy: "whole",
  },
};

function readFlag(argv: readonly string[], flag: string): string | null {
  const index = argv.indexOf(flag);
  return index >= 0 ? (argv[index + 1] ?? null) : null;
}

/**
 * Every `--env KEY=VALUE`, applied to this process before the worker spawns —
 * `new Worker` copies `process.env` at spawn, so a knob set here is a knob the
 * measured code reads.
 *
 * A flag rather than a shell prefix so the run RECORDS its own configuration:
 * the budgets are the independent variable of this experiment, and a number
 * whose knob settings live only in somebody's shell history cannot be compared
 * against the next run's.
 */
function readEnvOverrides(argv: readonly string[]): Record<string, string> {
  const overrides: Record<string, string> = {};
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] !== "--env") continue;
    const pair = argv[index + 1] ?? "";
    const split = pair.indexOf("=");
    if (split <= 0) continue;
    overrides[pair.slice(0, split)] = pair.slice(split + 1);
  }
  return overrides;
}

const argv = process.argv.slice(2);
const configKey = (readFlag(argv, "--config") ?? "A").toUpperCase();
const config = CONFIGS[configKey];
if (config === undefined) {
  process.stderr.write(`unknown --config ${configKey}; expected one of ${Object.keys(CONFIGS).join(", ")}\n`);
  process.exit(2);
}

const limitRaw = readFlag(argv, "--limit");
const limit = limitRaw === null ? 0 : Number.parseInt(limitRaw, 10);
const deadlineRaw = readFlag(argv, "--deadline-ms");
const deadlineMs = deadlineRaw === null ? DEFAULT_DEADLINE_MS : Number.parseInt(deadlineRaw, 10);
const outDir = readFlag(argv, "--out") ?? DEFAULT_OUT_DIR;
const envOverrides = readEnvOverrides(argv);
for (const [key, value] of Object.entries(envOverrides)) process.env[key] = value;

/**
 * `--heap-limit-mb N` overrides the chosen config's declared ceiling, so a
 * floor search (2048 / 3072 / 4096 / 5120 …) does not need one CONFIGS row per
 * probe. The ceiling is the independent variable of every memory question this
 * harness is asked, and it is per-isolate — it can only be set at spawn.
 */
const heapLimitRaw = readFlag(argv, "--heap-limit-mb");
const maxOldGenerationSizeMb =
  heapLimitRaw === null ? config.maxOldGenerationSizeMb : Number.parseInt(heapLimitRaw, 10);
/**
 * `--no-profile` drops the CPU profiler. A profile is what the ORIGINAL
 * question needed (where does the time go); a memory acceptance run wants the
 * isolate holding the corpus and nothing else, since the profiler's own sample
 * buffer is heap the measurement did not ask for.
 */
const profile = !argv.includes("--no-profile");

/**
 * The plain-JS bootstrap, not the `.ts` worker — see its docblock: a worker
 * thread has no `tsx` loader, and `execArgv` will not give it one.
 */
const workerPath = fileURLToPath(new URL("./ts-live-resolve-worker-boot.js", import.meta.url));

process.stdout.write(
  `${JSON.stringify({
    harness: "ts-live-resolve",
    config: config.name,
    strategy: config.strategy,
    resourceLimits: { stackSizeMb: config.stackSizeMb, maxOldGenerationSizeMb },
    limit: limit > 0 ? limit : "all",
    deadlineMs,
    outDir,
    profile,
    env: envOverrides,
    parentNodeOptions: process.env.NODE_OPTIONS ?? null,
  })}\n`,
);

const worker = new Worker(workerPath, {
  workerData: {
    configName: config.name,
    strategy: config.strategy,
    limit,
    deadlineMs,
    outDir,
    heapLimitMb: maxOldGenerationSizeMb,
    stackSizeMb: config.stackSizeMb,
    profile,
    envOverrides,
  },
  resourceLimits: {
    stackSizeMb: config.stackSizeMb,
    maxOldGenerationSizeMb,
  },
});

worker.on("error", (error: Error) => {
  // A crash IS a result — a 16 MB stack overflowing on the real graph, or an
  // ERR_WORKER_OUT_OF_MEMORY under the 2 GB ceiling, are exactly the failures
  // the two configs exist to tell apart. Report the signature, do not swallow.
  process.stderr.write(`WORKER ERROR ${error.name}: ${error.message}\n${error.stack ?? ""}\n`);
  process.exitCode = 1;
});

worker.on("exit", (code: number) => {
  process.stdout.write(`worker exit code=${code}\n`);
  if (code !== 0) process.exitCode = code;
});
