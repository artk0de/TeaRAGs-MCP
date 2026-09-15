/**
 * Symbol resolution — pure functions for merging/outlining chunks
 * returned by Qdrant scroll into find_symbol results.
 *
 * No I/O, no Qdrant dependency.
 */

import type { SearchResult } from "../../api/public/dto/explore.js";
import { CodeChunkGrouper } from "./chunk-grouping/code.js";
import { DocChunkGrouper } from "./chunk-grouping/doc.js";
import type { ScrollChunk } from "./chunk-grouping/types.js";

/**
 * A `parentType` naming a member CONTAINER — class, module or struct, whatever
 * the grammar calls it (`class_declaration`, `class_definition`, Ruby `class` /
 * `module`). Mirrors `CONTAINER_PARENT_TYPE` of the ingest symbol-mass pass,
 * which explore may not import; a member whose parentType is a function or a
 * call is nested code, not a class member.
 */
const CONTAINER_PARENT_TYPE = /class|module|struct/;

/** A class/module outline to render: its header and member groups. */
interface ContainerOutlinePlan {
  /** The class-level chunk, when the scroll holds one. */
  classChunk?: ScrollChunk;
  /** Heading of a synthesised outline — the queried container id. */
  containerSymbolId: string;
  /** Ids a member or test may name as its parentSymbolId. */
  ids: Set<string>;
  relativePath: string;
  memberGroups: ScrollChunk[][];
}

/**
 * Resolve raw scroll chunks into find_symbol results.
 *
 * Chunks are grouped by (symbolId, relativePath) with `#partN` fragments folded
 * under their base; each group lands in the FIRST strategy that claims it:
 *
 * 1. Class/module outline. A class-level chunk (`chunkType: "class"`, or a
 *    `block` whose parentType is a container) yields one outline per group,
 *    listing the member groups of its file whose parentSymbolId is the class
 *    symbolId OR its name — Ruby members point at the FQN, others at the local
 *    name. With no class-level chunk in the scroll (the TypeScript class body
 *    chunker emits only method chunks), a query naming the container still
 *    yields one outline per relativePath, synthesised from members whose
 *    parentSymbolId is the query and whose parentType is a container. An
 *    outline never carries a member body.
 * 2. Tests of an outlined class leave the response. A test group (chunkType
 *    `test` / `test_setup`, or `isTest`) from ANY file whose parentSymbolId
 *    names an outlined class — its symbolId or its name — is dropped: no
 *    `tests:` line on the outline, no merged spec body beside it. Tests are
 *    discovered through `hybrid_search` with `testFile: "only"`, not through
 *    find_symbol on the class. With no source class or member in the scroll
 *    nothing is outlined, so the tests merge per group like any other symbol —
 *    an empty find_symbol reads to an agent as a wrong separator.
 * 3. Doc TOC — only when the query IS the document path (the chunks'
 *    parentSymbolId). Several windows of one section share a `doc:<hash>` id,
 *    so "more than one doc chunk" is no signal that a TOC was asked for.
 * 4. Everything else merges per group: documentation windows are stitched by
 *    text (`DocChunkGrouper.mergeSection`), code chunks by startLine
 *    (`mergeChunks`).
 *
 * @param chunks - raw Qdrant scroll results
 * @param query - original symbol query (outline triggers + sort priority)
 * @param metaOnly - strip content from results (existence check)
 */
