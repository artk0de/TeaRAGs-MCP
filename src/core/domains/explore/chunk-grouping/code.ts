/**
 * CodeChunkGrouper — groups code chunks into class outlines and file outlines.
 *
 * Pure data transformer, no I/O.
 */

import type { SearchResult } from "../../../api/public/dto/explore.js";
import { TEST_SCOPE_PARENT_TYPE } from "../../../contracts/types/chunker.js";
import { splitFragmentBase } from "../split-fragment.js";
import type { MemberVisibilityLookup, ScrollChunk } from "./types.js";

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
 * ` (private)` after a member whose declared visibility is known, nothing when
 * it is not — an unknown level is never rendered as public (bd
 * tea-rags-mcp-sqqkz).
 */
function visibilitySuffix(chunk: ScrollChunk, visibilityOf: MemberVisibilityLookup | undefined): string {
  const symbolId = chunk.payload.symbolId as string | undefined;
  if (visibilityOf === undefined || symbolId === undefined) return "";
  const level = visibilityOf((chunk.payload.relativePath as string | undefined) ?? "", symbolId);
  return level === undefined ? "" : ` (${level})`;
}

/**
 * One line per distinct member symbolId, in line order. A member the chunker
 * cut into several same-id windows (a Ruby class body, an oversized method
 * without `#partN`) is still ONE member of the outline.
 */
function memberLines(sortedMembers: ScrollChunk[], visibilityOf?: MemberVisibilityLookup): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const chunk of sortedMembers) {
    const symbolId = (chunk.payload.symbolId as string | undefined) ?? "";
    for (const id of addressesOf(chunk)) {
      if (seen.has(id)) continue;
      seen.add(id);
      lines.push(`  ${formatMember(id)}${id === symbolId ? visibilitySuffix(chunk, visibilityOf) : ""}`);
    }
  }
  return lines;
}

/**
 * The ids a chunk answers `find_symbol` for: its own, or — for a chunk grouping
 * several tiny test examples — every member's (bd tea-rags-mcp-5xpq4), so an
 * outline lists each example however it was stored.
 */
function addressesOf(chunk: ScrollChunk): string[] {
  const members = chunk.payload.exampleSymbolIds;
  if (Array.isArray(members) && members.length > 0) {
    return members.filter((id): id is string => typeof id === "string");
  }
  return [(chunk.payload.symbolId as string | undefined) ?? ""];
}

/** A DSL test chunk — an example, or a scope's setup. */
export function isTestChunk(chunk: ScrollChunk): boolean {
  const { chunkType } = chunk.payload;
  return chunkType === "test" || chunkType === "test_setup" || chunk.payload.isTest === true;
}

/**
 * A test EXAMPLE chunk (or a `#partN` window of one): its parentSymbolId names
 * a test scope, not a chunk. Setup-only scopes and chunks indexed before
 * examples were addressable carry the container's AST type instead.
 */
export function isTestExampleChunk(chunk: ScrollChunk): boolean {
  return chunk.payload.parentType === TEST_SCOPE_PARENT_TYPE;
}

/**
 * The outline lines of a test file's example chunks, keyed by the chunk that
 * opens them (bd tea-rags-mcp-msv3l). An example carries its SCOPE as
 * `parentSymbolId` (`User.context 'when admin'` for
 * `User.context 'when admin'.it 'can invite'`), and a scope has no chunk of its
 * own, so the scope line is drawn from that id, once, at its first example,
 * with every example of the scope nested under it — both lines are addresses
 * `find_symbol` answers. A `#partN` window of an oversized example stands for
 * the example: it is one line, filed under the longest scope id its base id
 * extends. Chunks absent from the map print nothing: a later member of a scope
 * already drawn.
 */
