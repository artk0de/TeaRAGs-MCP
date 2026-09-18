/**
 * The codegraph `ExtractionSink` the chunker writes to (bd tea-rags-mcp-6vfrj / G2).
 *
 * Slice 2 chunked-flush ingest. Three rules that replaced the prior
 * "buffer until finish" model and lifted the indexing memory ceiling:
 *
 *  1. Symbol definitions are persisted on EVERY write — to the in-memory
 *     `symbolTable` AND (via the node-flush queue) DuckDB. The resolver in
 *     pass-2 needs the full cross-file symbol set, so this cannot be deferred
 *     to finish().
 *  2. The raw `FileExtraction` is appended to an NDJSON spill file on disk. The
 *     JS heap only holds the current row; the parsed tree-sitter AST and
 *     intermediate buffers can be reclaimed immediately after `write` returns.
 *     For ugnest-scale runs (5574 files) this is the load-bearing optimisation
 *     — the prior in-memory `FileExtraction[]` held every extraction's
 *     chunk/call arrays simultaneously.
 *  3. `finish()` drives the pass-2 stages, which read the spill back
 *     line-by-line, resolve calls, issue bulk upserts, and CHECKPOINT every N
 *     files. This keeps the DuckDB WAL bounded throughout the pass.
 *
 * `finish()` DISPATCHES the node-flush remainder and then runs pass-2 against
 * it, settling the chain before the metric recompute rather than before the
 * resolve (bd pass1-fanout). Once the extraction fan-out halved pass-1 on
 * taxdome, the drain stopped being hidden behind the parse and became the
 * serial tail: 24.1s of back-to-back `CODEGRAPH_NODES_FLUSH` between the last
 * extraction and the first `PASS2_PROGRESS`, which is why the Ruby codegraph
 * window regressed 51.9s → 59.9s on a pass-1 that itself went 18.8s → 9.1s.
 * `CODEGRAPH_NODE_DRAIN_OVERLAP=0` restores the blocking barrier.
 */

import { once } from "node:events";
import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname as pathDirname } from "node:path";

import { spillLiveMarkerPath } from "../../../../adapters/duckdb/spill-files.js";
import type {
  CodegraphPass1FileAggregates,
  ExtractionSink,
  FileExtraction,
  GlobalSymbolTable,
  SymbolDefinition,
} from "../../../../contracts/types/codegraph.js";
import type { PhysicalCollectionName } from "../../../../contracts/types/collection-identity.js";
import type { FileExtractionAbsorbRole } from "../../../../contracts/types/provider.js";
import { CodegraphMetricsError, CodegraphSpillIoError } from "../../errors.js";
import { normalizeInheritanceEdges } from "./inheritance-edges.js";
import type { SymbolNodeFlushQueue } from "./node-flush.js";
import type { CodegraphRunState } from "./run-state.js";
import { extractSelfDispatchMethods } from "./self-dispatch-discovery.js";

export interface CodegraphSinkDeps {
  /** Resolve the in-memory symbol table for the active collection. */
  resolveSymbolTable: (collectionName?: PhysicalCollectionName) => Promise<GlobalSymbolTable>;
  /**
   * Read back every persisted per-file pass-1 aggregate slice for the active
   * collection (bd tea-rags-mcp-znxg8). Absorbed at the barrier for the files
   * this run did NOT walk, so an incremental run resolves against a project-wide
   * ancestry / self-dispatch registry rather than a batch-sized one — the
   * asymmetry that degraded concrete service entry calls onto the shared
   * template they inherit.
   */
  loadPersistedPass1Aggregates: (collectionName?: PhysicalCollectionName) => Promise<CodegraphPass1FileAggregates[]>;
  runState: CodegraphRunState;
  nodeFlush: SymbolNodeFlushQueue;
  /** Map a `FileExtraction` to the 9-field `SymbolDefinition` shape. */
  buildSymbolDefs: (extraction: FileExtraction) => SymbolDefinition[];
  /** Index this file's (startLine -> symbolId) map for the deferred chunk pass. */
  indexChunkSymbolsByLine: (collectionName: string | undefined, extraction: FileExtraction) => void;
  /** Collection key (`__direct__` sentinel in direct/test mode). */
  collectionKey: (collectionName?: string) => string;
  /** Per-run NDJSON output spill path. */
  spillPathFor: (collectionName: string | undefined, runId: string) => string;
  /**
   * Pass-2 stages. Passed as callbacks rather than a finalizer handle so the
   * provider stays the single place that decides how pass-2 is dispatched.
   */
  resolveAndUpsert: (spillPath: string, collectionName?: PhysicalCollectionName) => Promise<void>;
  recomputeMetrics: (collectionName?: PhysicalCollectionName) => Promise<void>;
}

