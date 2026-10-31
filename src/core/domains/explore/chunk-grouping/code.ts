/**
 * CodeChunkGrouper — groups code chunks into class outlines and file outlines.
 *
 * Pure data transformer, no I/O.
 */

import { TEST_SCOPE_PARENT_TYPE } from "../../../contracts/types/chunker.js";
import type { SearchResult } from "../../../contracts/types/search-result.js";
import { CONTAINER_HEADER_DRAFT_KEY, draftContainerHeader, spendContainerHeaderAllowance } from "./container-header.js";
import { splitFragmentBase } from "./split-fragment.js";
import type { ContainerAncestorLookup, MemberVisibilityLookup, ScrollChunk } from "./types.js";

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
/** A trailing ` (visibility)` or ` L<start>-<end>` an outline line adds after its id. */
const OUTLINE_LINE_SUFFIX = / +(?:L\d+[-–]\d+|\((?:public|private|protected)\))$/;

/**
 * The address an outline line stands for: the line trimmed, its line-range and
 * declared-visibility suffixes dropped (bd tea-rags-mcp-9f0yn.1). The inverse of
 * the line this module draws, so a line pasted back verbatim still resolves;
 * an id holding spaces (`X.include KindOfService`) keeps them.
 */
export function outlineAddressOf(line: string): string {
  let address = line.trim();
  for (;;) {
    const stripped = address.replace(OUTLINE_LINE_SUFFIX, "");
    if (stripped === address) return address;
    address = stripped;
  }
}

type OwnLineRanges = Map<string, [start: number, end: number]>;

/** Per outline id, min start / max end over the chunks it owns — same-id windows merge. */
function ownLineRanges(rows: readonly ScrollChunk[]): OwnLineRanges {
  const ranges: OwnLineRanges = new Map();
  for (const row of rows) {
    const id = outlineIdOf(row);
    const start = Number(row.payload.startLine);
    const end = Number(row.payload.endLine);
    if (!id || !Number.isFinite(start) || !Number.isFinite(end) || start <= 0) continue;
    const seen = ranges.get(id);
    ranges.set(id, seen ? [Math.min(seen[0], start), Math.max(seen[1], end)] : [start, end]);
  }
  return ranges;
}

/** Widen each container's range over its members' (`X` covers `X#m`, `X.m`, `X::Y`). */
function spanContainers(ranges: OwnLineRanges): void {
  for (const [id, range] of ranges) {
    for (const [other, [start, end]] of ranges) {
      if (other.startsWith(`${id}#`) || other.startsWith(`${id}.`) || other.startsWith(`${id}::`)) {
        range[0] = Math.min(range[0], start);
        range[1] = Math.max(range[1], end);
      }
    }
  }
}

/** ` L<start>-<end>` for an id that owns chunks; a declaration-only id carries none. */
function lineRangeSuffix(ranges: OwnLineRanges, id: string): string {
  const range = ranges.get(id);
  return range ? ` L${range[0]}-${range[1]}` : "";
}

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
function visibilitySuffix(row: ScrollChunk, visibilityOf: MemberVisibilityLookup | undefined): string {
  const symbolId = outlineIdOf(row);
  if (visibilityOf === undefined || symbolId === undefined) return "";
  const level = visibilityOf((row.payload.relativePath as string | undefined) ?? "", symbolId);
  return level === undefined ? "" : ` (${level})`;
}

/**
 * One line per direct ancestor of the container, in the lookup's order (bd
 * tea-rags-mcp-82cot): `  extends <id>` for a superclass, `  <kind> <id>` for
 * every other inheritance kind. The id is the ancestor's resolved symbolId — the
 * address `find_symbol` answers; an ancestor the index never resolved to a
 * symbol keeps its name as written and says so, so it is never taken for an
 * indexed address.
 */
function ancestorLines(containerSymbolId: string, ancestorsOf: ContainerAncestorLookup | undefined): string[] {
  return (ancestorsOf?.(containerSymbolId) ?? []).map((edge) => {
    const keyword = edge.kind === "super" ? "extends" : edge.kind;
    return edge.ancestorSymbolId === null
      ? `  ${keyword} ${edge.ancestorFqName} (unresolved)`
      : `  ${keyword} ${edge.ancestorSymbolId}`;
  });
}

