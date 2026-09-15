/**
 * Chunk-signals seam of the codegraph symbols provider: the deferred pass that
 * turns stored chunks into `codegraph.symbols.chunk.*` overlays once the graph is
 * finished, and rewrites the symbol→covering-chunk join.
 *
 * Every chunk settles through `settleCodegraphChunkSignals` over an explicit
 * range source (bd tea-rags-mcp-39xca.2); this module decides only which source a
 * file gets and records the walk's ranges it reads.
 */

import type { Ignore } from "ignore";

import type {
  FileExtraction,
  GraphDbClient,
  SymbolChunkIdJoinEntry,
  SymbolId,
  SymbolLineRange,
} from "../../../../contracts/types/codegraph.js";
import type { ChunkLookupEntry, ChunkSignalOverlay } from "../../../../contracts/types/provider.js";
import { isDebug } from "../../../../infra/runtime.js";
import {
  CodegraphChunkSettlementTally,
  settleCodegraphChunkSignals,
  toChunkSignalOverlays,
  type CodegraphChunkRangeSource,
} from "./chunk-signal-settlement.js";
import { CODEGRAPH_SUPPORTED_EXTENSIONS, extensionOf } from "./file-extractor.js";

/**
 * Computes deferred chunk overlays for one provider instance.
 */
export class CodegraphChunkSignalPass {
  constructor(
    /**
     * `collectionKey → relPath → walked symbol line ranges`, the input of the
     * chunk-owner rule (bd tea-rags-mcp-9i2ow). Held by reference: the provider
     * resets a collection at run start, drops deleted files and clears it on
     * release, and this pass writes and reads it.
     */
    private readonly walkRangesByCollection: Map<string, Map<string, SymbolLineRange[]>>,
    /** The provider's codegraph-layer ignore filter — the same instance its policy reads. */
    private readonly exclusionFilter: Ignore,
  ) {}

  /**
   * Record one walked file's symbol ranges (1-based, inclusive), nested symbols
   * included — a stored chunk may belong to any of them (bd tea-rags-mcp-9i2ow). A
   * chunk without both walker lines is not recorded: half a range places nothing.
   * A re-walk replaces the file's ranges wholesale.
   */
  recordWalkRanges(collectionKey: string, extraction: FileExtraction): void {
    let perColl = this.walkRangesByCollection.get(collectionKey);
    if (!perColl) {
      perColl = new Map();
      this.walkRangesByCollection.set(collectionKey, perColl);
    }
    const ranges: SymbolLineRange[] = [];
    for (const c of extraction.chunks) {
      if (c.startLine !== undefined && c.endLine !== undefined) {
        ranges.push({ symbolId: c.symbolId, startLine: c.startLine, endLine: c.endLine });
      }
    }
    perColl.set(extraction.relPath, ranges);
  }

  /**
   * Overlays for every chunk in `chunkMap` this pass can settle, read from the
   * finished graph behind `graphDb`, plus the symbol→chunk join for every file
   * this run walked. Unsettled chunks are omitted, so no caller stamps them.
   */
  async build(
    graphDb: GraphDbClient,
    chunkMap: Map<string, ChunkLookupEntry[]>,
    collectionKey: string,
  ): Promise<Map<string, Map<string, ChunkSignalOverlay>>> {
    // One set-based fetch of every symbol's {fanIn, fanOut, pageRank}, then an
    // in-memory lookup per chunk; values equal the point getters (absent ⇒ {0,0,0}).
    const bulkStartMs = isDebug() ? Date.now() : 0;
    const chunkSignals = await graphDb.getChunkSignalsBulk();
    if (isDebug()) {
      console.error("[GitEnrich] PHASE: CODEGRAPH_CHUNK_SIGNALS_READ", {
        symbols: chunkSignals.size,
        durationMs: Date.now() - bulkStartMs,
      });
    }
    const out = new Map<string, Map<string, ChunkSignalOverlay>>();
    // 6aytq — the symbol→chunk join is collected across the WHOLE pass and written
    // once at the end: per file it was one daemon round-trip of single-row UPDATEs.
    // Nothing in the loop reads it back, so deferring the write changes only its shape.
    const chunkIdJoins: SymbolChunkIdJoinEntry[] = [];
    const rangesByFile = this.walkRangesByCollection.get(collectionKey);
    const settlementTally = new CodegraphChunkSettlementTally();
    for (const [relPath, entries] of chunkMap) {
      // The walker's ranges for this file, present only when this provider
      // walked it during this run.
      const ranges = rangesByFile?.get(relPath);
      // The one settlement every producer of these keys goes through (bd
      // tea-rags-mcp-39xca.2): the chunk-owner rule over an explicit range
      // source. A file the run claims but whose walk left no line index is
      // UNSETTLED and omitted from the overlays, so no caller stamps it — not an
      // empty map passed off as a result (bd tea-rags-mcp-fxio5).
      const settlement = settleCodegraphChunkSignals(this.chunkRangeSourceFor(relPath, ranges), entries, chunkSignals);
      settlementTally.record(relPath, settlement, entries.length);
      // Confidence-weighted fanIn/fanOut (bd tea-rags-mcp-s5ato) + PageRank from
      // the bulk map; bare inner keys (tea-rags-mcp-k6xu) under providerKey
      // `codegraph.symbols.chunk`.
      out.set(relPath, toChunkSignalOverlays(settlement, entries));
      // 0rskm — store-time symbol→covering-chunk join. The walker's ranges hold
      // EVERY extracted symbol, including methods of a collapsed class with no own
      // Qdrant chunk; project them to symbol→startLine and backfill
      // cg_symbols.chunk_id.
      if (ranges && ranges.length > 0) {
        const symbolStartLines = symbolStartLinesOf(ranges);
        // Named even when the join came back EMPTY (bd tea-rags-mcp-tslvq): the
        // write REPLACES per named file, and naming a file is the only way its
        // symbols' stale chunk_id is retired (`upsertSymbolsBulk` is a row diff).
        // A file absent from this pass, or never walked this run, is not named.
        chunkIdJoins.push({ relPath, chunkIds: computeSymbolChunkIds(symbolStartLines, entries) });
      }
    }
    if (chunkIdJoins.length > 0) {
      await graphDb.updateSymbolChunkIdsBulk(chunkIdJoins);
    }
    // Unconditional, once per pass: an unsettled chunk keeps no stamp and no
    // signals, and without this line the only trace is a degraded marker.
    const unsettled = settlementTally.describeUnsettled("chunk signal pass");
    if (unsettled !== undefined) process.stderr.write(`${unsettled}\n`);
    return out;
  }