/**
 * What `finish` is asked to close besides pass-2 (bd tea-rags-mcp-sgo8v).
 *
 * `recomputeMetrics: false` leaves cycles and PageRank to the caller: under
 * language affinity several sinks resolve into ONE graph concurrently, and a
 * metric computed when THIS sink's pass-2 ends is computed over whatever the
 * other partitions have not written yet. Absent means the one-sink run, which
 * recomputes as it always did.
 */
export interface CodegraphSinkFinishOptions {
  recomputeMetrics?: boolean;
}

/**
 * The codegraph run sink: the `ExtractionSink` contract plus the two things
 * only a language partition needs from it (bd tea-rags-mcp-sgo8v).
 */
export interface CodegraphExtractionSink extends ExtractionSink {
  /**
   * Absorb the pass-1 STATE of a file another partition owns — symbol-table
   * entry, run-global aggregates, inheritance rows — and nothing it would own:
   * no node write, no walk ranges, no spill line, no count. The same merge
   * `write` performs, so the two cannot drift apart.
   */
  mirror: (extraction: FileExtraction) => Promise<void>;
  finish: (options?: CodegraphSinkFinishOptions) => Promise<void>;
}

/**
 * Build an `ExtractionSink` bound to the active collection. The sink captures
 * the per-collection routing so all downstream `write`/`finish` calls land in
 * the right DuckDB file.
 *
 * `collectionName` is optional in direct mode (test fixtures), but MUST be
 * supplied in pool mode (production bootstrap) — the provider's store resolution
 * fails loud otherwise.
 *
 * `skipDurableNodeWrite` — when true, `write` still builds the in-memory symbol
 * table + line map + run-global aggregates but SKIPS buffering the durable node
 * write, because it was already issued by the eager batched flush. The
 * cross-pass drain passes true; the incremental path leaves it false.
 */