export function resolveSymbols(chunks: ScrollChunk[], query?: string, metaOnly?: boolean): SearchResult[] {
  const groups = [...groupChunks(chunks).values()];
  const results: SearchResult[] = [];
  const emittedIds = new Set<string | number>();
  const emit = (group: ScrollChunk[]): void => {
    for (const c of group) emittedIds.add(c.id);
  };
  const isPending = (group: ScrollChunk[]): boolean => group.some((c) => !emittedIds.has(c.id));

  // 1. Class/module outlines — from a class-level chunk, else synthesised.
  const plans = planClassChunkOutlines(groups);
  for (const plan of plans) plan.memberGroups.forEach(emit);
  for (const group of groups) if (group.some(isClassLevelChunk)) emit(group);
  if (query !== undefined) {
    for (const plan of planSynthesisedOutlines(groups.filter(isPending), query)) {
      plans.push(plan);
      plan.memberGroups.forEach(emit);
    }
  }
  for (const plan of plans) results.push(renderContainerOutline(plan));

  // 2. Tests of an outlined class are dropped from the response.
  const outlinedIds = new Set(plans.flatMap((plan) => [...plan.ids]));
  for (const group of groups) if (isTestGroup(group) && hasParentIn(group, outlinedIds)) emit(group);

  // 3. Doc TOC for a document-path query.
  if (query !== undefined) {
    const tocByPath = new Map<string, ScrollChunk[]>();
    for (const c of chunks) {
      if (emittedIds.has(c.id) || !c.payload.isDocumentation || c.payload.parentSymbolId !== query) continue;
      const list = tocByPath.get(relativePathOf(c));
      if (list) list.push(c);
      else tocByPath.set(relativePathOf(c), [c]);
    }
    for (const docChunks of tocByPath.values()) {
      results.push(DocChunkGrouper.group(docChunks));
      emit(docChunks);
    }
  }

  // 4. Everything left merges per group.
  for (const group of groups) {
    const pending = group.filter((c) => !emittedIds.has(c.id));
    if (pending.length === 0) continue;
    results.push(isDocumentationSection(pending) ? DocChunkGrouper.mergeSection(pending) : mergeChunks(pending));
  }

  const sorted = sortResults(results, query);

  if (metaOnly) {
    for (const r of sorted) {
      if (r.payload) delete r.payload.content;
    }
  }

  return sorted;
}

/**
 * One plan per group holding a class-level chunk. Members are the other
 * non-test groups of the same file naming the class (symbolId or name) as their
 * parent; the class's own group — a Ruby class body is several class-level
 * blocks sharing the class id — is the header, never a member of itself.
 */
function planClassChunkOutlines(groups: ScrollChunk[][]): ContainerOutlinePlan[] {
  const plans: ContainerOutlinePlan[] = [];
  for (const group of groups) {
    const classChunk = group.find(isClassLevelChunk);
    if (!classChunk) continue;
    const ids = new Set(
      [classChunk.payload.symbolId, classChunk.payload.name].filter((id): id is string => typeof id === "string"),
    );
    const relativePath = relativePathOf(classChunk);
    const memberGroups = groups.filter(
      (g) => g !== group && !isTestGroup(g) && relativePathOf(g[0]) === relativePath && hasParentIn(g, ids),
    );
    plans.push({
      classChunk,
      containerSymbolId: typeof classChunk.payload.symbolId === "string" ? classChunk.payload.symbolId : "",
      ids,
      relativePath,
      memberGroups,
    });
  }
  return plans;
}

/**
 * One plan per relativePath for a container the scroll holds no class-level
 * chunk for: groups whose parentSymbolId IS the query and whose parentType is a
 * container. The parentType gate keeps nested functions (`handler.inner` under
 * `handler`) as bodies.
 */
function planSynthesisedOutlines(pendingGroups: ScrollChunk[][], query: string): ContainerOutlinePlan[] {
  const membersByPath = new Map<string, ScrollChunk[][]>();
  for (const group of pendingGroups) {
    if (isTestGroup(group)) continue;
    const isMember = group.some((c) => c.payload.parentSymbolId === query && hasContainerParentType(c));
    if (!isMember) continue;
    const relativePath = relativePathOf(group[0]);
    const list = membersByPath.get(relativePath);
    if (list) list.push(group);
    else membersByPath.set(relativePath, [group]);
  }
  return [...membersByPath].map(([relativePath, memberGroups]) => ({
    containerSymbolId: query,
    ids: new Set([query]),
    relativePath,
    memberGroups,
  }));
}

function renderContainerOutline(plan: ContainerOutlinePlan): SearchResult {
  // A `#partN` fragment repeats its base member, whose chunk names it already.
  const memberChunks = plan.memberGroups.flat().filter((c) => splitFragmentBase(c.payload) === undefined);
  return plan.classChunk
    ? CodeChunkGrouper.group(plan.classChunk, memberChunks)
    : CodeChunkGrouper.groupMembers(plan.containerSymbolId, memberChunks);
}

