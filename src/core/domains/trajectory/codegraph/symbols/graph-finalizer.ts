/**
 * Pass-2 graph build completion (bd tea-rags-mcp-6vfrj / G2).
 *
 * Two stages, both driven by the extraction sink's `finish`:
 *
 *   1. {@link GraphBuildFinalizer.resolveAndUpsert} — stream the NDJSON spill
 *      line by line, resolve each file's calls, buffer the results into bulk
 *      transactions, and CHECKPOINT on a fixed cadence so the DuckDB WAL stays
 *      bounded.
 *   2. {@link GraphBuildFinalizer.recomputeMetrics} — Tarjan SCC for both scopes
 *      plus confidence-weighted PageRank over the method graph.
 *
 * Extracted verbatim from `CodegraphEnrichmentProvider`; the caps and their
 * justifications travel with the code because each one encodes a production
 * failure (the 96k-edge minified-bundle OOM, the 30 GB daemon delegation).
 */

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

import type {
  BulkFileUpsertEntry,
  FileExtraction,
  GlobalSymbolTable,
  GraphDbClient,
  GraphEdges,
} from "../../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../../contracts/types/collection-identity.js";
import { pageRank, tarjanScc } from "../../../../infra/graph/index.js";
import { isDebug } from "../../../../infra/runtime.js";
import {
  CodegraphCheckpointError,
  CodegraphMetricsError,
  CodegraphResolveError,
  CodegraphSpillIoError,
  type CodegraphMetricsStage,
} from "../../errors.js";
import {
  countCappedGraphEdges,
  countedGraphEdgesByKind,
  MAX_EDGES_PER_FILE,
  pathologicalFileGraphEdges,
} from "./graph-edge-cap-policy.js";
import { Pass2BulkWriteBuffer } from "./pass2-bulk-write-buffer.js";
import { CodegraphPhaseTimings } from "./phase-timings.js";
import type { CallEdgeResolutionRunner, CodegraphResolveVisitPlan } from "./resolution-runner.js";
import type { CodegraphRunState } from "./run-state.js";
import { indexSpillLines, SpillLineReader, type SpillLineSpan } from "./spill-line-index.js";

/** Files processed between DuckDB checkpoints — keeps the WAL bounded. */
const CHECKPOINT_EVERY = 500;
/** Files between progress logs so a slow run shows where it stalled. */
const PROGRESS_EVERY = 100;
/**
 * Files folded into one bulk upsert transaction (and, on the daemon, one IPC
 * round-trip) instead of one BEGIN/COMMIT + round-trip per file.
 */
const BULK_FILES = 256;

/**
 * Positive integer from `name`, else `fallback`. Mirrors the pass-1 cadence
 * knob (`CODEGRAPH_NODE_FLUSH_FILES` in provider.ts) — same parse, same
 * read-once-at-construction discipline.
 */
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

/** Max bytes of a raw spill line worth an error message — enough to see the
 * shape of the corruption without dumping a multi-KB FileExtraction JSON. */
const SNIPPET_MAX_CHARS = 300;

function snippet(line: string): string {
  return line.length > SNIPPET_MAX_CHARS ? `${line.slice(0, SNIPPET_MAX_CHARS)}…(${line.length} bytes total)` : line;
}

/**
 * One pass-2 loop's working state: the store it writes to, its write window,
 * and the position counters every error message reports.
 */
interface Pass2LoopRun {
  readonly graphDb: GraphDbClient;
  readonly symbolTable: GlobalSymbolTable;
  readonly writes: Pass2BulkWriteBuffer;
  /** Files buffered so far — the `#N` every pass-2 error names. */
  processed: number;
  lastRelPath: string | null;
}

/** Parse one spill line, naming the file position and a snippet of the line on failure. */
function parseSpillLine(line: string, processed: number): FileExtraction {
  try {
    return JSON.parse(line) as FileExtraction;
  } catch (err) {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    throw new CodegraphResolveError(
      processed,
      Object.assign(wrapped, {
        message: `JSON.parse failed on spill line at file #${processed + 1}: '${snippet(line)}': ${wrapped.message}`,
      }),
    );
  }
}

/**
 * The error a pass-2 loop failure surfaces as. Already-typed pass-2 errors pass
 * through; anything else is wrapped with the last-seen file, so the propagated
 * marker tells the operator WHERE the loop tripped.
 */
