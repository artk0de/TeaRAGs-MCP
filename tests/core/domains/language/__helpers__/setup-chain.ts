/**
 * The setup chain a test example inherits, read the way explore hydrates it
 * (bd tea-rags-mcp-5xpq4): every setup MEMBER — one scope's setup inside a
 * packed setup chunk — whose scope span (`scopeLineRanges[i]`) CONTAINS the
 * example's start line, outermost scope first. Mirrors lexical setup
 * inheritance (RSpec `let` / `before`, Jest `beforeEach`) without parsing ids.
 *
 * A member is named by `memberSymbolIds[i]` on a pack of several, by the
 * chunk's own `symbolId` on a pack of one. Accepts kernel `BodyChunkResult`s
 * and engine `CodeChunk`s alike, so the chunker specs of every language can
 * state "this example runs under these scopes' setup" in one vocabulary.
 */

interface LineRange {
  start: number;
  end: number;
}

interface ChunkView {
  symbolId?: string;
  startLine: number;
  scopeLineRanges?: LineRange[];
  memberSymbolIds?: string[];
}

type ChunkLike =
  | ChunkView
  | {
      startLine: number;
      metadata: { symbolId?: string; scopeLineRanges?: LineRange[]; memberSymbolIds?: string[] };
    };

function view(chunk: ChunkLike): ChunkView {
  if ("metadata" in chunk) {
    return {
      symbolId: chunk.metadata.symbolId,
      startLine: chunk.startLine,
      scopeLineRanges: chunk.metadata.scopeLineRanges,
      memberSymbolIds: chunk.metadata.memberSymbolIds,
    };
  }
  return chunk;
}

/** Every setup member of the given chunks: its id and its scope span. */
export function setupMembersOf(chunks: readonly ChunkLike[]): { id: string; scope: LineRange }[] {
  return chunks.map(view).flatMap((c) =>
    (c.scopeLineRanges ?? []).map((scope, i) => ({
      id: c.memberSymbolIds?.[i] ?? (c.symbolId ?? "").replace(/#part\d+$/, ""),
      scope,
    })),
  );
}

/**
 * One scope's own setup text, sliced out of whichever (unsplit) setup chunk
 * packs it: the member's rows, counted back from the end of the content so a
 * container header the engine prepends is skipped. Undefined when no chunk
 * carries the scope.
 */
export function memberSetupText(
  chunks: readonly (ChunkLike & { content: string })[],
  scopeId: string,
): string | undefined {
  for (const chunk of chunks) {
    const c = view(chunk);
    const counts =
      "metadata" in chunk
        ? (chunk.metadata as { memberRowCounts?: number[] }).memberRowCounts
        : (chunk as { memberRowCounts?: number[] }).memberRowCounts;
    if (!c.scopeLineRanges || !counts) continue;
    const index = (c.memberSymbolIds ?? [c.symbolId ?? ""]).indexOf(scopeId);
    if (index < 0) continue;
    const rows = chunk.content.split("\n");
    const total = counts.reduce((sum, n) => sum + n, 0);
    const offset = rows.length - total + counts.slice(0, index).reduce((sum, n) => sum + n, 0);
    return rows.slice(offset, offset + counts[index]).join("\n");
  }
  return undefined;
}

export function setupChainOf(chunks: readonly ChunkLike[], example: ChunkLike): string[] {
  const { startLine } = view(example);
  return setupMembersOf(chunks)
    .filter(({ scope }) => scope.start <= startLine && startLine <= scope.end)
    .sort((a, b) => a.scope.start - b.scope.start || b.scope.end - a.scope.end)
    .map(({ id }) => id)
    .filter((id, i, ids) => ids.indexOf(id) === i);
}
