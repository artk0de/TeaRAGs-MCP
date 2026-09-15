/**
 * Settlement of `codegraph.symbols.chunk.*` — the ONE computation every producer
 * of those keys runs a stored chunk through (bd tea-rags-mcp-39xca.2).
 *
 * Four paths write the keys onto the same points: the deferred chunk pass
 * (`CodegraphEnrichmentProvider#buildChunkSignals`), the backfiller and
 * recovery's in-place heal (both reach that same method through the executor),
 * and the payload heal (`api/internal/infra/codegraph-payload-heal-runner.ts`).
 * They already shared the chunk-owner rule; what they did not share was the
 * answer to "and when there are no ranges?". The deferred pass let `enrichedAt`
 * be stamped over empty overlays for a file its walk left no line index for
 * (bd tea-rags-mcp-fxio5), and the heal read a file whose rows predate
 * migration 024 as "no range row" and wrote anchor owners (bd
 * tea-rags-mcp-71n0p). Neither failed anywhere.
 *
 * So the range source is typed, and so is the outcome:
 *  - `walk` — the run's own walker ranges. `undefined` means the run claims the
 *    file but its walk left no line index: UNSETTLED, never a stamp.
 *  - `persisted` — `cg_symbols` ranges plus the count of rows carrying none. Any
 *    such row, or no row at all, is UNSETTLED.
 *  - `none` — a file the graph can never hold, the only source that settles a
 *    whole file without signal values.
 *
 * A chunk whose ranges were read but which no symbol owns (a block past every
 * definition) is `unowned`: settled without values. The rule found nothing,
 * which is not the same as not having looked.
 *
 * Pure: no I/O, no state, same input → same output.
 */

import type { ChunkGraphSignals, SymbolId, SymbolLineRange } from "../../../../contracts/types/codegraph.js";
import type { ChunkSignalOverlay } from "../../../../contracts/types/provider.js";
import { resolveChunkOwnerSymbol } from "./chunk-owner-symbol.js";
import { buildCodegraphChunkSignals } from "./payload-signals.js";

/** Why the graph can never hold a file — the only reasons a whole file settles without signal values. */
export type CodegraphChunkRangeAbsenceReason = "non-extractable-language" | "excluded-from-graph";

/** Why a producer could not settle a chunk. Every one leaves the stored payload as it is. */
export type CodegraphChunkUnsettledReason =
  /** The run claims the file, but its walk left no line index for it. */
  | "walked-file-without-ranges"
  /** `cg_symbols` holds rows for the file that carry no range — written before migration 024. */
  | "persisted-rows-without-ranges"
  /** `cg_symbols` holds no row for the file at all. */
  | "no-persisted-symbol-rows"
  /** The stored point carries no line span to place — a payload defect, counted by the caller. */
  | "chunk-without-line-span";

/** Where the symbol ranges a file's chunks are placed against come from. */
export type CodegraphChunkRangeSource =
  | { readonly kind: "walk"; readonly ranges: readonly SymbolLineRange[] | undefined }
  | {
      readonly kind: "persisted";
      readonly ranges: readonly SymbolLineRange[];
      readonly rowsWithoutRanges: number;
    }
  | { readonly kind: "none"; readonly reason: CodegraphChunkRangeAbsenceReason };

/** A stored chunk as a producer holds it: point id, line span and — when it has one — the chunker's symbolId. */
export interface CodegraphStoredChunk {
  chunkId: string;
  startLine: number;
  endLine: number;
  /** As stored, `#partN` included; the owner rule strips it. Absent for block chunks. */
  symbolId?: string;
}

/** One chunk of a file whose ranges were read. */
export type CodegraphChunkSettlement =
  | { readonly kind: "owned"; readonly owner: SymbolId; readonly signals: ChunkSignalOverlay }
  | { readonly kind: "unowned" };

/** One file's chunks, settled against one range source. */
export type CodegraphFileChunkSettlement =
  | {
      readonly kind: "signals";
      readonly source: "walk" | "persisted";
      readonly chunks: ReadonlyMap<string, CodegraphChunkSettlement>;
    }
  | { readonly kind: "settled-without-signals"; readonly reason: CodegraphChunkRangeAbsenceReason }
  | {
      readonly kind: "unsettled";
      readonly reason: Exclude<CodegraphChunkUnsettledReason, "chunk-without-line-span">;
    };

const UNOWNED: CodegraphChunkSettlement = { kind: "unowned" };

/**
 * Settle one file's stored chunks: each owned chunk takes its owner's signals
 * from `signalsBySymbol` (all-zero for a symbol the graph has no row for), each
 * unowned one settles without values — or the whole file is unsettled, with the
 * reason, and nothing about it may be written.
 */