function hasContainerParentType(c: ScrollChunk): boolean {
  return typeof c.payload.parentType === "string" && CONTAINER_PARENT_TYPE.test(c.payload.parentType);
}

function isClassLevelChunk(c: ScrollChunk): boolean {
  return c.payload.chunkType === "class" || (c.payload.chunkType === "block" && hasContainerParentType(c));
}

function isTestGroup(group: ScrollChunk[]): boolean {
  return group.some(
    (c) => c.payload.chunkType === "test" || c.payload.chunkType === "test_setup" || c.payload.isTest === true,
  );
}

function isDocumentationSection(group: ScrollChunk[]): boolean {
  return group.length > 1 && group.every((c) => c.payload.isDocumentation === true);
}

function hasParentIn(group: ScrollChunk[], ids: Set<string>): boolean {
  return group.some((c) => typeof c.payload.parentSymbolId === "string" && ids.has(c.payload.parentSymbolId));
}

function relativePathOf(c: ScrollChunk): string {
  return (c.payload.relativePath as string | undefined) ?? "";
}

/**
 * If `payload` is an oversized-method split fragment (`${parent}#partN`), return
 * its base method symbolId (the `parentSymbolId`); otherwise undefined. The
 * chunker emits parts as `${originalSymbolId}#part${i + 1}` with
 * `parentSymbolId = originalSymbolId` (see chunker `splitOversizedChunk`), so a
 * fragment is identified by `symbolId === parentSymbolId + "#part" + <digits>`.
 */
function splitFragmentBase(payload: Record<string, unknown>): string | undefined {
  const symbolId = payload.symbolId as string | undefined;
  const parentSymbolId = payload.parentSymbolId as string | undefined;
  if (!symbolId || !parentSymbolId) return undefined;
  const prefix = `${parentSymbolId}#part`;
  if (!symbolId.startsWith(prefix)) return undefined;
  return /^\d+$/.test(symbolId.slice(prefix.length)) ? parentSymbolId : undefined;
}

/** Group chunks by (symbolId, relativePath) composite key. Split fragments
 * (`#partN`) are keyed under their base method symbolId so all fragments of one
 * oversized method collapse into a single group. */
function groupChunks(chunks: ScrollChunk[]): Map<string, ScrollChunk[]> {
  const groups = new Map<string, ScrollChunk[]>();
  for (const chunk of chunks) {
    const symbolId = splitFragmentBase(chunk.payload) ?? (chunk.payload.symbolId as string | undefined) ?? "";
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

  // An oversized method is re-chunked into the base `#resolve` window(s) AND
  // `#partN` hard-cap fragments, which OVERLAP — concatenating them duplicates
  // the body. When any split fragment is present, present the head fragment
  // (smallest startLine — it begins at the method signature) as the single
  // canonical view. Genuinely disjoint same-symbol chunks (no `#partN`) still
  // concatenate, so a method split into sequential pieces stays whole.
  const hasSplitFragment = sorted.some((c) => splitFragmentBase(c.payload) !== undefined);
  const content = hasSplitFragment
    ? ((first.payload.content as string | undefined) ?? "")
    : sorted.map((c) => (c.payload.content as string | undefined) ?? "").join("\n");

  // When the group mixes the base method window with `#partN` fragments, the
  // base window carries the canonical identity (symbolId/name). Fall back to the
  // parent symbolId when only `#partN` fragments survived the scroll.
  const identity = sorted.find((c) => splitFragmentBase(c.payload) === undefined) ?? first;
  const baseSymbolId = splitFragmentBase(identity.payload) ?? (identity.payload.symbolId as string | undefined);
  const name = (identity.payload.name as string | undefined)?.replace(/ \(part \d+\/\d+\)$/, "");

  const payload: Record<string, unknown> = {
    ...identity.payload,
    symbolId: baseSymbolId,
    name,
    content,
    startLine: first.payload.startLine,
    endLine: last.payload.endLine,
    git: identity.payload.git ? { file: (identity.payload.git as Record<string, unknown>).file } : undefined,
  };

  if (sorted.length > 1) {
    payload.mergedChunkIds = sorted.map((c) => c.id);
  }

  return { id: identity.id, score: 1.0, payload };
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
