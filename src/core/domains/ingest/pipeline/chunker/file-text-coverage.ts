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

/**
 * Fold each below-floor remainder part into the nearest chunk — the closest one
 * ending before it, else the closest one starting after it — that still fits
 * `maxChunkSize` with the part's text appended. Only the part's non-blank lines
 * no chunk covers yet are appended (a container header the host already carries
 * as its prefix row is not repeated twice when it is covered). The host gains
 * `lineRanges` for the absorbed lines, so git enrichment attributes them.
 *
 * Mutates the host chunks in place. Returns the parts no chunk could host —
 * the caller emits those as chunks of their own: a tiny chunk is noise, a lost
 * line is a search miss, and the miss is the worse failure.
 */
export function absorbRemainderIntoNeighbourChunk(
  parts: readonly ContainerRemainderPart[],
  chunks: CodeChunk[],
  codeLines: readonly string[],
  maxChunkSize: number,
): ContainerRemainderPart[] {
  const unhosted: ContainerRemainderPart[] = [];
  for (const part of parts) {
    const candidates: number[] = [];
    for (const { start, end } of part.lineRanges) {
      for (let line = start; line <= end; line++) {
        if (SEARCHABLE_LINE.test(codeLines[line - 1] ?? "") && !chunks.some((chunk) => coversLine(chunk, line))) {
          candidates.push(line);
        }
      }
    }
    if (candidates.length === 0) continue;

    const first = candidates[0];
    const preceding = chunks.filter((chunk) => chunk.endLine < first).sort((a, b) => b.endLine - a.endLine);
    const following = chunks.filter((chunk) => chunk.endLine >= first).sort((a, b) => a.startLine - b.startLine);
    let host: CodeChunk | undefined;
    let lines: number[] = [];
    for (const chunk of [...preceding, ...following]) {
      // A line the host already carries as text (a container header prefix) is
      // searchable through it; appending it again would only move its range.
      lines = candidates.filter((line) => !chunk.content.includes(codeLines[line - 1].trim()));
      if (chunk.content.length + 1 + lines.map((line) => codeLines[line - 1]).join("\n").length <= maxChunkSize) {
        host = chunk;
        break;
      }
    }
    if (!host) {
      unhosted.push(part);
      continue;
    }
    if (lines.length === 0) continue;
    const text = lines.map((line) => codeLines[line - 1]).join("\n");

    host.content = `${host.content}\n${text}`;
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