export function settleCodegraphChunkSignals(
  source: CodegraphChunkRangeSource,
  chunks: readonly CodegraphStoredChunk[],
  signalsBySymbol: ReadonlyMap<SymbolId, ChunkGraphSignals>,
): CodegraphFileChunkSettlement {
  switch (source.kind) {
    case "none":
      return { kind: "settled-without-signals", reason: source.reason };
    case "walk":
      if (source.ranges === undefined) return { kind: "unsettled", reason: "walked-file-without-ranges" };
      return { kind: "signals", source: "walk", chunks: settleChunks(source.ranges, chunks, signalsBySymbol) };
    case "persisted":
      // ANY unranged row, not only an all-unranged file: that row may be the
      // nested symbol a chunk belongs to, and narrowing without it lands the
      // chunk on the outer or anchor symbol — the stale owner this replaces.
      if (source.rowsWithoutRanges > 0) return { kind: "unsettled", reason: "persisted-rows-without-ranges" };
      if (source.ranges.length === 0) return { kind: "unsettled", reason: "no-persisted-symbol-rows" };
      return { kind: "signals", source: "persisted", chunks: settleChunks(source.ranges, chunks, signalsBySymbol) };
  }
}

/**
 * A settlement as the provider contract carries it (`settlesChunksExplicitly`,
 * `contracts/types/provider.ts`): an overlay for every SETTLED chunk — its
 * owner's signals, or EMPTY when settled without values — and no entry for a
 * chunk left unsettled, which the caller must therefore not stamp.
 */
export function toChunkSignalOverlays(
  settlement: CodegraphFileChunkSettlement,
  chunks: readonly CodegraphStoredChunk[],
): Map<string, ChunkSignalOverlay> {
  const overlays = new Map<string, ChunkSignalOverlay>();
  switch (settlement.kind) {
    case "unsettled":
      return overlays;
    case "settled-without-signals":
      for (const chunk of chunks) overlays.set(chunk.chunkId, {});
      return overlays;
    case "signals":
      for (const [chunkId, chunk] of settlement.chunks) {
        overlays.set(chunkId, chunk.kind === "owned" ? chunk.signals : {});
      }
      return overlays;
  }
}

function settleChunks(
  ranges: readonly SymbolLineRange[],
  chunks: readonly CodegraphStoredChunk[],
  signalsBySymbol: ReadonlyMap<SymbolId, ChunkGraphSignals>,
): Map<string, CodegraphChunkSettlement> {
  const settled = new Map<string, CodegraphChunkSettlement>();
  for (const chunk of chunks) {
    const owner = resolveChunkOwnerSymbol(
      { startLine: chunk.startLine, endLine: chunk.endLine, anchorSymbolId: chunk.symbolId },
      ranges,
    );
    settled.set(
      chunk.chunkId,
      owner === undefined
        ? UNOWNED
        : { kind: "owned", owner, signals: buildCodegraphChunkSignals(signalsBySymbol.get(owner)) },
    );
  }
  return settled;
}

/** Files named in one unsettled-chunks line before the list is elided. */
const UNSETTLED_FILES_NAMED = 5;

/**
 * The unsettled chunks one producer pass left behind, per reason — the pass's
 * counter and its single log line. An unsettled chunk keeps whatever payload it
 * had, so this line is the only place the degrade is visible outside the
 * recovery count.
 */
export class CodegraphChunkSettlementTally {
  private readonly chunksByReason = new Map<CodegraphChunkUnsettledReason, number>();
  private readonly files = new Set<string>();
  private total = 0;

  /** Count a file's chunks when its settlement left them unsettled; a settled file counts nothing. */
  record(relPath: string, settlement: CodegraphFileChunkSettlement, chunkCount: number): void {
    if (settlement.kind === "unsettled") this.recordUnsettled(relPath, settlement.reason, chunkCount);
  }

  recordUnsettled(relPath: string, reason: CodegraphChunkUnsettledReason, chunkCount: number): void {
    if (chunkCount <= 0) return;
    this.chunksByReason.set(reason, (this.chunksByReason.get(reason) ?? 0) + chunkCount);
    this.files.add(relPath);
    this.total += chunkCount;
  }

  get unsettledChunks(): number {
    return this.total;
  }

  /** One line naming the producer, the count per reason and the first few files — undefined when nothing degraded. */
  describeUnsettled(producer: string): string | undefined {
    if (this.total === 0) return undefined;
    const reasons = [...this.chunksByReason].map(([reason, count]) => `${reason}: ${count}`).join(", ");
    const named = [...this.files].slice(0, UNSETTLED_FILES_NAMED);
    const rest = this.files.size - named.length;
    return (
      `[codegraph] ${producer} left ${this.total} chunk(s) in ${this.files.size} file(s) unsettled ` +
      `(${reasons}); their payload is unchanged — ${named.join(", ")}${rest > 0 ? ` and ${rest} more` : ""}`
    );
  }
}
