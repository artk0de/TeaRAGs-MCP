/**
 * Symbol resolution — pure functions for merging/outlining chunks
 * returned by Qdrant scroll into find_symbol results.
 *
 * No I/O, no Qdrant dependency.
 */

import type { SearchResult } from "../../api/public/dto/explore.js";

interface ScrollChunk {
  id: string | number;
  payload: Record<string, unknown>;
}

/**
 * Resolve raw scroll chunks into find_symbol results.
 *
 * Strategy per group (same symbolId + same relativePath):
 * - chunkType "class" → outline with members[]
 * - anything else → merge chunks by startLine order
 *
 * @param chunks - raw Qdrant scroll results
 * @param query - original symbol query (for sort priority)
 */
export function resolveSymbols(chunks: ScrollChunk[], query?: string): SearchResult[] {
  // Group by (symbolId, relativePath) for same-symbol merging
  const groups = groupChunks(chunks);
  const results: SearchResult[] = [];
  const emittedIds = new Set<string | number>();

  // First pass: find class chunks and collect their members from all chunks
  for (const group of groups.values()) {
    const classChunk = group.find((c) => c.payload.chunkType === "class");
    if (!classChunk) continue;

    // Find all member chunks across all groups (same file, parentName matches class name)
    const memberChunks = chunks.filter(
      (c) =>
        c !== classChunk &&
        c.payload.parentName === classChunk.payload.name &&
        c.payload.relativePath === classChunk.payload.relativePath,
    );

    results.push(outlineClass(classChunk, memberChunks));
    emittedIds.add(classChunk.id);
    for (const m of memberChunks) emittedIds.add(m.id);
  }

  // Second pass: handle remaining non-class, non-member chunks
  for (const group of groups.values()) {
    const unemitted = group.filter((c) => !emittedIds.has(c.id));
    if (unemitted.length === 0) continue;
    results.push(mergeChunks(unemitted));
  }

  return sortResults(results, query);
}

/** Group chunks by (symbolId, relativePath) composite key. */
function groupChunks(chunks: ScrollChunk[]): Map<string, ScrollChunk[]> {
  const groups = new Map<string, ScrollChunk[]>();
  for (const chunk of chunks) {
    const symbolId = String(chunk.payload.symbolId ?? "");
    const path = String(chunk.payload.relativePath ?? "");
    const key = `${symbolId}::${path}`;
    const group = groups.get(key);
    if (group) {
      group.push(chunk);
    } else {
      groups.set(key, [chunk]);
    }
  }
  return groups;
}

/** Merge multiple chunks of the same function into one result. */
function mergeChunks(chunks: ScrollChunk[]): SearchResult {
  const sorted = [...chunks].sort(
    (a, b) => (Number(a.payload.startLine) || 0) - (Number(b.payload.startLine) || 0),
  );

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const content = sorted.map((c) => String(c.payload.content ?? "")).join("\n");

  const payload: Record<string, unknown> = {
    ...first.payload,
    content,
    startLine: first.payload.startLine,
    endLine: last.payload.endLine,
    git: first.payload.git ? { file: (first.payload.git as Record<string, unknown>).file } : undefined,
  };

  if (sorted.length > 1) {
    payload.mergedChunkIds = sorted.map((c) => c.id);
  }

  return { id: first.id, score: 1.0, payload };
}

/** Outline a class: class chunk + members list. */
function outlineClass(classChunk: ScrollChunk, memberChunks: ScrollChunk[]): SearchResult {
  const members = memberChunks
    .sort((a, b) => (Number(a.payload.startLine) || 0) - (Number(b.payload.startLine) || 0))
    .map((c) => String(c.payload.symbolId ?? ""));

  const payload: Record<string, unknown> = {
    ...classChunk.payload,
    git: classChunk.payload.git
      ? { file: (classChunk.payload.git as Record<string, unknown>).file }
      : undefined,
    ...(members.length > 0 ? { members } : {}),
  };

  return { id: classChunk.id, score: 1.0, payload };
}

/** Sort: exact symbolId match first, then alphabetical by path. */
function sortResults(results: SearchResult[], query?: string): SearchResult[] {
  if (!query) return results;
  const q = query.toLowerCase();
  return results.sort((a, b) => {
    const aExact = String(a.payload?.symbolId ?? "").toLowerCase() === q ? 0 : 1;
    const bExact = String(b.payload?.symbolId ?? "").toLowerCase() === q ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    const aPath = String(a.payload?.relativePath ?? "");
    const bPath = String(b.payload?.relativePath ?? "");
    return aPath.localeCompare(bPath);
  });
}
