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

/** Determine member separator: # for instance, . for static. */
function formatMember(symbolId: string): string {
  // Static members use ClassName.method, instance use ClassName#method
  // symbolId already contains the separator from the chunker
  return symbolId;
}

export const CodeChunkGrouper = {
  /**
   * Group a class chunk with its member chunks into an outline result.
   * Replaces the inline `outlineClass` in symbol-resolve.ts.
   */
  group(classChunk: ScrollChunk, memberChunks: ScrollChunk[]): SearchResult {
    const sorted = sortByLine(memberChunks);

    const className = (classChunk.payload.name as string | undefined) ?? "";
    const lines = [
      className,
      ...sorted.map((c) => `  ${formatMember((c.payload.symbolId as string | undefined) ?? "")}`),
    ];
    const outlineContent = lines.join("\n");

    const allChunks = [classChunk, ...sorted];
    const contentSize = allChunks.reduce((sum, c) => sum + ((c.payload.content as string | undefined) ?? "").length, 0);

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
      chunkCount: 1 + memberChunks.length,
      contentSize,
    };

    return { id: classChunk.id, score: 1.0, payload };
  },

  /**
   * Group all chunks of a file into a file-level outline.
   * Top-level symbols (no parentSymbolId) are roots; children nest under them.
   */
  groupFile(chunks: ScrollChunk[]): SearchResult {
    const sorted = sortByLine(chunks);
    const first = sorted[0];
    const relativePath = (first.payload.relativePath as string | undefined) ?? "";

    // Separate top-level and nested symbols
    const topLevel: ScrollChunk[] = [];
    const childrenByParent = new Map<string, ScrollChunk[]>();

    for (const c of sorted) {
      const parentSymbolId = c.payload.parentSymbolId as string | undefined;
      if (!parentSymbolId) {
        topLevel.push(c);
      } else {
        const list = childrenByParent.get(parentSymbolId);
        if (list) list.push(c);
        else childrenByParent.set(parentSymbolId, [c]);
      }
    }

    // Build outline
    const lines: string[] = [relativePath];
    for (const tl of topLevel) {
      const name = (tl.payload.name as string | undefined) ?? (tl.payload.symbolId as string | undefined) ?? "";
      lines.push(`  ${name}`);
      const children = childrenByParent.get(name);
      if (children) {
        for (const child of children) {
          const childId = (child.payload.symbolId as string | undefined) ?? "";
          lines.push(`    ${childId}`);
        }
      }
    }

    const contentSize = sorted.reduce((sum, c) => sum + ((c.payload.content as string | undefined) ?? "").length, 0);

    const payload: Record<string, unknown> = {
      relativePath,
      language: first.payload.language,
      content: lines.join("\n"),
      chunkCount: sorted.length,
      contentSize,
      git: fileGit(first),
    };

    return { id: first.id, score: 1.0, payload };
  },
};
