/**
 * DocChunkGrouper — groups documentation chunks into a TOC outline, and
 * reassembles one section from the overlapping windows it was cut into.
 *
 * Pure data transformer, no I/O.
 */

import type { SearchResult } from "../../../api/public/dto/explore.js";
import type { ScrollChunk } from "./types.js";

/** `(part N/M)` suffix a size cap appends to the name of each piece it cuts. */
const PART_NAME_SUFFIX = / \(part \d+\/\d+\)$/;

/** Extract file-level git from a chunk. */
function fileGit(chunk: ScrollChunk): Record<string, unknown> | undefined {
  const git = chunk.payload.git as Record<string, unknown> | undefined;
  return git ? { file: git.file } : undefined;
}

/**
 * Every breadcrumb line the markdown chunker can have injected into windows of
 * these chunks: each ancestor chain of their headingPath rendered as
 * `# A > ## B`, the format of `MarkdownChunker#buildBreadcrumb`. A breadcrumb
 * occupies no source line, so it is recognised by text, never by position.
 */
function breadcrumbLines(chunks: ScrollChunk[]): Set<string> {
  const lines = new Set<string>();
  for (const chunk of chunks) {
    const headingPath = chunk.payload.headingPath as { depth: number; text: string }[] | undefined;
    if (!headingPath) continue;
    for (let depth = 1; depth <= headingPath.length; depth++) {
      lines.add(
        headingPath
          .slice(0, depth)
          .map((h) => `${"#".repeat(h.depth)} ${h.text}`)
          .join(" > "),
      );
    }
  }
  return lines;
}

/** Does `run` occur as a contiguous sequence of lines inside `lines`? */
function containsRun(lines: string[], run: string[]): boolean {
  for (let start = 0; start + run.length <= lines.length; start++) {
    if (run.every((line, i) => lines[start + i] === line)) return true;
  }
  return false;
}

/** Longest k for which the last k lines of `lines` equal the first k of `next`. */
function overlapLength(lines: string[], next: string[]): number {
  for (let k = Math.min(lines.length, next.length); k > 0; k--) {
    if (next.slice(0, k).every((line, i) => lines[lines.length - k + i] === line)) return k;
  }
  return 0;
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

  /**
   * Reassemble ONE documentation section (chunks sharing a `doc:<hash>`
   * symbolId) from the windows the markdown chunker cut it into.
   *
   * An oversized section goes through the character fallback, whose windows
   * overlap by text and each get the section breadcrumb prepended (the first
   * one twice); a later size cap may cut a window again into "(part N/M)"
   * pieces that keep the SAME symbolId — no `#partN` suffix, so the code-side
   * split-fragment collapse never sees them. Concatenating repeats every
   * overlap; taking the head window drops the rest of the section. Line ranges
   * overlap and do not map 1:1 to content lines, so windows are stitched by
   * TEXT, in startLine order: breadcrumb lines are lifted out of every window
   * and kept once at the top, a window already contained in the text so far is
   * skipped, and otherwise only what lies past its longest line overlap with
   * the tail is appended. Section text excludes fenced code blocks, so a
   * coincidental one-line overlap cannot fuse two fences.
   */
  mergeSection(chunks: ScrollChunk[]): SearchResult {
    const sorted = [...chunks].sort(
      (a, b) =>
        (Number(a.payload.startLine) || 0) - (Number(b.payload.startLine) || 0) ||
        (Number(a.payload.chunkIndex) || 0) - (Number(b.payload.chunkIndex) || 0),
    );
    const first = sorted[0];
    const breadcrumbs = breadcrumbLines(sorted);

    const header: string[] = [];
    let body: string[] = [];
    for (const chunk of sorted) {
      const lines = ((chunk.payload.content as string | undefined) ?? "").split("\n");
      let bodyStart = 0;
      while (bodyStart < lines.length && breadcrumbs.has(lines[bodyStart])) {
        if (!header.includes(lines[bodyStart])) header.push(lines[bodyStart]);
        bodyStart++;
      }
      const window = lines.slice(bodyStart).filter((line) => !breadcrumbs.has(line));
      if (window.length === 0 || containsRun(body, window)) continue;
      body = [...body, ...window.slice(overlapLength(body, window))];
    }

    const payload: Record<string, unknown> = {
      ...first.payload,
      name: (first.payload.name as string | undefined)?.replace(PART_NAME_SUFFIX, ""),
      content: [...header, ...body].join("\n"),
      startLine: first.payload.startLine,
      endLine: Math.max(...sorted.map((c) => Number(c.payload.endLine) || 0)),
      git: fileGit(first),
      mergedChunkIds: sorted.map((c) => c.id),
    };

    return { id: first.id, score: 1.0, payload };
  },
};
