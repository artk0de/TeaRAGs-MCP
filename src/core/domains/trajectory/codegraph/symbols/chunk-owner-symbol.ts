/**
 * The chunk-owner rule — which symbol a stored chunk's codegraph signals belong
 * to (bd tea-rags-mcp-9i2ow).
 *
 * Every producer of `codegraph.symbols.chunk.{fanIn,fanOut,pageRank}` — the
 * deferred chunk pass, the backfiller, recovery's in-place heal and the payload
 * heal — reaches this function through ONE settlement,
 * `settleCodegraphChunkSignals` (`chunk-signal-settlement.ts`, bd
 * tea-rags-mcp-39xca.2), which owns the other half of the question: where the
 * ranges come from, and what it means when there are none. The deferred pass
 * and the heal used to pick the symbol differently — greatest symbol start at or
 * before the chunk, and the chunk's payload symbolId — so the stored value
 * depended on which one wrote last. Call this rule without the settlement and
 * the range-source half is lost again.
 *
 * Pure: no I/O, no state, same input → same output.
 */

import type { SymbolId, SymbolLineRange } from "../../../../contracts/types/codegraph.js";
import { NAME_SEPARATORS } from "./symbol-name.js";

/** The chunk being placed, as stored: its line span and, when it has one, the chunker's symbolId. */
export interface ChunkOwnerQuery {
  startLine: number;
  endLine: number;
  /**
   * The chunker's payload symbolId, as stored — `#partN` included; the rule
   * strips it. Absent for block chunks.
   */
  anchorSymbolId?: string;
}

/** The chunker's split suffix: an oversized symbol becomes `Foo#bar#part1`, `#part2`, … */
const CHUNK_PART_SUFFIX = /#part\d+$/;

/** The chunker symbolId a chunk is anchored on, without its `#partN` split suffix. */
export function chunkOwnerAnchor(symbolId: string): SymbolId {
  return symbolId.replace(CHUNK_PART_SUFFIX, "");
}

/**
 * The symbol that owns `chunk`, or undefined when nothing does.
 *
 * With an anchor, the candidates are the anchor and every symbol NESTED under it
 * (its id extends the anchor with a `::`, `#` or `.` segment) whose range
 * contains the chunk's start line. The tightest wins; when none contains the
 * start — a primary chunk whose leading comment begins above the definition, a
 * later part past every nested helper — the anchor stands. An anchor with no
 * range row (a chunker id codegraph never emitted) stands too: nothing is known
 * to narrow it with. A file whose rows predate migration 024 never gets here —
 * the settlement leaves it unsettled rather than guess.
 *
 * Without an anchor, the innermost symbol containing the start, else undefined.
 * A symbol that merely STARTS earlier owns nothing — that was the deferred
 * pass's bug.
 *
 * Order among containing candidates: smallest span, then the later start, then
 * the OUTER symbol (shorter id), then id order. The outer-on-full-tie step is
 * what keeps a class chunk on the class rather than on the synthetic
 * `#constructor` spanning exactly the class node.
 */
export function resolveChunkOwnerSymbol(
  chunk: ChunkOwnerQuery,
  ranges: readonly SymbolLineRange[],
): SymbolId | undefined {
  if (chunk.anchorSymbolId === undefined) return innermostContaining(ranges, chunk.startLine, () => true);
  const anchor = chunkOwnerAnchor(chunk.anchorSymbolId);
  if (!ranges.some((r) => r.symbolId === anchor)) return anchor;
  return innermostContaining(ranges, chunk.startLine, (id) => id === anchor || isNestedUnder(id, anchor)) ?? anchor;
}

function isNestedUnder(symbolId: string, anchor: string): boolean {
  return NAME_SEPARATORS.some((separator) => symbolId.startsWith(`${anchor}${separator}`));
}

function innermostContaining(
  ranges: readonly SymbolLineRange[],
  line: number,
  isCandidate: (symbolId: string) => boolean,
): SymbolId | undefined {
  let best: SymbolLineRange | undefined;
  for (const range of ranges) {
    if (line < range.startLine || line > range.endLine || !isCandidate(range.symbolId)) continue;
    if (best === undefined || ownsMoreTightly(range, best)) best = range;
  }
  return best?.symbolId;
}

function ownsMoreTightly(a: SymbolLineRange, b: SymbolLineRange): boolean {
  const spanA = a.endLine - a.startLine;
  const spanB = b.endLine - b.startLine;
  if (spanA !== spanB) return spanA < spanB;
  if (a.startLine !== b.startLine) return a.startLine > b.startLine;
  if (a.symbolId.length !== b.symbolId.length) return a.symbolId.length < b.symbolId.length;
  return a.symbolId < b.symbolId;
}
