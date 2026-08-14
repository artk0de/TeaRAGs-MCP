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
import { pageRank } from "../../../../infra/graph/page-rank.js";
import { tarjanScc } from "../../../../infra/graph/tarjan-scc.js";
import { isDebug } from "../../../../infra/runtime.js";
import {
  CodegraphCheckpointError,
  CodegraphMetricsError,
  CodegraphResolveError,
  CodegraphSpillIoError,
} from "../../errors.js";
import { CodegraphPhaseTimings } from "./phase-timings.js";
import type { CallEdgeResolutionRunner } from "./resolution-runner.js";
import type { CodegraphRunState } from "./run-state.js";

/** Files processed between DuckDB checkpoints — keeps the WAL bounded. */
const CHECKPOINT_EVERY = 500;
/** Files between progress logs so a slow run shows where it stalled. */
const PROGRESS_EVERY = 100;
/**
 * Cardinality cap per single upsertFile transaction. Minified JS/TS bundles
 * (Vite/Nuxt/Webpack build artefacts that should really live behind .gitignore
 * but sometimes don't) can produce tens of thousands of method edges in one file
 * — DuckDB blows past its memory_limit trying to commit a single transaction
 * with that many INSERTs. Skipping these files is safe: a minified bundle has no
 * resolvable cross-file graph semantics anyway, and letting one pathological row
 * abort pass-2 wipes hours of work for the entire project. Cap chosen by
 * inspection of the ugnest failure (file with 96k method edges OOM'd at 1.8GB).
 */
const MAX_EDGES_PER_FILE = 10000;
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

