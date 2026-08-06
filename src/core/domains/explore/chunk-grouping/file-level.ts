/**
 * FileLevelGrouper — collapses chunk hits into one result per file, carrying an
 * outline of everything that matched inside that file.
 *
 * The outline comes from the same groupers `find_symbol(relativePath)` uses, so
 * `payload.members` and a find_symbol file outline are the same text for the
 * same chunk set. One outline shape across the product, not two similar ones.
 *
 * Pure data transformer, no I/O.
 */

import type { ExploreResult } from "../strategies/index.js";
import { CodeChunkGrouper } from "./code.js";
import { DocChunkGrouper } from "./doc.js";
import type { ScrollChunk } from "./types.js";

export const FileLevelGrouper = {
  /**
   * Keep the highest-scored hit per file (input is score-ordered) and attach
   * the outline of every hit that collapsed into it.
   */
  group(results: ExploreResult[], limit: number): ExploreResult[] {
    const byPath = new Map<string, ExploreResult[]>();
    for (const result of results) {
      const path = (result.payload?.relativePath as string | undefined) ?? "";
      const hits = byPath.get(path);
      if (hits) hits.push(result);
      else byPath.set(path, [result]);
    }
    return [...byPath.values()].slice(0, limit).map(attachMembers);
  },
};

/** Attach the outline of a file's hits to that file's representative result. */
function attachMembers(hits: ExploreResult[]): ExploreResult {
  const representative = hits[0];
  if (!representative.payload) return representative;

  const chunks: ScrollChunk[] = [];
  for (const hit of hits) {
    if (hit.payload) chunks.push({ id: hit.id ?? "", payload: hit.payload });
  }

  const isDoc = chunks.some((chunk) => chunk.payload.isDocumentation === true);
  const outline = isDoc ? DocChunkGrouper.group(chunks) : CodeChunkGrouper.groupFile(chunks);
  const members = outline.payload?.content as string | undefined;
  if (!hasMembers(members, isDoc)) return representative;

  return { ...representative, payload: { ...representative.payload, members } };
}

/**
 * A code outline opens with the file path, so a header-only outline means no
 * hit carried a name; a doc TOC is empty when the file has no headings. Neither
 * is worth putting on the wire.
 */
function hasMembers(outline: string | undefined, isDoc: boolean): boolean {
  if (!outline) return false;
  const lines = outline.split("\n");
  const memberLines = isDoc ? lines : lines.slice(1);
  return memberLines.some((line) => line.trim().length > 0);
}