/**
 * One line per distinct member symbolId, in line order. A member the chunker
 * cut into several same-id windows (a Ruby class body, an oversized method
 * without `#partN`) is still ONE member of the outline.
 */
function memberLines(sortedMembers: ScrollChunk[], visibilityOf?: MemberVisibilityLookup): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  const ranges = ownLineRanges(sortedMembers);
  for (const chunk of sortedMembers) {
    const symbolId = outlineIdOf(chunk) ?? "";
    for (const id of addressesOf(chunk)) {
      if (id === "" || seen.has(id)) continue;
      seen.add(id);
      const visibility = id === symbolId ? visibilitySuffix(chunk, visibilityOf) : "";
      lines.push(`  ${formatMember(id)}${visibility}${lineRangeSuffix(ranges, id)}`);
    }
  }
  return lines;
}

/**
 * The ids a chunk answers `find_symbol` for: its own, or — for a packed test
 * chunk (tiny examples grouped, or several scopes' setup) — every member's (bd
 * tea-rags-mcp-5xpq4), so an outline lists each member however it was stored.
 */
function addressesOf(chunk: ScrollChunk): string[] {
  const members = chunk.payload.memberSymbolIds;
  if (Array.isArray(members) && members.length > 0) {
    return members.filter((id): id is string => typeof id === "string");
  }
  return [outlineIdOf(chunk) ?? ""];
}

/**
 * The id an outline line names for a chunk: a `#partN` window stands for its
 * symbol (`Foo#bar#part2` → `Foo#bar`), so the windows of one oversized method
 * draw ONE drillable line — `find_symbol` merges the parts on that id.
 */