function pass2LoopError(err: unknown, run: Pass2LoopRun): Error {
  if (
    err instanceof CodegraphResolveError ||
    err instanceof CodegraphCheckpointError ||
    err instanceof CodegraphSpillIoError
  ) {
    return err;
  }
  const wrapped = err instanceof Error ? err : new Error(String(err));
  return new CodegraphResolveError(
    run.processed,
    Object.assign(wrapped, {
      message: `loop fatal after ${run.processed} files (last seen: ${run.lastRelPath ?? "<none>"}): ${wrapped.message}`,
    }),
  );
}

/** Resolve the (graphDb, symbolTable) pair for the active collection. */
export type GraphStoreResolver = (
  physicalCollectionName?: PhysicalCollectionName,
) => Promise<{ graphDb: GraphDbClient; symbolTable: GlobalSymbolTable }>;

async function collectAdjacency(
  graphDb: GraphDbClient,
  scope: "file" | "method",
): Promise<{ adjacency: Map<string, string[]>; edgeWeights: Map<string, number[]> }> {
  const adjacency = new Map<string, string[]>();
  const edgeWeights = new Map<string, number[]>();
  for await (const [source, target, weight] of graphDb.streamAdjacency(scope)) {
    const list = adjacency.get(source);
    const wList = edgeWeights.get(source);
    if (list && wList) {
      list.push(target);
      wList.push(weight ?? 1);
    } else {
      adjacency.set(source, [target]);
      edgeWeights.set(source, [weight ?? 1]);
    }
  }
  return { adjacency, edgeWeights };
}

/**
 * The runner as pass-2 uses it. `resolveVisitPlans` is optional: a runner
 * without it streams the spill in write order, exactly as before closure-batch
 * ordering existed (bd tea-rags-mcp-vtuu4).
 */
export type Pass2ResolutionRunner = Omit<CallEdgeResolutionRunner, "resolveVisitPlans"> &
  Partial<Pick<CallEdgeResolutionRunner, "resolveVisitPlans">>;

/**
 * Feed `processLine` every spill line in the order `plans` ask for (bd
 * tea-rags-mcp-vtuu4): lines of files no plan names first, in spill order,
 * then each plan's groups in turn. A relPath the spill holds twice has both
 * lines visited together, in spill order, so the later write still wins.
 *
 * After each group the plan's `endGroup` releases what served it, and the loop
 * yields one macrotask, so the released Program can be collected and pending
 * I/O callbacks run before the next group's Program is built.
 */