function testScopeLines(roots: ScrollChunk[]): Map<ScrollChunk, string[]> {
  const tests = roots.filter(isTestExampleChunk);
  const scopeIds = new Set(
    tests
      .filter((c) => splitFragmentBase(c.payload) === undefined)
      .map((c) => c.payload.parentSymbolId)
      .filter((id): id is string => typeof id === "string"),
  );
  const scopeOf = (id: string): string | undefined =>
    [...scopeIds].filter((scope) => id.startsWith(`${scope}.`)).sort((a, b) => b.length - a.length)[0];

  const opened = new Map<string, string[]>();
  const printed = new Set<string>();
  const byChunk = new Map<ScrollChunk, string[]>();
  for (const chunk of tests) {
    const base = splitFragmentBase(chunk.payload);
    const ids = (base !== undefined ? [base] : addressesOf(chunk)).filter((id) => !printed.has(id));
    const scope = base !== undefined ? scopeOf(base) : (chunk.payload.parentSymbolId as string | undefined);
    if (ids.length === 0) continue;
    for (const id of ids) printed.add(id);
    if (scope === undefined) {
      byChunk.set(
        chunk,
        ids.map((id) => `  ${id}`),
      );
      continue;
    }
    const existing = opened.get(scope);
    if (existing) {
      existing.push(...ids.map((id) => `    ${id}`));
      continue;
    }
    const block = [`  ${scope}`, ...ids.map((id) => `    ${id}`)];
    opened.set(scope, block);
    byChunk.set(chunk, block);
  }
  return byChunk;
}

/**
 * The scope ids a test file's example chunks draw as scope lines. A scope's own
 * setup chunk carries that id as its symbolId (bd tea-rags-mcp-5xpq4); the
 * scope line already addresses it, so it prints nothing of its own.
 */
function drawnScopeIds(roots: ScrollChunk[]): Set<string> {
  return new Set(
    roots
      .filter((c) => isTestExampleChunk(c) && splitFragmentBase(c.payload) === undefined)
      .map((c) => c.payload.parentSymbolId)
      .filter((id): id is string => typeof id === "string"),
  );
}

function contentSizeOf(chunks: ScrollChunk[]): number {
  return chunks.reduce((sum, c) => sum + ((c.payload.content as string | undefined) ?? "").length, 0);
}

export const CodeChunkGrouper = {
  /**
   * Group a class chunk with its member chunks into an outline result.
   * Replaces the inline `outlineClass` in symbol-resolve.ts.
   */
  group(classChunk: ScrollChunk, memberChunks: ScrollChunk[], visibilityOf?: MemberVisibilityLookup): SearchResult {
    const sorted = sortByLine(memberChunks);

    const className = (classChunk.payload.name as string | undefined) ?? "";
    const outlineContent = [className, ...memberLines(sorted, visibilityOf)].join("\n");

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
  groupMembers(
    containerSymbolId: string,
    memberChunks: ScrollChunk[],
    visibilityOf?: MemberVisibilityLookup,
  ): SearchResult {
    const sorted = sortByLine(memberChunks);
    const anchor = sorted[0];

    const payload: Record<string, unknown> = {
      symbolId: containerSymbolId,
      name: containerSymbolId,
      relativePath: anchor.payload.relativePath,
      language: anchor.payload.language,
      fileExtension: anchor.payload.fileExtension,
      content: [containerSymbolId, ...memberLines(sorted, visibilityOf)].join("\n"),
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
  groupFile(chunks: ScrollChunk[], visibilityOf?: MemberVisibilityLookup): SearchResult {
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
    // a bare `rerank` would lose the class it belongs to. Test chunks are drawn
    // by scope instead (see `testScopeLines`), each scope at its first example.
    const scopeLines = testScopeLines(roots);
    const scopeIds = drawnScopeIds(roots);
    const lines: string[] = [relativePath];
    for (const root of roots) {
      if (isTestExampleChunk(root)) {
        lines.push(...(scopeLines.get(root) ?? []));
        continue;
      }
      if (isTestChunk(root) && scopeIds.has((root.payload.symbolId as string | undefined) ?? "")) continue;
      const name = root.payload.name as string | undefined;
      const symbolId = root.payload.symbolId as string | undefined;
      const label = root.payload.parentSymbolId ? (symbolId ?? name ?? "") : (name ?? symbolId ?? "");
      lines.push(`  ${label}${visibilitySuffix(root, visibilityOf)}`);
      const children = name ? childrenByParent.get(name) : undefined;
      if (children) {
        for (const child of children) {
          const childId = (child.payload.symbolId as string | undefined) ?? "";
          lines.push(`    ${childId}${visibilitySuffix(child, visibilityOf)}`);
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