function outlineIdOf(row: ScrollChunk): string | undefined {
  return splitFragmentBase(row.payload) ?? (row.payload.symbolId as string | undefined);
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

/**
 * The line a file-outline root draws: a member is named by its qualified id (a
 * bare `rerank` loses its class), a top-level symbol by its name.
 */
function rootLabelOf(row: ScrollChunk): string {
  const name = row.payload.name as string | undefined;
  const symbolId = outlineIdOf(row);
  return (row.payload.parentSymbolId ? (symbolId ?? name) : (name ?? symbolId)) ?? "";
}

/**
 * The member ids each outline line's code chunks declare in
 * `memberSymbolIds` (bd tea-rags-mcp-1x85g: a class-body chunker packs
 * constants and short defs into the container's header window), keyed by the
 * line the chunk draws, in line order, each id once. Test chunks are drawn by
 * scope instead and never contribute.
 */
function declaredMembersByLabel(
  roots: ScrollChunk[],
  childrenByParent: Map<string, ScrollChunk[]>,
): Map<string, string[]> {
  const labelled = [
    ...roots.map((row) => ({ row, label: rootLabelOf(row) })),
    ...[...childrenByParent.values()].flat().map((row) => ({ row, label: outlineIdOf(row) ?? "" })),
  ].sort((a, b) => (Number(a.row.payload.startLine) || 0) - (Number(b.row.payload.startLine) || 0));
  const byLabel = new Map<string, string[]>();
  for (const { row, label } of labelled) {
    const members = row.payload.memberSymbolIds;
    if (label === "" || isTestChunk(row) || !Array.isArray(members)) continue;
    const list = byLabel.get(label) ?? [];
    for (const id of members) {
      if (typeof id === "string" && id !== label && !list.includes(id)) list.push(id);
    }
    byLabel.set(label, list);
  }
  return byLabel;
}

function contentSizeOf(chunks: ScrollChunk[]): number {
  return chunks.reduce((sum, c) => sum + ((c.payload.content as string | undefined) ?? "").length, 0);
}

export const CodeChunkGrouper = {
  /**
   * Group a class chunk with its member chunks into an outline result.
   * Replaces the inline `outlineClass` in symbol-resolve.ts.
   */
  group(
    classChunk: ScrollChunk,
    memberChunks: ScrollChunk[],
    visibilityOf?: MemberVisibilityLookup,
    declaringWindows: ScrollChunk[] = [],
    rows: ScrollChunk[] = [],
    ancestorsOf?: ContainerAncestorLookup,
  ): SearchResult {
    const sorted = sortByLine(memberChunks);

    const className = (classChunk.payload.name as string | undefined) ?? "";
    // A class-level window that declares members without chunks of their own
    // (Ruby constants, `memberSymbolIds` — bd tea-rags-mcp-1x85g) lists them
    // among the members, in line order; the window itself stays the header's.
    const lines = memberLines(sortByLine([...memberChunks, ...declaringWindows]), visibilityOf);
    // The header chunks themselves: listed, then inlined whole while the
    // per-class budget holds (`renderContainerHeader`); the draft rides the
    // payload so the answer's shared budget can re-render the row smaller.
    const containerId = typeof classChunk.payload.symbolId === "string" ? classChunk.payload.symbolId : className;
    const ancestors = ancestorLines(containerId, ancestorsOf);
    const draft = rows.length > 0 ? draftContainerHeader(containerId, className, ancestors, lines, rows) : undefined;
    const outlineContent = [className, ...ancestors, ...lines].join("\n");

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
      // The class's last line, not its last member's: a class-level window can
      // follow the last method (a Ruby class body tail, bd tea-rags-mcp-q1g6s.12).
      endLine: Math.max(...allChunks.map((c) => Number(c.payload.endLine) || 0)),
      git: fileGit(classChunk),
      codegraph: fileCodegraph(classChunk),
      chunkCount: allChunks.length,
      contentSize: contentSizeOf(allChunks),
      ...(draft ? { [CONTAINER_HEADER_DRAFT_KEY]: draft } : {}),
    };

    const outline: SearchResult = { id: classChunk.id, score: 1.0, payload };
    // A row carrying header code is no longer outline-only: `kind` says so,
    // `mergedChunkIds` names the chunks whose text it carries (batch dedupe).
    return spendContainerHeaderAllowance(outline, Infinity)?.result ?? outline;
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
    ancestorsOf?: ContainerAncestorLookup,
  ): SearchResult {
    const sorted = sortByLine(memberChunks);
    const anchor = sorted[0];

    const payload: Record<string, unknown> = {
      symbolId: containerSymbolId,
      name: containerSymbolId,
      relativePath: anchor.payload.relativePath,
      language: anchor.payload.language,
      fileExtension: anchor.payload.fileExtension,
      content: [
        containerSymbolId,
        ...ancestorLines(containerSymbolId, ancestorsOf),
        ...memberLines(sorted, visibilityOf),
      ].join("\n"),
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
    // An unnamed block chunk (top-level statements between declarations) has
    // no address, and the windows of one split symbol share one: neither draws
    // a line of its own.
    const drawn = new Set<string>();
    const declared = declaredMembersByLabel(roots, childrenByParent);
    // Each drawn id ends in its line range; a container line spans its members.
    const ranges = ownLineRanges(sorted);
    spanContainers(ranges);
    const draw = (indent: string, label: string, row: ScrollChunk): void => {
      if (label === "" || drawn.has(label)) return;
      drawn.add(label);
      lines.push(
        `${indent}${label}${visibilitySuffix(row, visibilityOf)}${lineRangeSuffix(ranges, outlineIdOf(row) ?? "")}`,
      );
      // Members a class-level window declares without chunks of their own
      // (constants, short defs) are addresses too: listed under the container,
      // undecorated, as `CodeChunkGrouper.group` lists them.
      for (const id of declared.get(label) ?? []) {
        if (drawn.has(id)) continue;
        drawn.add(id);
        lines.push(`${indent}  ${id}`);
      }
    };
    for (const root of roots) {
      if (isTestExampleChunk(root)) {
        lines.push(...(scopeLines.get(root) ?? []));
        continue;
      }
      if (isTestChunk(root)) {
        // A setup chunk packs the setup of several scopes (bd
        // tea-rags-mcp-5xpq4): a member whose scope line is drawn folds into
        // it, the others print one line each.
        const undrawn = addressesOf(root).filter((id) => !scopeIds.has(id));
        if (undrawn.length === 0) continue;
        if (Array.isArray(root.payload.memberSymbolIds)) {
          lines.push(...undrawn.map((id) => `  ${id}`));
          continue;
        }
      }
      const name = root.payload.name as string | undefined;
      draw("  ", rootLabelOf(root), root);
      const children = name ? childrenByParent.get(name) : undefined;
      if (children) {
        for (const child of children) draw("    ", outlineIdOf(child) ?? "", child);
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
