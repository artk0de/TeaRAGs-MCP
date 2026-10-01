/**
 * The setup chain a test example inherits, read the way explore hydrates it
 * (bd tea-rags-mcp-5xpq4): every setup chunk whose `scopeLineRange` CONTAINS
 * the example's start line, outermost scope first. Mirrors lexical setup
 * inheritance (RSpec `let` / `before`, Jest `beforeEach`) without parsing ids.
 *
 * Accepts kernel `BodyChunkResult`s and engine `CodeChunk`s alike, so the
 * chunker specs of every language can state "this example runs under these
 * scopes' setup" in one vocabulary.
 */

interface LineRange {
  start: number;
  end: number;
}

interface ChunkView {
  symbolId?: string;
  startLine: number;
  scopeLineRange?: LineRange;
}

type ChunkLike =
  | { symbolId?: string; startLine: number; scopeLineRange?: LineRange }
  | { startLine: number; metadata: { symbolId?: string; scopeLineRange?: LineRange } };

function view(chunk: ChunkLike): ChunkView {
  if ("metadata" in chunk) {
    return {
      symbolId: chunk.metadata.symbolId,
      startLine: chunk.startLine,
      scopeLineRange: chunk.metadata.scopeLineRange,
    };
  }
  return chunk;
}

export function setupChainOf(chunks: readonly ChunkLike[], example: ChunkLike): string[] {
  const { startLine } = view(example);
  return chunks
    .map(view)
    .filter((c): c is ChunkView & { scopeLineRange: LineRange } => c.scopeLineRange !== undefined)
    .filter((c) => c.scopeLineRange.start <= startLine && startLine <= c.scopeLineRange.end)
    .sort(
      (a, b) =>
        a.scopeLineRange.start - b.scopeLineRange.start ||
        b.scopeLineRange.end - b.scopeLineRange.start - (a.scopeLineRange.end - a.scopeLineRange.start),
    )
    .map((c) => (c.symbolId ?? "").replace(/#part\d+$/, ""))
    .filter((id, i, ids) => ids.indexOf(id) === i);
}
