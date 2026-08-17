/**
 * Offline acceptance for pass-1 extraction fan-out (bd pass1-fanout).
 *
 * Runs the SAME production path a `--force-enrichments codegraph` recompute
 * takes — real `WorkerPoolEnrichmentExecutor`, real enrichment worker entry,
 * real `createCodegraphEnrichmentProvider` rebuilt in-thread — over a real
 * multi-hundred-file corpus, once with the fan-out off and once with it on, and
 * reports the wall clock of the file-batch phase for each.
 *
 * What is real and what is not: everything from the executor down is
 * production code, including the DuckDB writes the absorb half performs. The
 * only substitution is the graph DB, which opens as a local file under a scratch
 * dir instead of through the daemon socket — the daemon serialises writes across
 * processes and is not part of what pass-1 measures. Pass-2 (`runFinalize`) is
 * deliberately NOT run: it is the resolve stage, unchanged by this work, and it
 * dwarfs and hides the number under test.
 *
 * Default corpus is this repository's own `src/` (≈900 TypeScript files), so the
 * script needs no fixture generation and no external checkout.
 *
 *   npm run build
 *   npx tsx scripts/spikes/pass1-fanout-profile.ts [--batch N] [--pool N] [--root DIR]
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import type { EnrichmentProvider, WorkerEnrichmentDescriptor } from "../../src/core/contracts/types/provider.js";
import { WorkerPoolEnrichmentExecutor } from "../../src/core/domains/ingest/pipeline/enrichment/executor/worker-pool.js";
import type { CodegraphWorkerConfig } from "../../src/core/domains/trajectory/codegraph/index.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const BUILD_ROOT = join(REPO_ROOT, "build");
const WORKER_PATH = join(BUILD_ROOT, "core/domains/ingest/pipeline/enrichment/infra/worker.js");
const PROVIDER_MODULE_PATH = join(BUILD_ROOT, "core/domains/trajectory/codegraph/factory.js");
const LANGUAGE_MODULE_PATH = join(BUILD_ROOT, "core/domains/language/index.js");
/**
 * The worker rebuilds itself from COMPILED modules, so the migrations barrel it
 * dynamic-imports has to be the compiled one too — importing the constant from
 * `src/` under tsx would hand the worker a path whose siblings do not exist.
 */
const MIGRATIONS_MODULE_URL = pathToFileURL(
  join(BUILD_ROOT, "core/domains/maintenance/migration/database/index.js"),
).href;

interface Args {
  batch: number;
  pool: number;
  root: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { batch: 120, pool: 4, root: REPO_ROOT };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--batch") args.batch = Number(argv[++i]);
    else if (argv[i] === "--pool") args.pool = Number(argv[++i]);
    else if (argv[i] === "--root") args.root = resolve(argv[++i]);
  }
  return args;
}

/** Every `.ts`/`.tsx` under `<root>/src`, repo-relative and sorted. */
function collectCorpus(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(relative(root, abs));
    }
  };
  walk(join(root, "src"));
  return out.sort();
}

function batched(paths: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < paths.length; i += size) out.push(paths.slice(i, i + size));
  return out;
}

/**
 * The provider handle the executor reads on the MAIN thread: only the descriptor
 * matters, since every method actually runs on a worker that rebuilds the real
 * provider from `providerModulePath`.
 */
function codegraphProviderHandle(dataDir: string, fanout: boolean): EnrichmentProvider {
  const config: CodegraphWorkerConfig = {
    languageModulePath: LANGUAGE_MODULE_PATH,
    migrationsModulePath: MIGRATIONS_MODULE_URL,
    rootDir: dataDir,
    customExcludePatterns: [],
  };
  const descriptor: WorkerEnrichmentDescriptor = {
    providerModulePath: PROVIDER_MODULE_PATH,
    providerFactoryExport: "createCodegraphEnrichmentProvider",
    dispatch: "collection-affinity",
    extractionFanout: fanout,
    serializableConfig: config,
  };
  return {
    key: "codegraph.symbols",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p: string) => p,
    buildFileSignals: async () => new Map(),
    buildChunkSignals: async () => new Map(),
    streamFileBatch: async () => new Map(),
    defersChunkEnrichment: true,
    workerDescriptor: descriptor,
  } as unknown as EnrichmentProvider;
}