async function visitInPlanOrder(
  spillPath: string,
  plans: readonly CodegraphResolveVisitPlan[],
  processLine: (line: string) => Promise<void>,
): Promise<void> {
  const spans = await indexSpillLines(spillPath);
  const spansOf = new Map<string, SpillLineSpan[]>();
  for (const span of spans) {
    const held = spansOf.get(span.relPath);
    if (held === undefined) spansOf.set(span.relPath, [span]);
    else held.push(span);
  }
  const planned = new Set<string>();
  for (const plan of plans) for (const group of plan.groups) for (const relPath of group) planned.add(relPath);

  const reader = await SpillLineReader.open(spillPath);
  try {
    for (const span of spans) if (!planned.has(span.relPath)) await processLine(await reader.read(span));
    const visited = new Set<string>();
    for (const plan of plans) {
      for (const group of plan.groups) {
        for (const relPath of group) {
          if (visited.has(relPath)) continue;
          visited.add(relPath);
          for (const span of spansOf.get(relPath) ?? []) await processLine(await reader.read(span));
        }
        plan.endGroup();
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  } finally {
    await reader.close();
  }
}

export class GraphBuildFinalizer {
  /**
   * Pass-2 write cadence, read once at construction.
   *
   * Overridable via `CODEGRAPH_BULK_FILES` / `CODEGRAPH_CHECKPOINT_EVERY` for
   * two reasons: tests can cross both boundaries with a handful of files
   * instead of paying for a production-sized run, and the checkpoint interval
   * is a live tuning question — its cost on a large repo has never been
   * measured, and a knob is what makes measuring it possible.
   */
  private readonly bulkFiles = positiveIntFromEnv("CODEGRAPH_BULK_FILES", BULK_FILES);
  private readonly checkpointEvery = positiveIntFromEnv("CODEGRAPH_CHECKPOINT_EVERY", CHECKPOINT_EVERY);

  /**
   * @param timings Wall-clock attribution for pass-2's four stages, shared with
   *   the provider so pass-1 and pass-2 land in ONE summary. Defaulted so a
   *   caller that only wants the loop (tests, direct mode) need not supply one;
   *   production passes the provider's instance.
   */
  constructor(
    private readonly resolveStore: GraphStoreResolver,
    private readonly resolutionRunner: Pass2ResolutionRunner,
    private readonly runState: CodegraphRunState,
    private readonly timings: CodegraphPhaseTimings = new CodegraphPhaseTimings(),
  ) {}

  /**
   * Slice 2 streaming pass-2. Reads the NDJSON spill line-by-line, resolves
   * calls against the now-complete `symbolTable`, issues bulk `upsertFilesBulk`
   * transactions, and CHECKPOINTs every `CHECKPOINT_EVERY` files.
   *
   * Memory footprint: O(1) in the spill size — one JSON line resident at any
   * time. The resolver's working set is the file's own chunks and the global
   * symbol table (already loaded in-memory).
   *
   * Four steps, one owner each (bd tea-rags-mcp-89k7k.35.17):
   * {@link GraphBuildFinalizer.prepareResolvePass} sizes the resolvers,
   * {@link GraphBuildFinalizer.visitSpill} decides the line order,
   * {@link GraphBuildFinalizer.processSpillLine} turns one line into one
   * buffered file, and {@link GraphBuildFinalizer.finishPass} lands the
   * remainder. The write window itself is {@link Pass2BulkWriteBuffer}.
   */
  async resolveAndUpsert(spillPath: string, physicalCollectionName?: PhysicalCollectionName): Promise<void> {
    const { graphDb, symbolTable } = await this.resolveStore(physicalCollectionName);
    this.prepareResolvePass();
    const run: Pass2LoopRun = {
      graphDb,
      symbolTable,
      writes: new Pass2BulkWriteBuffer(graphDb, this.timings),
      processed: 0,
      lastRelPath: null,
    };
    try {
      await this.visitSpill(spillPath, async (line) => this.processSpillLine(run, line));
      await this.finishPass(run);
    } catch (err) {
      throw pass2LoopError(err, run);
    } finally {
      // A dispatched write must never outlive the call that opened it: on the
      // success path this is a no-op (already settled by `finishPass`), on the
      // throw path it lets the open transaction finish before the error
      // propagates, so the daemon is not still committing while the caller
      // starts tearing the run down. Its own failure is swallowed HERE on
      // purpose — the resolve error that brought us here is the root cause and
      // must be the one that surfaces; a flush that fails while nothing is being
      // torn down still aborts the pass through `dispatch`/`settle` in the loop.
      await run.writes.settle().catch(() => undefined);
    }
  }

  /**
   * The pass opens by declaring its own size to the resolvers
   * (bd tea-rags-mcp-6aytq). Every file this loop will read was counted in
   * pass-1, so a resolver whose run-scoped caches are worth building in one
   * piece can do it here — before the first file, where it is a fixed cost —
   * rather than inferring the same fact from the first few hundred call sites.
   */
  private prepareResolvePass(): void {
    const preparedAtMs = Date.now();
    this.resolutionRunner.prepareResolvePass();
    // Attributed to pass-2 with a count of ZERO files: whatever a resolver
    // built here is pass-2 wall clock (a whole-project `ts.Program` is ~10 s of
    // it on taxdome), but it is not a file, and charging it as one would move
    // the ms/file figure this accumulator exists to report.
    this.timings.record("pass2", Date.now() - preparedAtMs, { count: 0 });
  }

  /**
   * Feed every spill line to `processLine`: in the order the runner's visit
   * plans ask for (bd tea-rags-mcp-vtuu4), or in write order when it has none.
   */
  private async visitSpill(spillPath: string, processLine: (line: string) => Promise<void>): Promise<void> {
    const visitPlans = this.resolutionRunner.resolveVisitPlans?.() ?? [];
    if (visitPlans.length > 0) {
      await visitInPlanOrder(spillPath, visitPlans, processLine);
      return;
    }
    const reader = createInterface({
      input: createReadStream(spillPath, { encoding: "utf8" }),
      crlfDelay: Number.POSITIVE_INFINITY,
    });
    try {
      for await (const line of reader) await processLine(line);
    } finally {
      reader.close();
    }
  }

  /** One spill line → one resolved, capped, buffered file, then the write cadence. */
  private async processSpillLine(run: Pass2LoopRun, line: string): Promise<void> {
    if (!line) return;
    const extraction = parseSpillLine(line, run.processed);
    run.lastRelPath = extraction.relPath;
    const edges = this.cappedEdgesOf(extraction, run.symbolTable, run.processed);
    // A repeat relPath already has an entry pending in this batch — flush it
    // out first so the repeat starts its own transaction instead of sharing one
    // with its own earlier self (see `Pass2BulkWriteBuffer#bufferedRelPaths`).
    if (run.writes.holds(extraction.relPath)) await run.writes.dispatch(run.processed);
    // Buffer for the next bulk flush (fired at BULK_FILES / checkpoint / end)
    // instead of one transaction per file.
    run.writes.add(this.upsertEntryFor(extraction, edges));
    this.runState.stats.fileEdgeCount += edges.fileEdges.length;
    this.runState.stats.methodEdgeCount += edges.methodEdges.length;
    run.processed += 1;
    this.logProgress(run);
    await this.flushOnCadence(run);
  }

  /**
   * The file's resolved edges, or — past the cap — none. Past the cap the file
   * keeps its ROW and loses its edges (bd tea-rags-mcp-ihq7y): skipping the row
   * entirely left it without a hashed `cg_symbols_files` row, so the
   * incremental repair diff re-listed it on every run. The empty slice also
   * retires any edges the file persisted while it was still under the cap.
   */
  private cappedEdgesOf(extraction: FileExtraction, symbolTable: GlobalSymbolTable, processed: number): GraphEdges {
    const resolved = this.resolveOne(extraction, symbolTable, processed, extraction.relPath);
    return this.exceedsEdgeCap(resolved, extraction, processed) ? pathologicalFileGraphEdges() : resolved;
  }

  private upsertEntryFor(extraction: FileExtraction, edges: GraphEdges): BulkFileUpsertEntry {
    return {
      node: {
        relPath: extraction.relPath,
        language: extraction.language,
        // Stamp the row with the run's hash so the next run can tell a CURRENT
        // row from one that merely exists (bd tea-rags-mcp-6goqa). Undefined
        // persists as NULL, which the repair check reads as "unknown,
        // re-extract" rather than assuming the row is fresh.
        contentHash: this.runState.contentHashes?.get(extraction.relPath),
        // The file's type-abstractness census (bd tea-rags-mcp-r8hme.8); absent
        // persists as NULL — not measured.
        ...(extraction.typeAbstractness ? { typeAbstractness: extraction.typeAbstractness } : {}),
      },
      edges,
    };
  }

  /**
   * Per-N debug log so a slow run shows where it stalled — and, since bd
   * tea-rags-mcp-6aytq, WHAT it stalled in. Emitted as one JSON line (not an
   * inspected object) for two reasons: the phase split nests three levels deep,
   * past `console.error`'s default inspect depth, and a run killed at a
   * wall-clock budget leaves these lines as the only record of where its time
   * went — they have to be parseable.
   */
  private logProgress(run: Pass2LoopRun): void {
    const { processed } = run;
    if (processed % PROGRESS_EVERY !== 0 || !isDebug()) return;
    const elapsedMs = this.timings.elapsedMs();
    console.error(
      "[GitEnrich] PHASE: CODEGRAPH_PASS2_PROGRESS",
      JSON.stringify({
        processed,
        lastRelPath: run.lastRelPath,
        fileEdges: this.runState.stats.fileEdgeCount,
        methodEdges: this.runState.stats.methodEdgeCount,
        elapsedMs,
        filesPerSec: elapsedMs > 0 ? Math.round((processed / elapsedMs) * 1000 * 10) / 10 : 0,
        phases: this.timings.toSummary(),
        // What each language's run-scoped caches are doing, which wall clock
        // alone cannot say (bd tea-rags-mcp-6aytq): a TypeScript pass paying
        // per-entry `ts.createProgram` calls and one served entirely off the
        // whole-project Program differ by 4x and look identical in every other
        // field of this line.
        resolvers: this.resolutionRunner.resolverDiagnostics(),
      }),
    );
  }

  /** Dispatch a full batch, and on the checkpoint cadence land the window and CHECKPOINT. */
  private async flushOnCadence(run: Pass2LoopRun): Promise<void> {
    if (run.writes.size >= this.bulkFiles) await run.writes.dispatch(run.processed);
    if (run.processed % this.checkpointEvery !== 0) return;
    // Flush the buffered files before the checkpoint so the bounded WAL
    // reflects the whole processed window. Both steps are needed: the dispatch
    // settles the PREVIOUS window's write, the settle waits on this one — a
    // CHECKPOINT issued with a write still open would bound a WAL that does not
    // yet hold the window it claims to cover.
    await run.writes.dispatch(run.processed);
    await run.writes.settle();
    await this.checkpoint(run.graphDb);
  }

  /**
   * Flush the sub-batch remainder, wait for it to land, then a final checkpoint
   * for any files written since the last one.
   */
  private async finishPass(run: Pass2LoopRun): Promise<void> {
    await run.writes.dispatch(run.processed);
    await run.writes.settle();
    if (run.processed > 0 && run.processed % this.checkpointEvery !== 0) {
      await this.checkpoint(run.graphDb);
    }
  }

  /**
   * Resolve ONE file's edges, wrapping a resolver throw with file context so the
   * marker / stderr surfaces "at file #N (relPath)" instead of a bare position
   * counter.
   */
  private resolveOne(
    extraction: FileExtraction,
    symbolTable: GlobalSymbolTable,
    processed: number,
    lastRelPath: string,
  ): GraphEdges {
    const startedAtMs = Date.now();
    try {
      return this.resolutionRunner.resolve(extraction, symbolTable);
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      throw new CodegraphResolveError(
        processed,
        Object.assign(wrapped, {
          message: `resolveExtraction failed at file #${processed + 1} (${lastRelPath}): ${wrapped.message}`,
        }),
      );
    } finally {
      // Recorded on the throw path too: a file that burned 40s before failing
      // is exactly the file worth seeing in the split.
      this.timings.record("pass2", Date.now() - startedAtMs, { language: extraction.language });
    }
  }

  /**
   * True when this file's edge count is pathological (typically a minified JS
   * bundle). What counts is {@link GRAPH_EDGE_CAP_POLICY}'s decision, not this
   * method's. The drop is recorded so operators can surface it via the marker
   * log; the graph stays consistent because the row lands with NO edges rather
   * than a partial slice.
   */
  private exceedsEdgeCap(edges: GraphEdges, extraction: FileExtraction, processed: number): boolean {
    if (countCappedGraphEdges(edges) <= MAX_EDGES_PER_FILE) return false;
    if (isDebug()) {
      console.error("[GitEnrich] PHASE: CODEGRAPH_PASS2_SKIPPED_LARGE_FILE", {
        processed: processed + 1,
        relPath: extraction.relPath,
        language: extraction.language,
        ...countedGraphEdgesByKind(edges),
        cap: MAX_EDGES_PER_FILE,
      });
    }
    return true;
  }

  private async checkpoint(graphDb: GraphDbClient): Promise<void> {
    const startedAtMs = Date.now();
    try {
      await graphDb.checkpoint();
      // Rebuild cg_symbols_edges_file's target_rel_path index at the same
      // cadence as the DuckDB CHECKPOINT itself (tea-rags-mcp-wgt19). A run
      // short enough to never reach a checkpoint is also too short to have
      // meaningfully drifted this ART from the per-file DELETE+INSERT churn;
      // a long force-resolve/repair pass gets it refreshed periodically
      // instead of accumulating drift across the whole run. Best-effort:
      // this is a correctness safety net, not the checkpoint itself, so a
      // failure here should not abort a pass-2 run that otherwise succeeded.
      try {
        await graphDb.rebuildEdgeFileTargetIndex();
        // The DDL is its own WAL entry — flush it too, so an in-process
        // READ_ONLY reader (which reads the on-disk file, not this
        // connection's WAL) sees a consistent post-rebuild state instead of
        // racing the next checkpoint.
        await graphDb.checkpoint();
      } catch (err) {
        if (isDebug()) {
          console.error("[GitEnrich] PHASE: CODEGRAPH_EDGE_INDEX_REBUILD_FAILED", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    } catch (err) {
      throw new CodegraphCheckpointError(err instanceof Error ? err : undefined);
    } finally {
      // One unit covers the CHECKPOINT plus the ART rebuild it triggers — they
      // are one cadence and there is no way to pay for one without the other.
      this.timings.record("checkpoint", Date.now() - startedAtMs);
    }
  }

  /**
   * Slice 2 / B2 + B3 — recompute Tarjan SCC for both scopes and PageRank over
   * the method graph after the streaming pass-2 settles.
   *
   * Streaming variant: builds the adjacency one row at a time via
   * `graphDb.streamAdjacency` rather than `listAdjacency` so the adapter does
   * not pre-allocate a `Map<string, string[]>` of all edges (the prior code paid
   * this cost twice — once on the DuckDB side, once in the consumer). The
   * algorithms themselves still need full adjacency for the recursive DFS and
   * rank vector iteration, but skipping the intermediate copy is the pragmatic
   * minimum that still gives a meaningful win at slice-2 scale (25k method
   * edges). A spill-to-disk Tarjan is a future optimisation if real graphs grow
   * past JS-heap-friendly sizes.
   *
   * Errors are wrapped in `CodegraphMetricsError` so the prefetch marker carries
   * the failing stage in its message — a debug log alone is not enough when the
   * failure happens silently mid-run.
   */
  async recomputeMetrics(physicalCollectionName?: PhysicalCollectionName): Promise<void> {
    const startedAtMs = Date.now();
    try {
      await this.runMetricsRecompute(physicalCollectionName);
    } finally {
      // Timed around BOTH routes — the daemon delegation and the inline
      // Tarjan/PageRank — because from the run's point of view they are the
      // same stage, and which one ran is not what the wall clock is asking.
      this.timings.record("metrics", Date.now() - startedAtMs);
    }
  }

  /** The recompute itself; `recomputeMetrics` owns only its timing. */
  private async runMetricsRecompute(physicalCollectionName?: PhysicalCollectionName): Promise<void> {
    const { graphDb } = await this.resolveStore(physicalCollectionName);
    // Daemon-routed write path: the daemon owns the RW connection and runs
    // the (potentially 30 GB) SCC + PageRank build itself, so the MCP client
    // process never allocates the adjacency. When the handle exposes the
    // method (DaemonGraphDbClient) delegate and return; the in-process
    // DuckDbGraphClient leaves it undefined, falling through to the inline
    // path below (direct/test mode).
    //
    // Both routes fail the same way — a staged `CodegraphMetricsError` — so the
    // best-effort contract holds in either mode: a daemon-side failure (a
    // stream closed by a daemon teardown, bd tea-rags-mcp-sgo8v) leaves the
    // metrics stale instead of failing the run.
    if (graphDb.computeAndPersistCyclesAndSignals) {
      try {
        await graphDb.computeAndPersistCyclesAndSignals();
      } catch (err) {
        throw metricsFailure("daemon", err);
      }
      return;
    }
    try {
      const fileAdj = await collectAdjacency(graphDb, "file");
      const fileSccs = tarjanScc(fileAdj.adjacency);
      await graphDb.replaceCycles("file", fileSccs);

      const methodAdj = await collectAdjacency(graphDb, "method");
      const methodSccs = tarjanScc(methodAdj.adjacency);
      await graphDb.replaceCycles("method", methodSccs);

      // Tarjan stays unweighted (cycles are structural); PageRank is
      // confidence-weighted (bd tea-rags-mcp-s5ato) — mirrors the daemon's
      // computeAndPersistCyclesAndSignals in adapters/duckdb/daemon/server.ts.
      const rankResult = pageRank(methodAdj.adjacency, { weights: methodAdj.edgeWeights });
      await graphDb.replacePageRanks(rankResult.ranks);
    } catch (err) {
      throw metricsFailure(err instanceof CodegraphMetricsError ? "pagerank" : "tarjan", err);
    }
  }
}

/**
 * Non-fatal: data is consistent up to here, only metrics tables may be stale.
 * Surface as a typed error so the caller's debug log carries the stage; the
 * best-effort callers catch it and proceed.
 */
function metricsFailure(stage: CodegraphMetricsStage, err: unknown): CodegraphMetricsError {
  if (process.env.DEBUG === "true") {
    process.stderr.write(`[codegraph] post-extract metric recompute failed: ${(err as Error).message}\n`);
  }
  return new CodegraphMetricsError(stage, err instanceof Error ? err : undefined);
}