  /**
   * The range source one file's stored chunks settle against in `build`. Every
   * file that reaches that pass is one the run claims — its chunks were stored by
   * this run, or seeded for its forced repair walk (bd tea-rags-mcp-fxio5) — so an
   * extractable file with no walker ranges is a walk that left nothing behind:
   * `walk` with no ranges, UNSETTLED. It is NOT a reason to read `cg_symbols`,
   * whose rows may describe the file's content before this run. Only a file the
   * graph can never hold settles without signal values.
   */
  private chunkRangeSourceFor(
    relPath: string,
    walkRanges: readonly SymbolLineRange[] | undefined,
  ): CodegraphChunkRangeSource {
    if (walkRanges !== undefined) return { kind: "walk", ranges: walkRanges };
    if (!CODEGRAPH_SUPPORTED_EXTENSIONS.has(extensionOf(relPath))) {
      return { kind: "none", reason: "non-extractable-language" };
    }
    if (this.exclusionFilter.ignores(relPath)) return { kind: "none", reason: "excluded-from-graph" };
    return { kind: "walk", ranges: undefined };
  }
}

/**
 * The symbol→startLine input of {@link computeSymbolChunkIds}, projected from
 * the walker's per-file ranges exactly as the pre-9i2ow startLine-keyed line map
 * produced it: one symbol per start line, the LAST walked chunk at a line
 * winning, in first-seen line order. Kept that way on purpose — the join's
 * semantics are not part of the chunk-owner change (bd tea-rags-mcp-9i2ow).
 */
function symbolStartLinesOf(ranges: readonly SymbolLineRange[]): Map<SymbolId, number> {
  const symbolByStartLine = new Map<number, SymbolId>();
  for (const range of ranges) symbolByStartLine.set(range.startLine, range.symbolId);
  const out = new Map<SymbolId, number>();
  for (const [startLine, symbolId] of symbolByStartLine) out.set(symbolId, startLine);
  return out;
}

/**
 * Symbol→covering-chunk containment join (0rskm). For each symbol start line,
 * pick the tightest chunk whose range (or any of its non-contiguous
 * `lineRanges`) contains that line. "Tightest" = smallest covering span, so a
 * method's own chunk wins over the enclosing class chunk, and a `#partN` part
 * wins over a wide fallback. Symbols with no covering chunk are omitted (their
 * cg_symbols.chunk_id stays NULL → find_symbol fallback is a no-op for them).
 */
export function computeSymbolChunkIds(
  symbolStartLines: ReadonlyMap<SymbolId, number>,
  entries: readonly ChunkLookupEntry[],
): Map<SymbolId, string> {
  const out = new Map<SymbolId, string>();
  for (const [symbolId, line] of symbolStartLines) {
    let bestId: string | undefined;
    let bestSpan = Number.POSITIVE_INFINITY;
    for (const e of entries) {
      const span = coveringSpan(e, line);
      if (span !== undefined && span < bestSpan) {
        bestSpan = span;
        bestId = e.chunkId;
      }
    }
    if (bestId !== undefined) out.set(symbolId, bestId);
  }
  return out;
}

/**
 * Effective covering span of `entry` for `line`, or undefined if `line` is not
 * covered. When `lineRanges` is present, containment is checked against the
 * sub-range that holds the line and the span is that sub-range's width (Ruby
 * body groups: a tight group beats a wide whole-chunk span).
 */
function coveringSpan(entry: ChunkLookupEntry, line: number): number | undefined {
  if (entry.lineRanges && entry.lineRanges.length > 0) {
    let best: number | undefined;
    for (const r of entry.lineRanges) {
      if (line >= r.start && line <= r.end) {
        const w = r.end - r.start;
        if (best === undefined || w < best) best = w;
      }
    }
    return best;
  }
  if (line >= entry.startLine && line <= entry.endLine) return entry.endLine - entry.startLine;
  return undefined;
}