interface ModeResult {
  mode: string;
  files: number;
  batches: number;
  wallMs: number;
}

/**
 * Build a provider on EVERY worker before the clock starts.
 *
 * The first dispatch a worker sees pays for the dynamic import of the whole
 * `domains/language` barrel and the tree-sitter native load — hundreds of ms,
 * once per thread. Serial mode touches one thread and fan-out touches all of
 * them, so leaving that cost inside the measured window would charge the fan-out
 * for start-up the real run amortises over tens of thousands of files.
 *
 * One tiny batch per throwaway collection: each pins to a different thread
 * (`resolveAffinity` prefers an unpinned one), then the binding is released so
 * the measured run's affinity is free to land anywhere.
 */
async function warmWorkers(
  exec: WorkerPoolEnrichmentExecutor,
  provider: EnrichmentProvider,
  root: string,
  corpus: string[],
  poolSize: number,
): Promise<void> {
  const warmPaths = corpus.slice(0, 2);
  const collections = Array.from({ length: poolSize }, (_, i) => `code_pass1_warm_${i}`);
  await Promise.all(
    collections.map(async (collectionName) => exec.runFileBatch(provider, root, warmPaths, { collectionName })),
  );
  await Promise.all(collections.map(async (collectionName) => exec.releaseCollection([provider], collectionName)));
}

/**
 * One mode end to end: fresh pool, fresh scratch graph DB, fresh collection, all
 * batches dispatched the way `FilePhase` dispatches them — fired without being
 * awaited, then drained together. That firing pattern is load-bearing: it is
 * what lets the fan-out overlap one batch's absorb with the next batch's parse.
 */
async function runMode(mode: string, root: string, corpus: string[], args: Args): Promise<ModeResult> {
  const dataDir = mkdtempSync(join(tmpdir(), `pass1-fanout-${mode}-`));
  const exec = new WorkerPoolEnrichmentExecutor(args.pool, WORKER_PATH);
  const provider = codegraphProviderHandle(dataDir, mode === "fanout");
  const collectionName = `code_pass1_${mode}`;
  await warmWorkers(exec, provider, root, corpus, args.pool);
  exec.beginRun(collectionName);

  const batches = batched(corpus, args.batch);
  const startedAt = performance.now();
  try {
    await Promise.all(batches.map(async (paths) => exec.runFileBatch(provider, root, paths, { collectionName })));
    const wallMs = Math.round(performance.now() - startedAt);
    return { mode, files: corpus.length, batches: batches.length, wallMs };
  } finally {
    await exec.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const corpus = collectCorpus(args.root);
  process.stderr.write(`corpus: ${corpus.length} files under ${join(args.root, "src")}\n`);
  process.stderr.write(`pool: ${args.pool} workers, batch: ${args.batch} files\n`);

  // The kill-switch is read at executor construction, so set it per mode.
  process.env.CODEGRAPH_PASS1_FANOUT = "0";
  const serial = await runMode("serial", args.root, corpus, args);
  delete process.env.CODEGRAPH_PASS1_FANOUT;
  const fanout = await runMode("fanout", args.root, corpus, args);

  const speedup = serial.wallMs / Math.max(1, fanout.wallMs);
  process.stdout.write(
    `${JSON.stringify(
      {
        corpusFiles: corpus.length,
        pool: args.pool,
        batchSize: args.batch,
        serialWallMs: serial.wallMs,
        fanoutWallMs: fanout.wallMs,
        savedMs: serial.wallMs - fanout.wallMs,
        speedup: Math.round(speedup * 100) / 100,
        serialMsPerFile: Math.round((serial.wallMs / corpus.length) * 100) / 100,
        fanoutMsPerFile: Math.round((fanout.wallMs / corpus.length) * 100) / 100,
      },
      null,
      2,
    )}\n`,
  );
}

void main().catch((err: unknown) => {
  process.stderr.write(`pass1-fanout-profile failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
});
