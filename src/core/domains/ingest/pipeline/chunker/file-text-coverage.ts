/**
 * File text coverage — the guarantee that every non-blank line grep would find
 * lands in some emitted chunk (bd tea-rags-mcp-6xdwe).
 *
 * The 50-char noise gate keeps tiny statements from becoming chunks of their
 * own, and that is right: a chunk holding `let n = 0;` is a useless search hit.
 * But the gate used to DROP their text too, so a small file (a re-export
 * barrel, a one-line class) yielded zero points and a tiny function between
 * two big ones vanished — content `grep` finds and tea-rags cannot. The two
 * helpers here keep the gate's intent (no noise chunk) without the loss:
 *
 *   - `absorbRemainderIntoNeighbourChunk` folds a below-floor remainder into
 *     the nearest chunk instead of discarding it;
 *   - `wholeFileChunk` turns a non-blank file that produced no chunk at all
 *     into ONE chunk spanning the file.
 */

import type { CodeChunk } from "../../../../types.js";
import type { ContainerRemainderPart, ContainerRemainderRange } from "./container-remainder.js";

/** The identity a whole-file chunk borrows from the file's one symbol, when it has one. */
export type WholeFileChunkIdentity = Pick<
  CodeChunk["metadata"],
  "chunkType" | "name" | "symbolId" | "parentSymbolId" | "parentType"
>;

/**
 * A line a text search can hit: it holds a word character. A bare `}` / `);`
 * closer is no search target, and absorbing it would only stretch a host's
 * line range over its container's closing row.
 */
const SEARCHABLE_LINE = /\w/;

function chunkLineRanges(chunk: CodeChunk): ContainerRemainderRange[] {
  return chunk.metadata.lineRanges?.length
    ? chunk.metadata.lineRanges
    : [{ start: chunk.startLine, end: chunk.endLine }];
}

function coversLine(chunk: CodeChunk, line: number): boolean {
  return chunkLineRanges(chunk).some((range) => line >= range.start && line <= range.end);
}

/** Sorted 1-based lines → maximal runs of consecutive lines. */
function linesToRanges(lines: number[]): ContainerRemainderRange[] {
  const ranges: ContainerRemainderRange[] = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = ranges[ranges.length - 1];
    if (last && line <= last.end + 1) last.end = Math.max(last.end, line);
    else ranges.push({ start: line, end: line });
  }
  return ranges;
}

/** Whether `chunk` already carries `text` as one of its own content lines (a container header prefix row). */
function carriesLineText(chunk: CodeChunk, text: string): boolean {
  return chunk.content.split("\n").some((row) => row.trim() === text);
}

/**
 * The chunks adjacent to `line`: those whose last claimed row before it is the
 * closest (`preceding`), and those whose first claimed row after it is the
 * closest (`following`). Every chunk in between would be nearer, so a host
 * taken from these never spans another chunk's rows.
 */
function adjacentChunks(
  chunks: readonly CodeChunk[],
  line: number,
): { preceding: CodeChunk[]; following: CodeChunk[] } {
  let precedingRow = -Infinity;
  let followingRow = Infinity;
  const lastBefore = new Map<CodeChunk, number>();
  const firstAfter = new Map<CodeChunk, number>();
  for (const chunk of chunks) {
    for (const { start, end } of chunkLineRanges(chunk)) {
      if (end < line && end > (lastBefore.get(chunk) ?? -Infinity)) lastBefore.set(chunk, end);
      if (start > line && start < (firstAfter.get(chunk) ?? Infinity)) firstAfter.set(chunk, start);
    }
    precedingRow = Math.max(precedingRow, lastBefore.get(chunk) ?? -Infinity);
    followingRow = Math.min(followingRow, firstAfter.get(chunk) ?? Infinity);
  }
  return {
    preceding: chunks.filter((chunk) => lastBefore.get(chunk) === precedingRow),
    following: chunks.filter((chunk) => firstAfter.get(chunk) === followingRow),
  };
}

