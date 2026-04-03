/**
 * DocChunkGrouper — groups documentation chunks into a TOC outline.
 *
 * Pure data transformer, no I/O.
 */

import type { SearchResult } from "../../../api/public/dto/explore.js";
import type { ScrollChunk } from "./types.js";

/** Extract file-level git from a chunk. */
function fileGit(chunk: ScrollChunk): Record<string, unknown> | undefined {
  const git = chunk.payload.git as Record<string, unknown> | undefined;
  return git ? { file: git.file } : undefined;
}

export const DocChunkGrouper = {
  /**
   * Group documentation chunks into a TOC outline result.
   * Replaces the inline `outlineDoc` in symbol-resolve.ts.
   */
  group(chunks: ScrollChunk[]): SearchResult {
    const sorted = [...chunks].sort((a, b) => (Number(a.payload.startLine) || 0) - (Number(b.payload.startLine) || 0));
    const first = sorted[0];

    // Merge unique headingPath entries (deduplicate by depth:text)
    const seen = new Set<string>();
    const mergedHeadingPath: { depth: number; text: string }[] = [];

    // Track which chunk introduces each heading (for TOC symbolId annotation)
    const headingIntroducer = new Map<string, string>(); // depth:text -> symbolId

    for (const c of sorted) {
      const hp = c.payload.headingPath as { depth: number; text: string }[] | undefined;
      if (!hp) continue;
      const symbolId = (c.payload.symbolId as string | undefined) ?? "";
      for (const entry of hp) {
        const key = `${entry.depth}:${entry.text}`;
        if (!seen.has(key)) {
          seen.add(key);
          mergedHeadingPath.push(entry);
          headingIntroducer.set(key, symbolId);
        }
      }
    }

    // Build TOC content
    const tocLines: string[] = [];
    for (const entry of mergedHeadingPath) {
      const indent = "  ".repeat(Math.max(0, entry.depth - 1));
      const hashes = "#".repeat(entry.depth);
      const key = `${entry.depth}:${entry.text}`;
      const introducer = headingIntroducer.get(key);
      const suffix = introducer ? `  ${introducer}` : "";
      tocLines.push(`${indent}${hashes} ${entry.text}${suffix}`);
    }

    const contentSize = sorted.reduce((sum, c) => sum + ((c.payload.content as string | undefined) ?? "").length, 0);

    const payload: Record<string, unknown> = {
      relativePath: first.payload.relativePath,
      language: first.payload.language,
      isDocumentation: true,
      symbolId: first.payload.parentSymbolId,
      startLine: first.payload.startLine,
      endLine: sorted[sorted.length - 1].payload.endLine,
      content: tocLines.join("\n"),
      headingPath: mergedHeadingPath,
      chunkCount: sorted.length,
      contentSize,
      git: fileGit(first),
    };

    return { id: first.id, score: 1.0, payload };
  },
};
