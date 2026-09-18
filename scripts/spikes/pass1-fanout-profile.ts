/**
 * Offline acceptance for pass-1 extraction fan-out (bd pass1-fanout) and for
 * per-language codegraph affinity built on it (bd tea-rags-mcp-sgo8v).
 *
 * Runs the SAME production path a `--force-enrichments codegraph` recompute
 * takes — real `WorkerPoolEnrichmentExecutor`, real enrichment worker entry,
 * real `createCodegraphEnrichmentProvider` rebuilt in-thread — over a real
 * multi-hundred-file corpus, and reports the wall clock of each stage.
 *
 * ── Fan-out modes (default) ────────────────────────────────────────────────
 *
 * Everything from the executor down is production code, including the DuckDB
 * writes both halves perform. The only substitution is the graph DB, which
 * opens as a local file under a scratch dir instead of through the daemon
 * socket — the daemon serialises writes across processes and would add its own
 * IPC to every number here. Three modes, because the fan-out moved the
 * bottleneck rather than removing it:
 *
 *   serial   — `CODEGRAPH_PASS1_FANOUT=0`, the pre-fan-out shape.
 *   fanout   — fan-out on, node drain still blocking pass-2.
 *   overlap  — fan-out on, drain dispatched and pass-2 run against it.
 *
 * Each reports the file-batch phase AND `runFinalize`, because the drain is
 * inside `finalize`: the fan-out cut the batch phase roughly in half on taxdome
 * and the Ruby codegraph window still went 51.9s → 59.9s, because 24.1s of
 * `CODEGRAPH_NODES_FLUSH` that used to hide behind the serial parse became a
 * serial tail in front of pass-2. Only `batch + finalize` shows that.
 *
 * Default corpus is this repository's own `src/` (≈900 TypeScript files). Run
 * it at `--batch 60` for the live flush cadence and again enlarged.
 *
 * ── Language affinity (`--affinity`) ────────────────────────────────────────
 *
 * A mixed-language corpus, twice: one collection-affinity worker
 * (`CODEGRAPH_LANGUAGE_AFFINITY=0`) against one worker per language partition.
 * Here the graph DB goes through a REAL codegraph daemon, started in this
 * process on a scratch socket: two partition workers write one collection
 * concurrently, and the daemon's single per-collection connection is where
 * that interleaving happens in production — a local file per worker would not
 * test it. Reports each mode's batch / finalize / chunk-pass wall, and a PARITY
 * verdict over the two resulting databases and overlays:
 *
 *   - byte-exact over every `cg_*` table except the two order-sensitive
 *     analytics, and over the file overlays;
 *   - cycles as member sets, PageRank within 1e-12 (the adapter's own
 *     `PAGE_RANK_EPSILON`) — both are computed from the edge tables in storage
 *     order, which two interleaved writers do not share with one writer.
 *
 * `--sample N` keeps the first N files (sorted) of each language, so a large
 * checkout can be measured without walking all of it. Scratch data goes under
 * `--scratch DIR` (default: the OS temp dir); nothing touches `~/.tea-rags`.
 *
 *   npm run build
 *   npx tsx scripts/spikes/pass1-fanout-profile.ts [--batch N] [--pool N] [--root DIR]
 *   npx tsx scripts/spikes/pass1-fanout-profile.ts --affinity --root <mixed repo> \
 *       [--sample N] [--batch N] [--pool N] [--files-per-thread N] [--scratch DIR]
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

import { DuckDbGraphClient } from "../../src/core/adapters/duckdb/client.js";
import { runDaemon } from "../../src/core/adapters/duckdb/daemon/entry.js";
import { getDaemonPaths } from "../../src/core/adapters/duckdb/daemon/lifecycle.js";
import type { PhysicalCollectionName } from "../../src/core/contracts/types/collection-identity.js";
import type { EnrichmentRunHandle } from "../../src/core/contracts/types/enrichment-executor.js";
import type {
  ChunkLookupEntry,
  ChunkSignalOverlay,
  EnrichmentProvider,
  FileSignalOverlay,
  WorkerEnrichmentDescriptor,
} from "../../src/core/contracts/types/provider.js";
import { WorkerPoolEnrichmentExecutor } from "../../src/core/domains/ingest/pipeline/enrichment/executor/worker-pool.js";
import { DATABASE_MIGRATIONS_MODULE_URL } from "../../src/core/domains/maintenance/migration/database/index.js";
import {
  CODEGRAPH_LANGUAGE_BY_EXTENSION,
  type CodegraphWorkerConfig,
} from "../../src/core/domains/trajectory/codegraph/index.js";
import { resolvePhysicalCollection } from "../../src/core/infra/collection-name.js";

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

/** Directories no production scan descends into; skipping them keeps the sample honest. */
const SKIPPED_DIRS = new Set(["node_modules", ".git", "vendor", "build", "dist", "tmp", "coverage", "public"]);
/** The adapter's `PAGE_RANK_EPSILON`: two PageRanks closer than this are the same value. */
const PAGE_RANK_EPSILON = 1e-12;
const ORDER_SENSITIVE_TABLES = new Set(["cg_symbols_cycles", "cg_symbols_metrics"]);