/** Resolve the (graphDb, symbolTable) pair for the active collection. */
export type GraphStoreResolver = (
  collectionName?: string,
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
    private readonly resolutionRunner: CallEdgeResolutionRunner,
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
   */
  async resolveAndUpsert(spillPath: string, collectionName?: string): Promise<void> {
    const { graphDb, symbolTable } = await this.resolveStore(collectionName);
    let processed = 0;
    let lastRelPath: string | null = null;
    let reader: ReturnType<typeof createInterface> | null = null;
    let buffer: BulkFileUpsertEntry[] = [];
    // Tracks which relPaths already have a pending entry in `buffer` — a file
    // can legitimately reach the spill twice (re-walking mid-run is a
    // supported, tested scenario; symbolTable.upsertFile replaces rather than
    // appends for exactly this reason), but two entries for the SAME relPath
    // must never land in one `upsertFilesBulk` transaction: the table's
    // PRIMARY KEY is (source, target), and DuckDB does not reject a same-key
    // double-INSERT gracefully — it aborts with a native FatalException and
    // takes the daemon process down mid-request (tea-rags-mcp-ksfq1,
    // live-reproduced against taxdome). Cleared on every flush alongside the
    // buffer it tracks.
    let bufferedRelPaths = new Set<string>();
    const flushBuffer = async (): Promise<void> => {
      const pending = buffer;
      buffer = [];
      bufferedRelPaths = new Set();
      await this.flushBuffer(graphDb, pending, processed);
    };
    try {
      reader = createInterface({
        input: createReadStream(spillPath, { encoding: "utf8" }),
        crlfDelay: Number.POSITIVE_INFINITY,
      });
      for await (const line of reader) {
        if (!line) continue;
        let extraction: FileExtraction;
        try {
          extraction = JSON.parse(line) as FileExtraction;
        } catch (err) {
          const wrapped = err instanceof Error ? err : new Error(String(err));
          throw new CodegraphResolveError(
            processed,
            Object.assign(wrapped, {
              message: `JSON.parse failed on spill line at file #${processed + 1}: '${snippet(line)}': ${wrapped.message}`,
            }),
          );
        }
        lastRelPath = extraction.relPath;
        const edges = this.resolveOne(extraction, symbolTable, processed, lastRelPath);
        if (this.exceedsEdgeCap(edges, extraction, processed)) {
          processed += 1;
          continue;
        }
        // A repeat relPath already has an entry pending in this batch — flush
        // it out first so the repeat starts its own transaction instead of
        // sharing one with its own earlier self (see `bufferedRelPaths` above).
        if (bufferedRelPaths.has(extraction.relPath)) await flushBuffer();
        // Buffer for the next bulk flush (fired at BULK_FILES / checkpoint / end)
        // instead of one transaction per file.
        buffer.push({
          node: {
            relPath: extraction.relPath,
            language: extraction.language,
            // Stamp the row with the run's hash so the next run can tell a
            // CURRENT row from one that merely exists (bd tea-rags-mcp-6goqa).
            // Undefined persists as NULL, which the repair check reads as
            // "unknown, re-extract" rather than assuming the row is fresh.
            contentHash: this.runState.contentHashes?.get(extraction.relPath),
          },
          edges,
        });
        bufferedRelPaths.add(extraction.relPath);
        this.runState.stats.fileEdgeCount += edges.fileEdges.length;
        this.runState.stats.methodEdgeCount += edges.methodEdges.length;
        processed += 1;
        // Per-N debug log so a slow run shows where it stalled — and, since
        // bd tea-rags-mcp-6aytq, WHAT it stalled in. Emitted as one JSON line
        // (not an inspected object) for two reasons: the phase split nests
        // three levels deep, past `console.error`'s default inspect depth, and
        // a run killed at a wall-clock budget leaves these lines as the only
        // record of where its time went — they have to be parseable.
        if (processed % PROGRESS_EVERY === 0 && isDebug()) {
          const elapsedMs = this.timings.elapsedMs();
          console.error(
            "[GitEnrich] PHASE: CODEGRAPH_PASS2_PROGRESS",
            JSON.stringify({
              processed,
              lastRelPath,
              fileEdges: this.runState.stats.fileEdgeCount,
              methodEdges: this.runState.stats.methodEdgeCount,
              elapsedMs,
              filesPerSec: elapsedMs > 0 ? Math.round((processed / elapsedMs) * 1000 * 10) / 10 : 0,
              phases: this.timings.toSummary(),
            }),
          );
        }
        if (buffer.length >= this.bulkFiles) await flushBuffer();
        if (processed % this.checkpointEvery === 0) {
          // Flush the buffered files before the checkpoint so the bounded WAL
          // reflects the whole processed window.
          await flushBuffer();
          await this.checkpoint(graphDb);
        }
      }
      // Flush the sub-batch remainder, then a final checkpoint for any files
      // written since the last one.
      await flushBuffer();
      if (processed > 0 && processed % this.checkpointEvery !== 0) {
        await this.checkpoint(graphDb);
      }
    } catch (err) {
      if (
        err instanceof CodegraphResolveError ||
        err instanceof CodegraphCheckpointError ||
        err instanceof CodegraphSpillIoError
      ) {
        throw err;
      }
      // Catch-all wrap: include last-seen file in the cause message so
      // the propagated marker tells the operator WHERE the loop tripped.
      const wrapped = err instanceof Error ? err : new Error(String(err));
      throw new CodegraphResolveError(
        processed,
        Object.assign(wrapped, {
          message: `loop fatal after ${processed} files (last seen: ${lastRelPath ?? "<none>"}): ${wrapped.message}`,
        }),
      );
    } finally {
      reader?.close();
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
   * bundle). The skip is recorded so operators can surface it via the marker
   * log; the graph stays consistent because no partial state landed for the row.
   */
  private exceedsEdgeCap(edges: GraphEdges, extraction: FileExtraction, processed: number): boolean {
    const totalEdges = edges.fileEdges.length + edges.methodEdges.length;
    if (totalEdges <= MAX_EDGES_PER_FILE) return false;
    if (isDebug()) {
      console.error("[GitEnrich] PHASE: CODEGRAPH_PASS2_SKIPPED_LARGE_FILE", {
        processed: processed + 1,
        relPath: extraction.relPath,
        language: extraction.language,
        fileEdges: edges.fileEdges.length,
        methodEdges: edges.methodEdges.length,
        cap: MAX_EDGES_PER_FILE,
      });
    }
    return true;
  }

  /**
   * Flush the buffered files as ONE transaction. The per-file edge cap already
   * dropped pathological files, so no single row can abort a batch. A
   * batch-level failure surfaces batch size + last file so the marker / stderr
   * still points near where pass-2 tripped.
   */
  private async flushBuffer(graphDb: GraphDbClient, pending: BulkFileUpsertEntry[], processed: number): Promise<void> {
    if (pending.length === 0) return;
    const startedAtMs = Date.now();
    try {
      await graphDb.upsertFilesBulk(pending);
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      throw new CodegraphResolveError(
        processed,
        Object.assign(wrapped, {
          message: `graphDb.upsertFilesBulk failed near file #${processed} (batch=${pending.length}, last=${pending[pending.length - 1]?.node.relPath}): ${wrapped.message}`,
        }),
      );
    } finally {
      this.timings.record("flush", Date.now() - startedAtMs);
    }
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
  async recomputeMetrics(collectionName?: string): Promise<void> {
    const startedAtMs = Date.now();
    try {
      await this.runMetricsRecompute(collectionName);
    } finally {
      // Timed around BOTH routes — the daemon delegation and the inline
      // Tarjan/PageRank — because from the run's point of view they are the
      // same stage, and which one ran is not what the wall clock is asking.
      this.timings.record("metrics", Date.now() - startedAtMs);
    }
  }

  /** The recompute itself; `recomputeMetrics` owns only its timing. */
  private async runMetricsRecompute(collectionName?: string): Promise<void> {
    const { graphDb } = await this.resolveStore(collectionName);
    // Daemon-routed write path: the daemon owns the RW connection and runs
    // the (potentially 30 GB) SCC + PageRank build itself, so the MCP client
    // process never allocates the adjacency. When the handle exposes the
    // method (DaemonGraphDbClient) delegate and return; the in-process
    // DuckDbGraphClient leaves it undefined, falling through to the inline
    // path below (direct/test mode).
    if (graphDb.computeAndPersistCyclesAndSignals) {
      await graphDb.computeAndPersistCyclesAndSignals();
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
      // Non-fatal: data is consistent up to here, only metrics tables
      // may be stale. Surface as a typed error so the caller's debug
      // log carries the stage; the prefetch path catches and proceeds.
      if (process.env.DEBUG === "true") {
        process.stderr.write(`[codegraph] post-extract metric recompute failed: ${(err as Error).message}\n`);
      }
      throw new CodegraphMetricsError(
        err instanceof CodegraphMetricsError ? "pagerank" : "tarjan",
        err instanceof Error ? err : undefined,
      );
    }
  }
}