/**
 * Fold each below-floor remainder part into its neighbour chunks, line by line
 * (bd tea-rags-mcp-mfnvp): every uncovered line goes to the chunk ADJACENT to it
 * — the one ending closest before it, else the one starting closest after it —
 * that still fits `maxChunkSize` with the line appended. Adjacency keeps the
 * host's span off every other chunk's rows. With `hostParentSymbolId` (a
 * container's remainder), only that container's own members may host, so a
 * nested container's member chunk never takes the outer class's `private`; an
 * adjacent neighbour of another scope leaves that direction without a host.
 * A line an adjacent chunk already carries as a content line (a container
 * header prefix) is searchable through it and is not appended again. The host
 * gains `lineRanges` for the absorbed lines, so git enrichment attributes them.
 *
 * Mutates the host chunks in place, a part all-or-nothing. Returns the parts
 * with a line no chunk could host — the caller emits those as chunks of their
 * own: a tiny chunk is noise, a lost line is a search miss, and the miss is the
 * worse failure.
 */
export function absorbRemainderIntoNeighbourChunk(
  parts: readonly ContainerRemainderPart[],
  chunks: CodeChunk[],
  codeLines: readonly string[],
  maxChunkSize: number,
  hostParentSymbolId?: string,
): ContainerRemainderPart[] {
  const canHost = (chunk: CodeChunk): boolean =>
    hostParentSymbolId === undefined || chunk.metadata.parentSymbolId === hostParentSymbolId;
  const unhosted: ContainerRemainderPart[] = [];
  for (const part of parts) {
    const plan = new Map<CodeChunk, number[]>();
    const appendedLength = (chunk: CodeChunk, line: number): number =>
      [...(plan.get(chunk) ?? []), line].reduce((sum, l) => sum + 1 + codeLines[l - 1].length, chunk.content.length);
    let hosted = true;
    for (const { start, end } of part.lineRanges) {
      for (let line = start; line <= end && hosted; line++) {
        const text = codeLines[line - 1] ?? "";
        if (!SEARCHABLE_LINE.test(text) || chunks.some((chunk) => coversLine(chunk, line))) continue;
        const { preceding, following } = adjacentChunks(chunks, line);
        if ([...preceding, ...following].some((chunk) => carriesLineText(chunk, text.trim()))) continue;
        const host = [preceding.find(canHost), following.find(canHost)].find(
          (chunk) => chunk !== undefined && appendedLength(chunk, line) <= maxChunkSize,
        );
        if (host === undefined) hosted = false;
        else plan.set(host, [...(plan.get(host) ?? []), line]);
      }
    }
    if (!hosted) {
      unhosted.push(part);
      continue;
    }
    for (const [host, lines] of plan) {
      host.content = `${host.content}\n${lines.map((line) => codeLines[line - 1]).join("\n")}`;
      const ranges = linesToRanges([
        ...chunkLineRanges(host).flatMap(({ start, end }) =>
          Array.from({ length: end - start + 1 }, (_, i) => start + i),
        ),
        ...lines,
      ]);
      host.startLine = ranges[0].start;
      host.endLine = ranges[ranges.length - 1].end;
      if (ranges.length > 1) host.metadata.lineRanges = ranges;
      else delete host.metadata.lineRanges;
    }
  }
  return unhosted;
}

/**
 * The one chunk a non-blank file gets when chunking produced none: the file's
 * text from its first to its last non-blank line. `identity` is the file's
 * single symbol when it has one (a one-line class keeps `symbolId` so
 * `find_symbol` resolves it); otherwise the chunk is an anonymous `block`.
 * Returns `undefined` for a blank file — it has no text grep could find.
 */
export function wholeFileChunk(
  code: string,
  filePath: string,
  language: string,
  identity?: WholeFileChunkIdentity,
): CodeChunk | undefined {
  const rows = code.split("\n");
  const first = rows.findIndex((row) => row.trim() !== "");
  if (first === -1) return undefined;
  let last = rows.length - 1;
  while (rows[last].trim() === "") last--;
  return {
    content: rows.slice(first, last + 1).join("\n"),
    startLine: first + 1,
    endLine: last + 1,
    metadata: {
      filePath,
      language,
      chunkIndex: 0,
      chunkType: identity?.chunkType ?? "block",
      ...(identity?.name !== undefined ? { name: identity.name } : {}),
      ...(identity?.symbolId !== undefined ? { symbolId: identity.symbolId } : {}),
      ...(identity?.parentSymbolId !== undefined ? { parentSymbolId: identity.parentSymbolId } : {}),
      ...(identity?.parentType !== undefined ? { parentType: identity.parentType } : {}),
    },
  };
}