interface Args {
  affinity: boolean;
  batch: number;
  pool: number;
  root: string;
  sample: number;
  filesPerThread: number;
  scratch: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    affinity: false,
    batch: 120,
    pool: 4,
    root: REPO_ROOT,
    sample: Number.POSITIVE_INFINITY,
    filesPerThread: 400,
    scratch: tmpdir(),
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--affinity") args.affinity = true;
    else if (argv[i] === "--batch") args.batch = Number(argv[++i]);
    else if (argv[i] === "--pool") args.pool = Number(argv[++i]);
    else if (argv[i] === "--root") args.root = resolve(argv[++i]);
    else if (argv[i] === "--sample") args.sample = Number(argv[++i]);
    else if (argv[i] === "--files-per-thread") args.filesPerThread = Number(argv[++i]);
    else if (argv[i] === "--scratch") args.scratch = resolve(argv[++i]);
  }
  return args;
}

/** Every `.ts`/`.tsx` under `<root>/src`, repo-relative and sorted. */
function collectTypeScriptCorpus(root: string): string[] {
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

function languageOfPath(relPath: string): string | undefined {
  const dot = relPath.lastIndexOf(".");
  return dot > relPath.lastIndexOf("/") ? CODEGRAPH_LANGUAGE_BY_EXTENSION[relPath.slice(dot)] : undefined;
}

/**
 * Every file of a codegraph language under `root`, sorted, keeping at most
 * `sample` per language — the first ones in path order, so two runs over one
 * checkout measure the same files.
 */
function collectMixedCorpus(root: string, sample: number): { files: string[]; byLanguage: Record<string, number> } {
  const byLanguage = new Map<string, string[]>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(join(dir, entry.name));
        continue;
      }
      const relPath = relative(root, join(dir, entry.name));
      const language = languageOfPath(relPath);
      if (language === undefined) continue;
      const list = byLanguage.get(language) ?? [];
      list.push(relPath);
      byLanguage.set(language, list);
    }
  };
  walk(root);
  const files: string[] = [];
  const counts: Record<string, number> = {};
  for (const [language, list] of [...byLanguage].sort(([a], [b]) => a.localeCompare(b))) {
    const kept = list.sort().slice(0, sample);
    counts[language] = kept.length;
    files.push(...kept);
  }
  return { files: files.sort(), byLanguage: counts };
}

function batched(paths: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < paths.length; i += size) out.push(paths.slice(i, i + size));
  return out;
}

/**
 * A scratch collection of this profile. Every mode builds its graph DB from
 * nothing under its own scratch root, so no alias can name it and resolving it
 * against none yields the physical name — minted the production way, not cast.
 */
function scratchCollection(name: string): PhysicalCollectionName {
  return resolvePhysicalCollection(name, []);
}

function runHandle(collection: PhysicalCollectionName): EnrichmentRunHandle {
  return { runId: `profile-${collection}`, collection, absolutePath: "" };
}

/**
 * The provider handle the executor reads on the MAIN thread: only the descriptor
 * matters, since every method actually runs on a worker that rebuilds the real
 * provider from `providerModulePath`.
 */
