/**
 * Finalize seam of the codegraph symbols provider: the steps
 * `CodegraphEnrichmentProvider#finalizeSignals` (and the standalone
 * `buildFileSignals` walk) run around the pass-2 barrier — drain the cross-pass
 * input spill, read file overlays off the finished graph, persist the run's
 * resolve tally. The provider owns the ordering and the per-run state; these
 * functions own the mechanics.
 */

import { createReadStream, existsSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";

import type {
  ExtractionSink,
  FileExtraction,
  FileGraphMetrics,
  GraphDbClient,
} from "../../../../contracts/types/codegraph.js";
import type { EnrichmentRunCoverage, FileSignalOverlay } from "../../../../contracts/types/provider.js";
import { buildCodegraphFileSignals } from "./payload-signals.js";
import type { CodegraphRunState } from "./run-state.js";

/**
 * Files per `getFileMetricsBulk` request in the finalize read-back (bd
 * tea-rags-mcp-6aytq). The read-back is DAEMON-CPU-bound, not latency-bound: the
 * setwise op costs three statements per batch where per-file reads cost three per
 * file and queue the concurrent pass-2 flush behind them. A larger batch grows the
 * request frame and the recursive CTE's live intermediate; 2000 sits mid-plateau
 * of the measured cost curve.
 */
const OVERLAY_READ_BATCH = 2000;

/** Reading of a root the graph has no edge for, in either direction. */
const ZERO_FILE_METRICS: FileGraphMetrics = { fanIn: 0, fanOut: 0, transitiveImpact: 0 };

/**
 * yl9tv Task 5b — WORKER-side drain of the cross-pass input spill: each line
 * goes through the run sink exactly as a re-parsed file would (symbol table,
 * run-global merges, output spill, line map), then the spill is removed. The
 * caller finishes the sink. A missing spill is a no-op and opens no sink.
 *
 * `openRunSink` must return the run's sink with its durable node write SKIPPED
 * (it was hoisted into `acceptExtraction`'s eager flush); `flushNodeRemainder`
 * runs before any line is written, so `cg_symbols` is durable before pass-2.
 */
export async function drainCrossPassInputSpill(
  spillPath: string,
  openRunSink: () => { sink: ExtractionSink; extracted: Set<string> },
  flushNodeRemainder: () => Promise<void>,
): Promise<void> {
  // Nothing fed this run: leave the sink uncreated so finalize reads back zero
  // overlays. Guarded up front because `createReadStream` surfaces ENOENT
  // asynchronously on the stream.
  if (!existsSync(spillPath)) return;
  const { sink, extracted } = openRunSink();
  // Flush the buffered node remainder + await the chain + rethrow BEFORE the
  // drain, so `cg_symbols` is fully durable before pass-2.
  await flushNodeRemainder();
  const reader = createInterface({
    input: createReadStream(spillPath, { encoding: "utf8" }),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  // bd tea-rags-mcp-yl9tv — the spill is appended in non-deterministic
  // file-COMPLETION order, so buffer and SORT by relPath before resolving: every
  // last-write-wins run-global merge and the resolve tally must be reproducible.
  // One line per file (deduped at accept), so the buffer is bounded by file count.
  const extractions: FileExtraction[] = [];
  try {
    for await (const line of reader) {
      if (!line) continue;
      try {
        extractions.push(JSON.parse(line) as FileExtraction);
      } catch {
        continue; // skip a corrupt line rather than abort the whole drain
      }
    }
  } finally {
    reader.close();
    rmSync(spillPath, { force: true });
  }
  extractions.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  for (const extraction of extractions) {
    if (extracted.has(extraction.relPath)) continue;
    await sink.write(extraction);
    extracted.add(extraction.relPath);
  }
}

/**
 * Read file-level overlays for `overlayPaths` from the finished graph into
 * `out`, shared by `buildFileSignals` and `finalizeSignals`. `fanInP95` comes
 * from the FULL graph, not the subset, so `isHub` is not misclassified on an
 * incremental run. Bare inner keys under providerKey `codegraph.symbols.file`
 * (tea-rags-mcp-k6xu).
 */
export async function readCodegraphFileOverlays(
  graphDb: GraphDbClient,
  overlayPaths: string[],
  out: Map<string, FileSignalOverlay>,
): Promise<void> {
  const fanInP95 = await graphDb.getFanInP95();
  // Batches go out in order and each is walked in the caller's order, so the
  // map this fills keeps `overlayPaths` order exactly. A root the graph knows
  // nothing about is absent from the bulk map and reads as all-zero — the
  // same value the per-file getters returned for it.
  for (let start = 0; start < overlayPaths.length; start += OVERLAY_READ_BATCH) {
    const batch = overlayPaths.slice(start, start + OVERLAY_READ_BATCH);
    const metrics = await graphDb.getFileMetricsBulk(batch);
    for (const relPath of batch) {
      // Shared with `CodegraphPayloadHealer` (bd tea-rags-mcp-a2ddb) — the
      // heal writes the same keys for files this pass never names, so the
      // arithmetic has exactly one home.
      out.set(relPath, buildCodegraphFileSignals(metrics.get(relPath) ?? ZERO_FILE_METRICS, fanInP95));
    }
  }
}

/**
 * Persist the run's resolve tally (bd tea-rags-mcp-2jet-D, per-file since bd
 * tea-rags-mcp-xpmwg). Reads the tally without resetting it —
 * `CodegraphEnrichmentProvider#getRunMetrics` owns read-and-clear.
 */
export async function persistRunResolveStats(
  runState: CodegraphRunState,
  graphDb: GraphDbClient,
  runCoverage: EnrichmentRunCoverage,
): Promise<void> {
  const files = runState.toFileResolveStatsEntries();
  // Nothing resolved: no file's rows to replace, no language to cover.
  if (files.length === 0) return;
  const wholeCorpus = runCoverage === "wholeCorpus";

  // The legacy per-language measurement, written by whole-corpus runs ONLY: it
  // replaces a language's rows wholesale, so an incremental run would replace the
  // corpus breakdown with its batch (bd tea-rags-mcp-xpmwg).
  //
  // The "no call site attempted → keep the previous rows" guard protects only
  // this wholesale write: call-free files yield ALL-ZERO rows that would erase
  // the last real measurement (bd tea-rags-mcp-snbzk). It must NOT gate the
  // per-file write below — a file whose calls were all removed must replace its
  // rows with none, or the aggregate keeps counting calls that no longer exist.
  if (wholeCorpus) {
    const rows = runState.toResolveRunStatsRows();
    if (rows.some((r) => r.attempted > 0)) await graphDb.recordRunStats(rows);
  }

  // Every resolved file's rows, plus — for a whole-corpus run only — the
  // languages they cover, in one transaction. Coverage switches a language's
  // read from `cg_run_stats` to the per-file aggregate, which describes only what
  // incrementals touched until a whole-corpus run writes it.
  await graphDb.recordFileResolveStats({
    files,
    completeLanguages: wholeCorpus ? [...new Set(files.map((f) => f.language))] : [],
  });
}
