/**
 * Swift container-body chunk — the type-level chunk carrying the declaration
 * header plus whatever sits above the first extracted member.
 *
 * This hook exists because of an ENGINE BRANCH, not because Swift wanted richer
 * body grouping. `chunkWithChildExtraction` emits its narrow parent class chunk
 * (`emitNarrowParentClassChunk`) only for languages with NO hook chain, and
 * switches to `ctx.bodyChunks` the moment a language registers one. Registering
 * any Swift hook therefore deletes the type chunk — `find_symbol("Ledger")`
 * would return nothing — unless the chain re-emits it. So this is a faithful
 * port of that engine method's output, not a new policy:
 *
 *   - same slice: the container's own rows up to (not including) the first
 *     extracted member, with the header row dropped because the engine
 *     re-attaches `containerHeader` itself;
 *   - same 50-character floor, measured on header + body the way the engine
 *     measures its full slice;
 *   - same `startLine` / `endLine`, so git chunk-overlap lookups do not move.
 *
 * Two things it adds, both consequences of the rest of the chain. Rows the
 * doc-comment hook claimed are dropped, so a member's documentation is not
 * emitted twice — once as its own chunk's prefix and once inside the type
 * chunk. And a recognized test suite's body is labelled `test_setup` rather
 * than `class`: a suite's stored properties are its fixtures, and once Swift
 * emits ANY `test` chunk, `detectScope` switches the whole language from
 * path-based to chunkType-based scoping, which would otherwise score an XCTest
 * fixture block as production source.
 *
 * TypeScript's `class-body-chunker.ts` does considerably more — semantic
 * grouping by member kind, non-contiguous line ranges, oversize splitting,
 * small-group merging. Swift deliberately does not: porting that would change
 * what the language emits today, which is a separate decision from making the
 * hook chain possible at all. Members declared BELOW the first method still
 * fall outside the chunk, exactly as they do on the pre-hook path.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import type { BodyChunkResult, ChunkingHook, ChunkType, HookContext } from "../../../../contracts/types/chunker.js";
import { detectSwiftSuiteKind } from "./suite-recognition.js";

/** The engine's own floor for a narrow parent chunk, measured on header + body. */
const MIN_CONTAINER_BODY_LENGTH = 50;

/**
 * `getChunkType` maps by node type, and Swift has exactly two container types:
 * `class_declaration` (every nominal type — class / struct / enum / extension /
 * actor) reads as `class`, and `protocol_declaration` matches none of the
 * engine's substrings and lands on `block`. Reproduced here so the hook path
 * emits what the pre-hook path emitted.
 */
function containerChunkType(containerNode: AstNode): ChunkType {
  return containerNode.type === "class_declaration" ? "class" : "block";
}

/**
 * The container's own body chunk, or an empty array when there is nothing worth
 * emitting. At most one chunk — the pre-hook path emitted at most one too.
 */
export function extractSwiftContainerBody(ctx: HookContext): BodyChunkResult[] {
  const { containerNode, validChildren, codeLines, excludedRows } = ctx;
  if (validChildren.length === 0) return [];

  const containerStartRow = containerNode.startPosition.row;
  const firstMemberRow = validChildren.reduce(
    (earliest, child) => Math.min(earliest, child.startPosition.row),
    validChildren[0].startPosition.row,
  );

  const rows: number[] = [];
  for (let row = containerStartRow + 1; row < firstMemberRow; row++) {
    if (!excludedRows.has(row)) rows.push(row);
  }

  // `trimEnd` only, never `trim`: the engine's slice keeps the first body row's
  // indentation, and the chunk text must stay byte-identical to the pre-hook one.
  const content = rows
    .map((row) => codeLines[row])
    .join("\n")
    .trimEnd();
  if (content.length === 0) return [];

  // The floor is measured over header + body, the way `emitNarrowParentClassChunk`
  // measures its whole slice.
  const fullSlice = [codeLines[containerStartRow], ...rows.map((row) => codeLines[row])].join("\n").trimEnd();
  if (fullSlice.length < MIN_CONTAINER_BODY_LENGTH) return [];

  const suiteKind = detectSwiftSuiteKind(containerNode, ctx.filePath);

  return [
    {
      content,
      // Kept at the engine's pre-hook values so chunk→line lookups do not move.
      startLine: containerStartRow + 1,
      endLine: Math.max(containerStartRow + 1, firstMemberRow),
      chunkType: suiteKind ? "test_setup" : containerChunkType(containerNode),
      lineRanges: toLineRanges([containerStartRow, ...rows]),
    },
  ];
}

/**
 * Collapse sorted 0-based rows into contiguous 1-based ranges. Exported for
 * `quick-scope-chunker.ts`, whose suite-residue chunk is non-contiguous for the
 * same reason this one is — a claimed row sits in the middle of the body.
 */
export function toLineRanges(rows: number[]): { start: number; end: number }[] {
  const sorted = [...rows].sort((a, b) => a - b);
  const ranges: { start: number; end: number }[] = [];
  for (const row of sorted) {
    const line = row + 1;
    const last = ranges[ranges.length - 1];
    if (last && line === last.end + 1) {
      last.end = line;
    } else {
      ranges.push({ start: line, end: line });
    }
  }
  return ranges;
}

/**
 * Generic body chunker (chain position 4) — claims the container by writing
 * `ctx.bodyChunks`. It deliberately does NOT set `ctx.skipChildren`: members are
 * still emitted as leaf chunks by the engine, exactly as on the pre-hook path.
 */
export const swiftContainerBodyChunkerHook: ChunkingHook = {
  name: "swiftContainerBodyChunker",
  process(ctx: HookContext): void {
    ctx.bodyChunks = extractSwiftContainerBody(ctx);
  },
};