function codegraphProviderHandle(config: CodegraphWorkerConfig, fanout: boolean): EnrichmentProvider {
  const descriptor: WorkerEnrichmentDescriptor = {
    providerModulePath: PROVIDER_MODULE_PATH,
    providerFactoryExport: "createCodegraphEnrichmentProvider",
    dispatch: "collection-affinity",
    extractionFanout: fanout,
    languageAffinity: { partitionByExtension: CODEGRAPH_LANGUAGE_BY_EXTENSION },
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

// ── Fan-out modes ─────────────────────────────────────────────────────────────

interface FanoutModeResult {
  mode: string;
  files: number;
  batches: number;
  /** The file-batch phase alone — what the first round of this profile measured. */
  batchWallMs: number;
  /** `runFinalize`: node drain + pass-2 resolve + metric recompute. */
  finalizeWallMs: number;
  /** The window a codegraph recompute actually occupies. */
  totalWallMs: number;
}

/** One mode's env, applied before the executor is constructed (both flags are read there). */
interface FanoutModeEnv {
  fanout: boolean;
  overlap: boolean;
}

const FANOUT_MODES: Record<string, FanoutModeEnv> = {
  serial: { fanout: false, overlap: false },
  fanout: { fanout: true, overlap: false },
  overlap: { fanout: true, overlap: true },
};

function applyFanoutModeEnv(env: FanoutModeEnv): void {
  if (env.fanout) delete process.env.CODEGRAPH_PASS1_FANOUT;
  else process.env.CODEGRAPH_PASS1_FANOUT = "0";
  if (env.overlap) delete process.env.CODEGRAPH_NODE_DRAIN_OVERLAP;
  else process.env.CODEGRAPH_NODE_DRAIN_OVERLAP = "0";
  // These modes measure ONE collection-affinity worker; language affinity is
  // the `--affinity` measurement.
  process.env.CODEGRAPH_LANGUAGE_AFFINITY = "0";
}

/**
 * Build a provider on EVERY worker before the clock starts.
 *
 * The first dispatch a worker sees pays for the dynamic import of the whole
 * `domains/language` barrel and the tree-sitter native load — hundreds of ms,
 * once per thread. One tiny batch per throwaway collection: each pins to a
 * different thread (`resolveAffinity` prefers an unpinned one), then the run
 * is released so the measured run's affinity is free to land anywhere.
 */
async function warmWorkers(
  exec: WorkerPoolEnrichmentExecutor,
  provider: EnrichmentProvider,
  root: string,
  corpus: string[],
  poolSize: number,
): Promise<void> {
  const warmPaths = corpus.slice(0, 2);
  const collections = Array.from({ length: poolSize }, (_, i) => scratchCollection(`code_pass1_warm_${i}`));
  await Promise.all(
    collections.map(async (collectionName) => exec.runFileBatch(provider, root, warmPaths, { collectionName })),
  );
  await Promise.all(collections.map(async (collectionName) => exec.releaseRun([provider], runHandle(collectionName))));
}

/**
 * One mode end to end: fresh pool, fresh scratch graph DB, fresh collection, all
 * batches dispatched the way `FilePhase` dispatches them — fired without being
 * awaited, then drained together.
 */
async function runFanoutMode(mode: string, root: string, corpus: string[], args: Args): Promise<FanoutModeResult> {
  applyFanoutModeEnv(FANOUT_MODES[mode]);
  const dataDir = mkdtempSync(join(args.scratch, `pass1-fanout-${mode}-`));
  const exec = new WorkerPoolEnrichmentExecutor(args.pool, WORKER_PATH);
  const provider = codegraphProviderHandle(
    {
      languageModulePath: LANGUAGE_MODULE_PATH,
      migrationsModulePath: MIGRATIONS_MODULE_URL,
      rootDir: dataDir,
      customExcludePatterns: [],
    },
    FANOUT_MODES[mode].fanout,
  );
  const collectionName = scratchCollection(`code_pass1_${mode}`);
  await warmWorkers(exec, provider, root, corpus, args.pool);
  exec.beginRun(runHandle(collectionName), corpus.length);

  const batches = batched(corpus, args.batch);
  const startedAt = performance.now();
  try {
    await Promise.all(batches.map(async (paths) => exec.runFileBatch(provider, root, paths, { collectionName })));
    const batchWallMs = Math.round(performance.now() - startedAt);
    const finalizeStartedAt = performance.now();
    await exec.runFinalize(provider, root, { collectionName });
    const finalizeWallMs = Math.round(performance.now() - finalizeStartedAt);
    return {
      mode,
      files: corpus.length,
      batches: batches.length,
      batchWallMs,
      finalizeWallMs,
      totalWallMs: batchWallMs + finalizeWallMs,
    };
  } finally {
    await exec.releaseRun([provider], runHandle(collectionName)).catch(() => undefined);
    await exec.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

async function profileFanout(args: Args): Promise<void> {
  const corpus = collectTypeScriptCorpus(args.root);
  process.stderr.write(`corpus: ${corpus.length} files under ${join(args.root, "src")}\n`);
  process.stderr.write(`pool: ${args.pool} workers, batch: ${args.batch} files\n`);

  const serial = await runFanoutMode("serial", args.root, corpus, args);
  const fanout = await runFanoutMode("fanout", args.root, corpus, args);
  const overlap = await runFanoutMode("overlap", args.root, corpus, args);

  const ratio = (a: number, b: number): number => Math.round((a / Math.max(1, b)) * 100) / 100;
  process.stdout.write(
    `${JSON.stringify(
      {
        corpusFiles: corpus.length,
        pool: args.pool,
        batchSize: args.batch,
        modes: [serial, fanout, overlap],
        batchSpeedupFanoutVsSerial: ratio(serial.batchWallMs, fanout.batchWallMs),
        windowSpeedupFanoutVsSerial: ratio(serial.totalWallMs, fanout.totalWallMs),
        windowSpeedupOverlapVsSerial: ratio(serial.totalWallMs, overlap.totalWallMs),
        windowSpeedupOverlapVsFanout: ratio(fanout.totalWallMs, overlap.totalWallMs),
        overlapSavedMs: fanout.totalWallMs - overlap.totalWallMs,
      },
      null,
      2,
    )}\n`,
  );
}

// ── Language affinity ─────────────────────────────────────────────────────────

type AffinityMode = "collection" | "language";

interface AffinityModeResult {
  mode: AffinityMode;
  batchWallMs: number;
  finalizeWallMs: number;
  chunkWallMs: number;
  /** batch + finalize + chunk pass: the codegraph window of a recompute. */
  totalWallMs: number;
  tables: Record<string, string[]>;
  fileOverlays: Map<string, FileSignalOverlay>;
  chunkOverlays: Map<string, Map<string, ChunkSignalOverlay>>;
}

function findDuckDbFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...findDuckDbFiles(path));
    else if (entry.endsWith(".duckdb")) out.push(path);
  }
  return out;
}

async function dumpCodegraphTables(client: DuckDbGraphClient): Promise<Record<string, string[]>> {
  const tables = await client.queryAll<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_name LIKE 'cg_%' ORDER BY table_name",
  );
  const dump: Record<string, string[]> = {};
  for (const { table_name: table } of tables) {
    const rows = await client.queryAll<Record<string, unknown>>(`SELECT * FROM ${table}`);
    dump[table] = rows
      .map((row) => {
        const normalized: Record<string, unknown> = {};
        for (const key of Object.keys(row).sort()) normalized[key] = key.endsWith("_at") ? "<stamp>" : row[key];
        return JSON.stringify(normalized, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
      })
      .sort();
  }
  return dump;
}

/** One stored chunk per file, spanning it whole — what the deferred pass is handed. */
function wholeFileChunkMap(root: string, corpus: string[]): Map<string, ChunkLookupEntry[]> {
  return new Map(
    corpus.map((relPath) => {
      const lines = readFileSync(join(root, relPath), "utf8").split("\n").length;
      return [relPath, [{ chunkId: `chunk:${relPath}`, startLine: 1, endLine: lines }]];
    }),
  );
}

async function runAffinityMode(mode: AffinityMode, root: string, corpus: string[], args: Args) {
  if (mode === "collection") process.env.CODEGRAPH_LANGUAGE_AFFINITY = "0";
  else delete process.env.CODEGRAPH_LANGUAGE_AFFINITY;
  delete process.env.CODEGRAPH_PASS1_FANOUT;
  delete process.env.CODEGRAPH_NODE_DRAIN_OVERLAP;

  const scratch = mkdtempSync(join(args.scratch, `lang-affinity-${mode}-`));
  const dataRoot = join(scratch, "data");
  const daemonPaths = getDaemonPaths(join(scratch, "d"));
  mkdirSync(daemonPaths.storageDir, { recursive: true });
  // In-process daemon on a scratch socket: the machine's own daemon is never
  // reached, and a drain must not exit this process.
  const daemon = await runDaemon({
    rootDir: dataRoot,
    paths: daemonPaths,
    migrationsModulePath: DATABASE_MIGRATIONS_MODULE_URL,
    buildFingerprint: "language-affinity-profile",
    exit: () => undefined,
  });
  const exec = new WorkerPoolEnrichmentExecutor(args.pool, WORKER_PATH, args.filesPerThread);
  const provider = codegraphProviderHandle(
    {
      languageModulePath: LANGUAGE_MODULE_PATH,
      migrationsModulePath: MIGRATIONS_MODULE_URL,
      daemonSocketPath: daemonPaths.socketPath,
      rootDir: dataRoot,
      customExcludePatterns: [],
    },
    true,
  );
  const collectionName = scratchCollection(`code_affinity_${mode}`);
  const run = runHandle(collectionName);
  try {
    exec.beginRun(run, corpus.length, corpus);
    const startedAt = performance.now();
    await Promise.all(
      batched(corpus, args.batch).map(async (paths) => exec.runFileBatch(provider, root, paths, { collectionName })),
    );
    const batchWallMs = Math.round(performance.now() - startedAt);
    const finalizeStartedAt = performance.now();
    const fileOverlays = await exec.runFinalize(provider, root, { collectionName, runCoverage: "wholeCorpus" });
    const finalizeWallMs = Math.round(performance.now() - finalizeStartedAt);
    const chunkStartedAt = performance.now();
    const chunkOverlays = await exec.runChunkBatch(provider, root, wholeFileChunkMap(root, corpus), {
      collectionName,
    });
    const chunkWallMs = Math.round(performance.now() - chunkStartedAt);
    await exec.releaseRun([provider], run);
    await exec.shutdown();
    await daemon.shutdown();

    const [dbFile] = findDuckDbFiles(dataRoot);
    const client = new DuckDbGraphClient({ path: dbFile });
    await client.init();
    try {
      return {
        mode,
        batchWallMs,
        finalizeWallMs,
        chunkWallMs,
        totalWallMs: batchWallMs + finalizeWallMs + chunkWallMs,
        tables: await dumpCodegraphTables(client),
        fileOverlays,
        chunkOverlays,
      } satisfies AffinityModeResult;
    } finally {
      await client.close();
    }
  } finally {
    await exec.shutdown().catch(() => undefined);
    await daemon.shutdown().catch(() => undefined);
    rmSync(scratch, { recursive: true, force: true });
  }
}

function cycleMemberSets(rows: readonly string[]): string[] {
  const members = new Map<string, string[]>();
  for (const line of rows) {
    const row = JSON.parse(line) as { scope: string; cycle_id: number | string; member: string };
    const key = `${row.scope}#${row.cycle_id}`;
    members.set(key, [...(members.get(key) ?? []), row.member]);
  }
  return [...members].map(([key, list]) => `${key.split("#")[0]}:${list.sort().join(",")}`).sort();
}

/** Largest |Δ| between two symbol → value maps; Infinity when their key sets differ. */
function maxAbsDiff(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size !== b.size) return Number.POSITIVE_INFINITY;
  let max = 0;
  for (const [key, value] of a) {
    const other = b.get(key);
    if (other === undefined) return Number.POSITIVE_INFINITY;
    max = Math.max(max, Math.abs(other - value));
  }
  return max;
}

