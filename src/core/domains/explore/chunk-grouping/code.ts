/**
 * CodeChunkGrouper — groups code chunks into class outlines and file outlines.
 *
 * Pure data transformer, no I/O.
 */

import type { SearchResult } from "../../../api/public/dto/explore.js";
import type { ScrollChunk } from "./types.js";

/** Sort chunks by startLine ascending. */
function sortByLine(chunks: ScrollChunk[]): ScrollChunk[] {
  return [...chunks].sort((a, b) => (Number(a.payload.startLine) || 0) - (Number(b.payload.startLine) || 0));
}

/** Extract file-level git from a chunk. */
function fileGit(chunk: ScrollChunk): Record<string, unknown> | undefined {
  const git = chunk.payload.git as Record<string, unknown> | undefined;
  return git ? { file: git.file } : undefined;
}

/**
 * Extract the file-level codegraph branch from a chunk, stripped to
 * `{ symbols: { file } }` — mirrors fileGit. Codegraph signals are stored
 * nested as `codegraph.symbols.{file,chunk}` (Qdrant treats the dotted
 * EnrichmentApplier providerKey as a path; inner keys are bare —
 * tea-rags-mcp-k6xu). The outline projection (find_symbol relativePath / class
 * mode) rebuilds the payload from an allowlist, so without this the codegraph
 * section is silently dropped — tea-rags-mcp-0am0.
 */
function fileCodegraph(chunk: ScrollChunk): Record<string, unknown> | undefined {
  const codegraph = chunk.payload.codegraph as { symbols?: Record<string, unknown> } | undefined;
  const file = codegraph?.symbols?.file;
  return file !== undefined ? { symbols: { file } } : undefined;
}

/** Determine member separator: # for instance, . for static. */
function formatMember(symbolId: string): string {
  // Static members use ClassName.method, instance use ClassName#method
  // symbolId already contains the separator from the chunker
  return symbolId;
}

/**
 * One line per distinct member symbolId, in line order. A member the chunker
 * cut into several same-id windows (a Ruby class body, an oversized method
 * without `#partN`) is still ONE member of the outline.
 */
function memberLines(sortedMembers: ScrollChunk[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const chunk of sortedMembers) {
    const symbolId = (chunk.payload.symbolId as string | undefined) ?? "";
    if (seen.has(symbolId)) continue;
    seen.add(symbolId);
    lines.push(`  ${formatMember(symbolId)}`);
  }
  return lines;
}

function contentSizeOf(chunks: ScrollChunk[]): number {
  return chunks.reduce((sum, c) => sum + ((c.payload.content as string | undefined) ?? "").length, 0);
}

export const CodeChunkGrouper = {
  /**
   * Group a class chunk with its member chunks into an outline result.
   * Replaces the inline `outlineClass` in symbol-resolve.ts.
   */
  group(classChunk: ScrollChunk, memberChunks: ScrollChunk[]): SearchResult {
    const sorted = sortByLine(memberChunks);

    const className = (classChunk.payload.name as string | undefined) ?? "";
    const outlineContent = [className, ...memberLines(sorted)].join("\n");

    const allChunks = [classChunk, ...sorted];

    const payload: Record<string, unknown> = {
      symbolId: classChunk.payload.symbolId,
      name: classChunk.payload.name,
      chunkType: classChunk.payload.chunkType,
      relativePath: classChunk.payload.relativePath,
      language: classChunk.payload.language,
      fileExtension: classChunk.payload.fileExtension,
      content: outlineContent,
      startLine: classChunk.payload.startLine,
      endLine: sorted.length > 0 ? sorted[sorted.length - 1].payload.endLine : classChunk.payload.endLine,
      git: fileGit(classChunk),
      codegraph: fileCodegraph(classChunk),
      chunkCount: allChunks.length,
      contentSize: contentSizeOf(allChunks),
    };

    return { id: classChunk.id, score: 1.0, payload };
  },

  /**
   * Outline a class/module whose class-level chunk is NOT in the chunk set,
   * headed by the container id the caller queried. A TypeScript class body
   * chunker emits only method chunks for a class with members, so without this
   * a class query returns every method body instead of an outline.
   *
   * `memberChunks` must be non-empty and come from one file: path, language,
   * git and codegraph are taken from the first member by line.
   */
  groupMembers(containerSymbolId: string, memberChunks: ScrollChunk[]): SearchResult {
    const sorted = sortByLine(memberChunks);
    const anchor = sorted[0];

    const payload: Record<string, unknown> = {
      symbolId: containerSymbolId,
      name: containerSymbolId,
      relativePath: anchor.payload.relativePath,
      language: anchor.payload.language,
      fileExtension: anchor.payload.fileExtension,
      content: [containerSymbolId, ...memberLines(sorted)].join("\n"),
      startLine: Math.min(...sorted.map((c) => Number(c.payload.startLine) || 0)),
      endLine: Math.max(...sorted.map((c) => Number(c.payload.endLine) || 0)),
      git: fileGit(anchor),
      codegraph: fileCodegraph(anchor),
      chunkCount: sorted.length,
      contentSize: contentSizeOf(sorted),
    };

    return { id: anchor.id, score: 1.0, payload };
  },

  /**
   * Group all chunks of a file into a file-level outline.
   * Top-level symbols (no parentSymbolId) are roots; children nest under them.
   */
  groupFile(chunks: ScrollChunk[]): SearchResult {
    const sorted = sortByLine(chunks);
    const first = sorted[0];
    const relativePath = (first.payload.relativePath as string | undefined) ?? "";

    // Separate roots and nested symbols. A chunk is a root when it declares no
    // parent — or when its parent is absent from this chunk set: level=file
    // search hands over only the chunks that matched, so a method routinely
    // arrives without its declaring class and would otherwise be unreachable
    // from any rendered parent and vanish (tea-rags-mcp-zrma).
    const declaredNames = new Set(
      sorted.filter((c) => !c.payload.parentSymbolId).map((c) => (c.payload.name as string | undefined) ?? ""),
    );
    const roots: ScrollChunk[] = [];
    const childrenByParent = new Map<string, ScrollChunk[]>();

    for (const c of sorted) {
      const parentSymbolId = c.payload.parentSymbolId as string | undefined;
      if (!parentSymbolId || !declaredNames.has(parentSymbolId)) {
        roots.push(c);
      } else {
        const list = childrenByParent.get(parentSymbolId);
        if (list) list.push(c);
        else childrenByParent.set(parentSymbolId, [c]);
      }
    }

    // Build outline. An orphaned member is labelled by its qualified symbolId —
    // a bare `rerank` would lose the class it belongs to.
    const lines: string[] = [relativePath];
    for (const root of roots) {
      const name = root.payload.name as string | undefined;
      const symbolId = root.payload.symbolId as string | undefined;
      const label = root.payload.parentSymbolId ? (symbolId ?? name ?? "") : (name ?? symbolId ?? "");
      lines.push(`  ${label}`);
      const children = name ? childrenByParent.get(name) : undefined;
      if (children) {
        for (const child of children) {
          const childId = (child.payload.symbolId as string | undefined) ?? "";
          lines.push(`    ${childId}`);
        }
      }
    }

    const payload: Record<string, unknown> = {
      relativePath,
      language: first.payload.language,
      content: lines.join("\n"),
      chunkCount: sorted.length,
      contentSize: contentSizeOf(sorted),
      git: fileGit(first),
      codegraph: fileCodegraph(first),
    };

    return { id: first.id, score: 1.0, payload };
  },
};
