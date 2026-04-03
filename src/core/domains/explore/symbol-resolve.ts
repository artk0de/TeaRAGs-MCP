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
 * @param metaOnly - strip content from results (existence check)
 */
export function resolveSymbols(chunks: ScrollChunk[], query?: string, metaOnly?: boolean): SearchResult[] {
  // Group by (symbolId, relativePath) for same-symbol merging
  const groups = groupChunks(chunks);
  const results: SearchResult[] = [];
  const emittedIds = new Set<string | number>();

  // First pass: find class chunks and collect their members from all chunks
  for (const group of groups.values()) {
    const classChunk = group.find(
      (c) =>
        c.payload.chunkType === "class" ||
        (c.payload.chunkType === "block" &&
          typeof c.payload.parentType === "string" &&
          c.payload.parentType.includes("class")),
    );
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

  // Second pass: collect doc chunks by parentName for doc outline
  const docByParent = new Map<string, ScrollChunk[]>();
  for (const group of groups.values()) {
    for (const c of group) {
      if (emittedIds.has(c.id)) continue;
      if (c.payload.isDocumentation && typeof c.payload.parentName === "string") {
        const key = `${String(c.payload.parentName)}::${String(c.payload.relativePath)}`;
        const list = docByParent.get(key);
        if (list) list.push(c);
        else docByParent.set(key, [c]);
      }
    }
  }

  // Emit doc outlines (only when multiple doc chunks share parentName, or query matches parentName)
  for (const [, docChunks] of docByParent) {
    if (docChunks.length > 1 || (query && docChunks[0].payload.parentName === query)) {
      results.push(outlineDoc(docChunks));
      for (const c of docChunks) emittedIds.add(c.id);
    }
  }

  // Third pass: handle remaining non-class, non-member, non-doc-outline chunks
  for (const group of groups.values()) {
    const unemitted = group.filter((c) => !emittedIds.has(c.id));
    if (unemitted.length === 0) continue;
    results.push(mergeChunks(unemitted));
  }

  const sorted = sortResults(results, query);

  if (metaOnly) {
    for (const r of sorted) {
      if (r.payload) delete r.payload.content;
    }
  }

  return sorted;
}

/** Group chunks by (symbolId, relativePath) composite key. */
function groupChunks(chunks: ScrollChunk[]): Map<string, ScrollChunk[]> {
  const groups = new Map<string, ScrollChunk[]>();
  for (const chunk of chunks) {
    const symbolId = (chunk.payload.symbolId as string | undefined) ?? "";
    const path = (chunk.payload.relativePath as string | undefined) ?? "";
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
  const sorted = [...chunks].sort((a, b) => (Number(a.payload.startLine) || 0) - (Number(b.payload.startLine) || 0));

  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const content = sorted.map((c) => (c.payload.content as string | undefined) ?? "").join("\n");

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
    .map((c) => (c.payload.symbolId as string | undefined) ?? "");

  const payload: Record<string, unknown> = {
    ...classChunk.payload,
    git: classChunk.payload.git ? { file: (classChunk.payload.git as Record<string, unknown>).file } : undefined,
    ...(members.length > 0 ? { members } : {}),
  };

  return { id: classChunk.id, score: 1.0, payload };
}

/** Outline a doc file: merged headingPath + members list (symbolIds). */
function outlineDoc(chunks: ScrollChunk[]): SearchResult {
  const sorted = [...chunks].sort((a, b) => (Number(a.payload.startLine) || 0) - (Number(b.payload.startLine) || 0));
  const first = sorted[0];

  // Merge unique headingPath entries (deduplicate by depth+text)
  const seen = new Set<string>();
  const mergedHeadingPath: { depth: number; text: string }[] = [];
  for (const c of sorted) {
    const hp = c.payload.headingPath as { depth: number; text: string }[] | undefined;
    if (!hp) continue;
    for (const entry of hp) {
      const key = `${entry.depth}:${entry.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        mergedHeadingPath.push(entry);
      }
    }
  }

  const members = sorted.map((c) => (c.payload.symbolId as string | undefined) ?? "");

  const payload: Record<string, unknown> = {
    relativePath: first.payload.relativePath,
    language: first.payload.language,
    isDocumentation: true,
    parentName: first.payload.parentName,
    startLine: first.payload.startLine,
    endLine: sorted[sorted.length - 1].payload.endLine,
    headingPath: mergedHeadingPath,
    members,
    git: first.payload.git ? { file: (first.payload.git as Record<string, unknown>).file } : undefined,
  };

  return { id: first.id, score: 1.0, payload };
}

/** Sort: exact symbolId match first, then alphabetical by path. */
function sortResults(results: SearchResult[], query?: string): SearchResult[] {
  if (!query) return results;
  const q = query.toLowerCase();
  return results.sort((a, b) => {
    const aExact = ((a.payload?.symbolId as string | undefined) ?? "").toLowerCase() === q ? 0 : 1;
    const bExact = ((b.payload?.symbolId as string | undefined) ?? "").toLowerCase() === q ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    const aPath = (a.payload?.relativePath as string | undefined) ?? "";
    const bPath = (b.payload?.relativePath as string | undefined) ?? "";
    return aPath.localeCompare(bPath);
  });
}