function pageRanks(rows: readonly string[]): Map<string, number> {
  return new Map(
    rows.map((line) => {
      const row = JSON.parse(line) as { symbol_id: string; page_rank: number };
      return [row.symbol_id, Number(row.page_rank)];
    }),
  );
}

function chunkPageRanks(overlays: Map<string, Map<string, ChunkSignalOverlay>>): Map<string, number> {
  const out = new Map<string, number>();
  for (const chunks of overlays.values()) {
    for (const [chunkId, overlay] of chunks) {
      const { pageRank } = overlay as { pageRank?: number };
      if (typeof pageRank === "number") out.set(chunkId, pageRank);
    }
  }
  return out;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_k, v: unknown) => {
    if (v instanceof Map) {
      return [...(v as Map<unknown, unknown>)].sort(([a], [b]) => String(a).localeCompare(String(b)));
    }
    return v;
  });
}

function withoutPageRank(overlays: Map<string, Map<string, ChunkSignalOverlay>>): unknown {
  return new Map(
    [...overlays].map(([relPath, chunks]) => [
      relPath,
      new Map([...chunks].map(([chunkId, overlay]) => [chunkId, { ...overlay, pageRank: undefined }])),
    ]),
  );
}

async function profileAffinity(args: Args): Promise<void> {
  const { files: corpus, byLanguage } = collectMixedCorpus(args.root, args.sample);
  process.stderr.write(`corpus: ${corpus.length} files under ${args.root} ${JSON.stringify(byLanguage)}\n`);
  process.stderr.write(`pool: ${args.pool}, batch: ${args.batch}, files-per-thread: ${args.filesPerThread}\n`);

  const single = await runAffinityMode("collection", args.root, corpus, args);
  const split = await runAffinityMode("language", args.root, corpus, args);

  const exactTables = Object.keys(single.tables).filter((table) => !ORDER_SENSITIVE_TABLES.has(table));
  const divergedTables = exactTables.filter(
    (table) => JSON.stringify(single.tables[table]) !== JSON.stringify(split.tables[table]),
  );
  const cyclesEqual =
    JSON.stringify(cycleMemberSets(single.tables.cg_symbols_cycles)) ===
    JSON.stringify(cycleMemberSets(split.tables.cg_symbols_cycles));
  const pageRankMaxAbsDiff = maxAbsDiff(
    pageRanks(single.tables.cg_symbols_metrics),
    pageRanks(split.tables.cg_symbols_metrics),
  );
  const chunkPageRankMaxAbsDiff = maxAbsDiff(chunkPageRanks(single.chunkOverlays), chunkPageRanks(split.chunkOverlays));
  const fileOverlaysEqual = stableJson(single.fileOverlays) === stableJson(split.fileOverlays);
  const chunkOverlaysEqual =
    stableJson(withoutPageRank(single.chunkOverlays)) === stableJson(withoutPageRank(split.chunkOverlays));
  const parity =
    divergedTables.length === 0 &&
    cyclesEqual &&
    pageRankMaxAbsDiff <= PAGE_RANK_EPSILON &&
    chunkPageRankMaxAbsDiff <= PAGE_RANK_EPSILON &&
    fileOverlaysEqual &&
    chunkOverlaysEqual;

  const timing = (r: AffinityModeResult) => ({
    mode: r.mode,
    batchWallMs: r.batchWallMs,
    finalizeWallMs: r.finalizeWallMs,
    chunkWallMs: r.chunkWallMs,
    totalWallMs: r.totalWallMs,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        corpusFiles: corpus.length,
        byLanguage,
        pool: args.pool,
        batchSize: args.batch,
        filesPerThread: args.filesPerThread,
        modes: [timing(single), timing(split)],
        windowSpeedupLanguageVsCollection:
          Math.round((single.totalWallMs / Math.max(1, split.totalWallMs)) * 100) / 100,
        parity: {
          verdict: parity ? "EXACT" : "DIVERGED",
          rows: Object.fromEntries(Object.entries(single.tables).map(([table, rows]) => [table, rows.length])),
          divergedTables,
          cyclesEqual,
          pageRankMaxAbsDiff,
          chunkPageRankMaxAbsDiff,
          fileOverlaysEqual,
          chunkOverlaysEqual,
        },
      },
      null,
      2,
    )}\n`,
  );
  if (!parity) process.exitCode = 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.affinity) await profileAffinity(args);
  else await profileFanout(args);
}

void main().catch((err: unknown) => {
  process.stderr.write(`pass1-fanout-profile failed: ${(err as Error).stack ?? String(err)}\n`);
  process.exitCode = 1;
});