export function createCodegraphExtractionSink(
  deps: CodegraphSinkDeps,
  runId: string,
  collectionName?: PhysicalCollectionName,
  skipDurableNodeWrite = false,
): CodegraphExtractionSink {
  // The spill path is `<dataDir>/codegraph/.spill/<coll>-<runId>.ndjson` —
  // `runId` is unique per sink so concurrent ingest passes (rare but possible
  // across collections) get unique files. Spill files left by a CRASHED run are
  // reclaimed by the sweep every pool construction runs; a live one is spared by
  // the `.live` marker written in `ensureSpillStream` below.
  const spillPath = deps.spillPathFor(collectionName, runId);
  // Read once per sink — i.e. once per run — so a test can stub it and a run
  // cannot change its mind halfway through `finish`.
  const overlapNodeDrain = process.env.CODEGRAPH_NODE_DRAIN_OVERLAP !== "0";
  let spillStream: WriteStream | null = null;
  let spillWriteCount = 0;
  let finished = false;

  const ensureSpillStream = async (): Promise<WriteStream> => {
    if (spillStream) return spillStream;
    try {
      await mkdir(pathDirname(spillPath), { recursive: true });
      // Claim the spill BEFORE it exists (bd tea-rags-mcp-v6gxr). Every pool
      // built while this run is in flight — an unpinned fan-out worker's, the
      // daemon's, a second CLI run's — sweeps this directory on construction,
      // and the marker's pid is the only thing that tells it apart from the
      // residue of a crashed run. Written first so the ordering never leaves an
      // unclaimed spill on disk. `spillLiveMarkerPath` is the pool's, so the
      // writer and the sweeper cannot disagree about the name.
      await writeFile(spillLiveMarkerPath(spillPath), `${process.pid}`, "utf8");
      spillStream = createWriteStream(spillPath, { encoding: "utf8" });
    } catch (err) {
      throw new CodegraphSpillIoError(spillPath, "open", err instanceof Error ? err : undefined);
    }
    return spillStream;
  };

  const cleanupSpill = async (): Promise<void> => {
    // Best-effort: unlink the spill regardless of success/failure so a failed
    // run does not leak GBs of NDJSON. ENOENT means a prior cleanup already
    // happened (idempotent), all other errors are swallowed because the pool
    // init re-purges on next process start anyway. The marker goes with it —
    // left behind, it would pin a spill that no longer exists to a pid that
    // outlives it.
    await rm(spillPath, { force: true }).catch(() => undefined);
    await rm(spillLiveMarkerPath(spillPath), { force: true }).catch(() => undefined);
  };

  const assertOpen = (method: string): void => {
    if (finished) {
      // Caller bug — write after finish. Surface as a programming error so
      // the test path catches it; a typed error is overkill for an invariant.
      throw new Error(`CodegraphEnrichmentProvider sink: ${method}() called after finish()`);
    }
  };

  /**
   * The pass-1 STATE of one file, shared by `write` (a file this sink owns) and
   * `mirror` (a file another language partition owns): the in-memory symbol
   * table entry, the run-global aggregates and the inheritance rows. Everything
   * pass-2 resolves AGAINST, and nothing it writes.
   */
  const absorbPass1State = (
    extraction: FileExtraction,
    symbolTable: GlobalSymbolTable,
    defs: SymbolDefinition[],
    role: FileExtractionAbsorbRole,
  ): void => {
    // The in-memory table is the resolver's source of truth during the run;
    // the durable copy (`write` buffers it) exists for a later run's hydration.
    symbolTable.upsertFile(extraction.relPath, defs);
    // Merge this file's pass-1 aggregates (ancestors, return types, dispatch
    // tables, instantiations, …) into the run-global state so pass-2 resolves
    // against the whole run regardless of which file declared what. Ruby-only
    // for the self-dispatch candidates (DEFECT 2) — the entry strategy that
    // consumes the discovered map is Ruby.
    deps.runState.absorb(
      extraction,
      extraction.language === "ruby" ? extractSelfDispatchMethods(extraction.chunks) : [],
      role,
    );
    // Accumulate this file's inheritance edges run-global (bd tea-rags-mcp-o17v2)
    // so the pass-1→pass-2 barrier can build a complete hierarchy view for the
    // CHA cone resolver. Resolving ancestor symbol_ids against the now-partial
    // table is unnecessary here — the cone reads by fqName — so pass a null
    // resolver and let the per-file persist (pass-2) own symbol_id binding.
    const inheritanceRows = normalizeInheritanceEdges(extraction, () => null);
    if (inheritanceRows.length > 0) deps.runState.inheritanceRows.push(...inheritanceRows);
  };

  return {
    mirror: async (extraction) => {
      assertOpen("mirror");
      const symbolTable = await deps.resolveSymbolTable(collectionName);
      absorbPass1State(extraction, symbolTable, deps.buildSymbolDefs(extraction), "mirror");
    },
    write: async (extraction) => {
      assertOpen("write");
      const symbolTable = await deps.resolveSymbolTable(collectionName);
      const defs = deps.buildSymbolDefs(extraction);
      // Persist defs to both the in-memory table (for in-pass resolver lookups)
      // AND DuckDB (for cold-start hydration of a later partial reindex).
      // Streaming the symbols rather than batching at finish means the resolver
      // in pass-2 can resolve calls into files that were walked earlier in
      // pass-1 even when those rows already landed; the in-memory table is the
      // source of truth during the run, DuckDB is the durable copy.
      //
      // On the cross-pass drain the durable copy was already written by the
      // eager batched flush, so `skipDurableNodeWrite` suppresses the
      // (idempotent) per-file re-write here; the in-memory table build stays
      // unconditional (the resolver needs it in this context).
      absorbPass1State(extraction, symbolTable, defs, "own");
      if (!skipDurableNodeWrite) {
        deps.nodeFlush.buffer(extraction.relPath, defs, deps.collectionKey(collectionName), collectionName);
      }
      deps.indexChunkSymbolsByLine(collectionName, extraction);

      const stream = await ensureSpillStream();
      const line = `${JSON.stringify(extraction)}\n`;
      const ok = stream.write(line);
      if (!ok) {
        // Back-pressure — wait for the drain event before the next write
        // returns. Prevents a fast walker from filling the OS pipe and
        // ballooning kernel buffers.
        try {
          await once(stream, "drain");
        } catch (err) {
          throw new CodegraphSpillIoError(spillPath, "write", err instanceof Error ? err : undefined);
        }
      }
      spillWriteCount += 1;
      deps.runState.stats.extractedFiles += 1;
    },
    finish: async (options) => {
      finished = true;
      const key = deps.collectionKey(collectionName);
      // Hand the buffered node defs to the flush chain. Owning it here makes the
      // sink self-contained — correct for every caller (incremental finalize,
      // standalone sink, cross-pass drain where the buffer is already empty so
      // this no-ops).
      //
      // Whether pass-2 then WAITS for that chain is the one thing
      // `CODEGRAPH_NODE_DRAIN_OVERLAP` decides. It does not have to: pass-2
      // resolves against the in-memory symbol table and writes only
      // `cg_symbols_files` and the edge / inheritance / fan-out tables — it
      // never reads or writes `cg_symbols`, and the schema declares no foreign
      // keys (migration 001 omits them deliberately and says why). So
      // "nodes-before-edges" is a statement about the run's end state, which the
      // settle below still guarantees, not a precondition of the resolve.
      deps.nodeFlush.dispatchRemainder(key, collectionName);
      try {
        // The kill-switch shape: settle the whole chain here and pass-2 starts
        // against a fully durable `cg_symbols`, exactly as it did before.
        if (!overlapNodeDrain) await deps.nodeFlush.settle();
        const streamToClose = spillStream;
        if (streamToClose) {
          // Close the writable end before the reader opens it. `end` takes a
          // callback and finishes the file with a final flush.
          await new Promise<void>((resolve, reject) => {
            streamToClose.end((err?: Error | null) => {
              if (err) reject(new CodegraphSpillIoError(spillPath, "write", err));
              else resolve();
            });
          });
        }
        // Pass-1→pass-2 barrier (bd tea-rags-mcp-o17v2 + cai0/2oky5 + DEFECT 2):
        // pass-1 is complete, so the run-global maps are frozen. Build the
        // hierarchy view + reverse include-by index ONCE and discover the
        // self-dispatch templates; pass-2 threads all three into every resolve
        // `CallContext`. The symbol table is resolved lazily — only the
        // self-dispatch branch needs it, so a run without candidates pays no
        // extra pool acquire.
        //
        // The persisted pass-1 slices (bd tea-rags-mcp-znxg8) are absorbed
        // INSIDE `seal`, ahead of all three, because all three are computed from
        // the maps they feed. This run walked a batch; the registry has to
        // describe the project, or a concrete `Service.call` whose template file
        // was not in the batch degrades onto that template.
        await deps.runState.seal(
          async () => deps.resolveSymbolTable(collectionName),
          async () => deps.loadPersistedPass1Aggregates(collectionName),
        );
        if (spillWriteCount > 0) {
          await deps.resolveAndUpsert(spillPath, collectionName);
        }
        // The real nodes-before-metrics point. A latched flush error surfaces
        // here instead of before pass-2: the run still aborts on it, one stage
        // later, having spent that stage on work the failure does not invalidate
        // (the edge tables are reconciled per source file on the next pass).
        await deps.nodeFlush.settle();
        // Metric recompute is best-effort by contract: data integrity is
        // preserved by the resolve+upsert stage; only cycle / pagerank freshness
        // is at stake. A failure there degrades find_cycles and rerank rather
        // than aborting the index pass, so we swallow CodegraphMetricsError
        // after the debug log the helper itself emits. Other error types (spill
        // IO, resolve) DO propagate from the stage above. A language partition
        // leaves the recompute to the collection's completion owner.
        if (options?.recomputeMetrics !== false) {
          await recomputeCodegraphMetricsBestEffort(async () => deps.recomputeMetrics(collectionName));
        }
      } finally {
        // A dispatched node write must never outlive `finish`. On the success
        // path this already settled; on a throw path it lets the chain land
        // before the error propagates, so the run is not torn down with a
        // `cg_symbols` transaction still open. Its own latched error is
        // swallowed HERE on purpose — whatever brought us to the `finally` is
        // the root cause and must be the error that surfaces. Mirrors
        // `GraphBuildFinalizer#resolveAndUpsert`'s closing `settleFlush`.
        await deps.nodeFlush.settle().catch(() => undefined);
        await cleanupSpill();
      }
    },
  };
}

/**
 * Recompute cycles and PageRank, best-effort: a `CodegraphMetricsError` is
 * swallowed (the helper already logged the failing stage) because only metric
 * FRESHNESS is at stake — the edges it reads are already durable. Any other
 * error propagates. Shared by the one-sink `finish` and the language
 * partition that owns collection completion (bd tea-rags-mcp-sgo8v), so the
 * two cannot disagree on what "best effort" means.
 */
export async function recomputeCodegraphMetricsBestEffort(recompute: () => Promise<void>): Promise<void> {
  try {
    await recompute();
  } catch (err) {
    if (!(err instanceof CodegraphMetricsError)) throw err;
  }
}
