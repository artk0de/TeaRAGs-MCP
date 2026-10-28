/**
 * TypeScript Class Body Chunker — AST-based.
 *
 * Classifies non-method class body elements by AST node type + modifiers,
 * then groups adjacent same-type elements into body chunks.
 *
 * Classification:
 *   public_field_definition + decorator child  → decorated_members
 *   public_field_definition + abstract modifier → abstract_members
 *   public_field_definition + static modifier   → static_members
 *   public_field_definition (plain)             → properties
 *   class_static_block                          → static_members
 *   abstract_method_signature                   → abstract_members
 *   everything else                             → other
 *
 * A method_definition the engine did not extract as a child (under its 50-char
 * floor) forms no group of its own: it joins the group around it.
 *
 * Decorator is checked BEFORE static/abstract — a @Inject() static field
 * is classified as decorated_members, not static_members.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import {
  bodyChunkContentBudget,
  type BodyChunkResult,
  type ChunkingHook,
  type HookContext,
} from "../../../../contracts/types/chunker.js";
import { classifyMethod, isStaticMethodNode, type MethodClassification } from "../../../../primitives/ids/index.js";
import { foldSubFloorGroups } from "../../kernel/index.js";
import { findClassBody } from "./utils.js";

// ── Classification ────────────────────────────────────────────────

type GroupType = "properties" | "static_members" | "decorated_members" | "abstract_members" | "other";

/**
 * A `method_definition` the engine did NOT extract as a child — under its
 * 50-char child floor, e.g. `constructor(_cfg: Config) {}` — has no chunk of
 * its own, and once this hook claims the container the engine's remainder
 * stays out too. It rides the neighbouring body group (with its leading
 * comment) instead of being lost (bd tea-rags-mcp-u7tjf). It never forms a
 * group of its own: that would add a second body chunk under the container's
 * id where the class had one.
 */
const NEIGHBOUR_MEMBER = "neighbour" as const;

/**
 * Classify a class_body child node into a group type.
 * Returns undefined for nodes that should be skipped (extracted methods, comments).
 * `extractedStarts` holds the start offsets of the container's `validChildren`.
 */
function classifyNode(
  node: AstNode,
  extractedStarts: ReadonlySet<number>,
): GroupType | typeof NEIGHBOUR_MEMBER | undefined {
  const { type } = node;

  // Skip comments (they ride the member below them) and extracted methods.
  if (type === "comment") return undefined;
  if (type === "method_definition") return extractedStarts.has(node.startIndex) ? undefined : NEIGHBOUR_MEMBER;

  // class_static_block → static_members
  if (type === "class_static_block") return "static_members";

  // abstract_method_signature → abstract_members
  if (type === "abstract_method_signature") return "abstract_members";

  // public_field_definition — check modifiers in priority order
  if (type === "public_field_definition") {
    // Check decorator FIRST (highest priority)
    if (hasChildOfType(node, "decorator")) return "decorated_members";
    // Check abstract
    if (hasModifier(node, "abstract")) return "abstract_members";
    // Check static — through the SHARED predicate, not a local copy of it.
    // bd tea-rags-mcp-5ldqu made the codegraph walker compose a field-bound
    // arrow as `Class#field` / `Class.field`, and it decides that by asking
    // `classifyMethod` about this same node. Sharing the predicate is what makes
    // the two answers structurally incapable of drifting
    // (`.claude/rules/symbolid-convention.md`).
    if (isStaticMethodNode(node)) return "static_members";
    // Plain property
    return "properties";
  }

  // Everything else
  return "other";
}

/**
 * Check if a node has a direct child of the given type.
 */
function hasChildOfType(node: AstNode, childType: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child?.type === childType) return true;
  }
  return false;
}

/**
 * Check if a node has a modifier keyword (abstract, static, etc.)
 * by looking for unnamed children matching the keyword text.
 */
function hasModifier(node: AstNode, modifier: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && !child.isNamed && child.type === modifier) return true;
  }
  return false;
}

// ── Grouping ──────────────────────────────────────────────────────

interface NodeGroup {
  type: GroupType;
  nodes: AstNode[];
  /**
   * The 0-based rows this group writes, set only on a piece cut from a node
   * too large for the budget; absent, the rows are each node's own plus its
   * leading comments (`groupRows`).
   */
  rows?: number[];
}

/**
 * Group adjacent same-type nodes from class_body. A `NEIGHBOUR_MEMBER` joins
 * the group open at its position — the first group, when it precedes every
 * typed member. A class with no typed member forms no group, writes no body
 * chunk, and the engine's container remainder carries its short methods.
 */
function groupAdjacentNodes(
  classBody: AstNode,
  excludedRows: Set<number>,
  extractedStarts: ReadonlySet<number>,
): NodeGroup[] {
  const groups: NodeGroup[] = [];
  let currentType: GroupType | null = null;
  let currentNodes: AstNode[] = [];
  let pendingNeighbours: AstNode[] = [];

  const flush = () => {
    if (currentNodes.length > 0 && currentType) {
      groups.push({ type: currentType, nodes: [...currentNodes] });
    }
    currentNodes = [];
    currentType = null;
  };

  for (let i = 0; i < classBody.namedChildCount; i++) {
    const child = classBody.namedChild(i);
    if (!child) continue;

    // Skip if row is excluded
    if (excludedRows.has(child.startPosition.row)) continue;

    const nodeType = classifyNode(child, extractedStarts);
    if (nodeType === undefined) continue; // skip methods, comments

    if (nodeType === NEIGHBOUR_MEMBER) {
      if (currentType) currentNodes.push(child);
      else pendingNeighbours.push(child);
    } else if (nodeType === currentType) {
      currentNodes.push(child);
    } else {
      flush();
      currentType = nodeType;
      currentNodes = [...pendingNeighbours, child];
      pendingNeighbours = [];
    }
  }

  flush();
  return groups;
}

// ── Class header extraction ───────────────────────────────────────

/**
 * Extract the class declaration header for context injection: "export class
 * Foo extends Bar {", or undefined. A header whose heritage or type parameters
 * run over several rows keeps every row through the body's opening brace —
 * `extends` / `implements` on rows of their own were in no chunk (bd
 * tea-rags-mcp-gkvvo).
 */
function extractClassHeader(containerNode: AstNode, classBody: AstNode, codeLines: string[]): string | undefined {
  const startRow = containerNode.startPosition.row;
  const firstLine = codeLines[startRow];
  if (!firstLine || !/^\s*(export\s+)?(abstract\s+)?class\s+/.test(firstLine)) return undefined;
  const continuation = codeLines.slice(startRow + 1, classBody.startPosition.row + 1).map((line) => line.trimEnd());
  return [firstLine.trim(), ...continuation].join("\n");
}

// ── Body chunk extraction ─────────────────────────────────────────

/**
 * Collect non-excluded comment nodes immediately preceding a given node.
 * Returns comment nodes in source order (top to bottom).
 */
function collectPrecedingComments(node: AstNode, excludedRows: Set<number>): AstNode[] {
  const commentNodes: AstNode[] = [];
  let sibling = node.previousNamedSibling;

  while (sibling?.type === "comment") {
    // A comment trailing the previous member on its own row is that member's
    // row, not a leading comment of this one: claiming it here wrote the row
    // twice (bd tea-rags-mcp-gkvvo).
    const before = sibling.previousNamedSibling;
    if (before && before.type !== "comment" && before.endPosition.row === sibling.startPosition.row) break;
    if (!excludedRows.has(sibling.startPosition.row)) {
      commentNodes.unshift(sibling);
    }
    sibling = sibling.previousNamedSibling;
  }

  return commentNodes;
}

/** 0-based rows of a node and its leading comments, in source order. */
function nodeRows(node: AstNode, excludedRows: Set<number>): number[] {
  const rows: number[] = [];
  for (const unit of [...collectPrecedingComments(node, excludedRows), node]) {
    for (let { row } = unit.startPosition; row <= unit.endPosition.row; row++) rows.push(row);
  }
  return rows;
}

/** 0-based rows a group writes, in source order. */
function groupRows(group: NodeGroup, excludedRows: Set<number>): number[] {
  return group.rows ?? group.nodes.flatMap((node) => nodeRows(node, excludedRows));
}

/** The text a group writes for `rows`, as the chunk content carries it. */
function rowsText(rows: number[], codeLines: string[]): string {
  return rows
    .map((row) => codeLines[row])
    .join("\n")
    .trim();
}

/**
 * Extract content for a group of nodes, including preceding comments
 * for each node in the group.
 */
function extractGroupContent(
  group: NodeGroup,
  codeLines: string[],
  excludedRows: Set<number>,
): { content: string; startLine: number; endLine: number; lineRanges: { start: number; end: number }[] } | null {
  if (group.nodes.length === 0) return null;

  const allRows = groupRows(group, excludedRows);
  const contentLines = allRows.map((row) => codeLines[row]);

  allRows.sort((a, b) => a - b);

  if (allRows.length === 0) return null;

  // Convert to 1-based line numbers, guarantee at least 1 line span
  const startLine = allRows[0] + 1;
  const endLine = Math.max(allRows[0] + 2, allRows[allRows.length - 1] + 1);

  // Compute line ranges (1-based, non-contiguous)
  const lineRanges = computeLineRanges(allRows.map((r) => r + 1));

  return {
    content: contentLines.join("\n").trim(),
    startLine,
    endLine,
    lineRanges,
  };
}

/**
 * Compute non-contiguous line ranges from sorted 1-based line numbers.
 */
function computeLineRanges(lines: number[]): { start: number; end: number }[] {
  if (lines.length === 0) return [];

  const ranges: { start: number; end: number }[] = [];
  let rangeStart = lines[0];
  let rangeEnd = lines[0];

  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === rangeEnd + 1) {
      rangeEnd = lines[i];
    } else {
      ranges.push({ start: rangeStart, end: rangeEnd });
      rangeStart = lines[i];
      rangeEnd = lines[i];
    }
  }

  ranges.push({ start: rangeStart, end: rangeEnd });
  return ranges;
}

/**
 * Groups whose rows exceed `budget` cut into pieces that fit, each carrying
 * exactly its own rows (bd tea-rags-mcp-gkvvo). A group packs whole members
 * greedily in source order; a member larger than the budget on its own (a
 * long object-literal field initializer) is cut at line boundaries into
 * row-explicit pieces. The old split cut the finished chunk TEXT and gave every
 * piece the group's first line plus an offset, and the whole group's ranges —
 * a group spanning methods then claimed the method rows and lost its own.
 */
function splitOversizedGroups(
  groups: NodeGroup[],
  budget: number,
  codeLines: string[],
  excludedRows: Set<number>,
): NodeGroup[] {
  const fits = (rows: number[]): boolean => rowsText(rows, codeLines).length <= budget;
  const nodeGroups: NodeGroup[] = [];
  for (const group of groups) {
    if (fits(groupRows(group, excludedRows))) {
      nodeGroups.push(group);
      continue;
    }
    let packed: AstNode[] = [];
    const flushPacked = () => {
      if (packed.length > 0) nodeGroups.push({ type: group.type, nodes: packed });
      packed = [];
    };
    for (const node of group.nodes) {
      const rows = nodeRows(node, excludedRows);
      if (!fits(rows)) {
        flushPacked();
        nodeGroups.push(
          ...cutRowsToBudget(rows, fits).map((pieceRows) => ({ type: group.type, nodes: [node], rows: pieceRows })),
        );
        continue;
      }
      if (!fits(packed.flatMap((member) => nodeRows(member, excludedRows)).concat(rows))) flushPacked();
      packed.push(node);
    }
    flushPacked();
  }
  return nodeGroups;
}

/** `rows` cut at line boundaries into runs that each fit; a row wider than the budget stays a run of its own. */
function cutRowsToBudget(rows: number[], fits: (rows: number[]) => boolean): number[][] {
  const pieces: number[][] = [];
  let piece: number[] = [];
  for (const row of rows) {
    if (piece.length > 0 && !fits([...piece, row])) {
      pieces.push(piece);
      piece = [];
    }
    piece.push(row);
  }
  if (piece.length > 0) pieces.push(piece);
  return pieces;
}

/** Two groups as one: their members, and their rows when either is a cut piece. */
function mergeNodeGroups(host: NodeGroup, guest: NodeGroup, excludedRows: Set<number>): NodeGroup {
  const nodes = [...new Map([...host.nodes, ...guest.nodes].map((node) => [node.startIndex, node])).values()].sort(
    (a, b) => a.startIndex - b.startIndex,
  );
  if (!host.rows && !guest.rows) return { type: host.type, nodes };
  const rows = [...new Set([...groupRows(host, excludedRows), ...groupRows(guest, excludedRows)])].sort(
    (a, b) => a - b,
  );
  return { type: host.type, nodes, rows };
}

// ── Small body chunk merging ──────────────────────────────────────

/** Content length below which a body chunk is a merge candidate. */
const BODY_MERGE_THRESHOLD = 200;

/**
 * Merge adjacent small body chunks into larger ones.
 * Prevents excessive fragmentation from fine-grained grouping.
 */
function mergeSmallBodyChunks(
  chunks: BodyChunkResult[],
  classHeader: string | undefined,
  maxChunkSize: number,
): BodyChunkResult[] {
  if (chunks.length <= 1) return chunks;

  const headerPrefix = classHeader ? `${classHeader}\n` : "";
  const results: BodyChunkResult[] = [];
  let pending: BodyChunkResult[] = [];

  const flush = () => {
    if (pending.length === 0) return;
    if (pending.length === 1) {
      results.push(pending[0]);
    } else {
      // Merge pending chunks: strip headers, join body lines, re-add single header
      const bodyParts = pending.map((c) =>
        classHeader && c.content.startsWith(headerPrefix) ? c.content.slice(headerPrefix.length) : c.content,
      );
      const mergedContent = `${headerPrefix}${bodyParts.join("\n")}`.trim();
      const mergedRanges = pending.flatMap((c) => c.lineRanges ?? []);
      results.push({
        content: mergedContent,
        startLine: Math.min(...pending.map((c) => c.startLine)),
        endLine: Math.max(...pending.map((c) => c.endLine)),
        lineRanges: mergedRanges,
      });
    }
    pending = [];
  };

  for (const chunk of chunks) {
    const isSmall = chunk.content.length < BODY_MERGE_THRESHOLD;
    if (isSmall) {
      // Check if adding to pending would exceed maxChunkSize
      const pendingSize = pending.reduce((sum, c) => sum + c.content.length, 0);
      if (pendingSize + chunk.content.length > maxChunkSize && pending.length > 0) {
        flush();
      }
      pending.push(chunk);
    } else {
      flush();
      results.push(chunk);
    }
  }
  flush();

  return results;
}

/**
 * Characters a group's own rows may spend: the engine's content budget
 * (`bodyChunkContentBudget`, which reserves the hierarchy plus ONE header row)
 * less the header continuation rows this hook writes on top. With no engine
 * reservation (a hook driven directly) the hook's own header is reserved, so
 * the written chunk stays within `maxChunkSize` either way.
 */
function groupContentBudget(ctx: HookContext, classHeader: string | undefined): number {
  if (!classHeader) return bodyChunkContentBudget(ctx.config);
  const firstRow = classHeader.split("\n", 1)[0];
  const reserved = ctx.config.bodyChunkPrefixLength ?? firstRow.length + 1;
  return (
    bodyChunkContentBudget({ maxChunkSize: ctx.config.maxChunkSize, bodyChunkPrefixLength: reserved }) -
    (classHeader.length - firstRow.length)
  );
}

/**
 * Extract body chunks from a TypeScript class with AST-based semantic grouping.
 */
export function extractBodyChunks(ctx: HookContext): BodyChunkResult[] {
  const classBody = findClassBody(ctx.containerNode);
  if (!classBody) return [];

  const extractedStarts = new Set(ctx.validChildren.map((child) => child.startIndex));
  const classHeader = extractClassHeader(ctx.containerNode, classBody, ctx.codeLines);
  const withHeader = (content: string): string => (classHeader ? `${classHeader}\n${content}` : content);
  const groupContent = (group: NodeGroup): string =>
    extractGroupContent(group, ctx.codeLines, ctx.excludedRows)?.content ?? "";
  const budget = groupContentBudget(ctx, classHeader);
  const shortMethods = classBodyShortMethods(classBody, extractedStarts, ctx.excludedRows);
  // An oversized group is cut into row-accurate pieces first (bd
  // tea-rags-mcp-gkvvo); a sub-floor group then folds into a neighbour instead
  // of being dropped (bd tea-rags-mcp-xiki8, the TypeScript twin of 30qdc); a
  // group holding a short method declares a member and is never noise.
  const adjacentGroups = groupAdjacentNodes(classBody, ctx.excludedRows, extractedStarts);
  const groups = foldSubFloorGroups(splitOversizedGroups(adjacentGroups, budget, ctx.codeLines, ctx.excludedRows), {
    isSubFloor: (group) =>
      withHeader(groupContent(group)).length < 50 && !group.nodes.some((node) => shortMethods.has(node.startIndex)),
    fits: (group) => groupContent(group).length <= budget,
    merge: (host, guest) => mergeNodeGroups(host, guest, ctx.excludedRows),
    startOf: (group) => groupRows(group, ctx.excludedRows)[0],
  });
  const results: BodyChunkResult[] = [];

  for (const group of groups) {
    const extracted = extractGroupContent(group, ctx.codeLines, ctx.excludedRows);
    if (!extracted) continue;

    // Prepend class header for context
    const contentWithContext = withHeader(extracted.content);

    results.push({
      content: contentWithContext,
      startLine: extracted.startLine,
      endLine: extracted.endLine,
      lineRanges: extracted.lineRanges,
    });
  }

  return declareShortMethods(mergeSmallBodyChunks(results, classHeader, ctx.config.maxChunkSize), shortMethods);
}

type ShortMethod = { name: string; methodKind: MethodClassification; line: number };

/**
 * The methods a class body declares that the engine did not extract as
 * children — a `method_definition` under its 50-char child floor (`get id() {
 * return 1; }`), keyed by start offset (bd tea-rags-mcp-xiki8). Their rows ride
 * a body chunk as neighbour members (bd tea-rags-mcp-u7tjf); the chunk holding
 * the method's first row declares it, so `find_symbol("Owner#id")` answers
 * through it. Rows a comment hook excluded are skipped, as the grouper skips them.
 */
function classBodyShortMethods(
  classBody: AstNode,
  extractedStarts: ReadonlySet<number>,
  excludedRows: Set<number>,
): Map<number, ShortMethod> {
  const methods = new Map<number, ShortMethod>();
  for (const node of classBody.namedChildren) {
    if (node.type !== "method_definition" || extractedStarts.has(node.startIndex)) continue;
    if (excludedRows.has(node.startPosition.row)) continue;
    const name = node.childForFieldName("name");
    const methodKind = classifyMethod(node);
    if (!name || !methodKind) continue;
    methods.set(node.startIndex, { name: name.text, methodKind, line: node.startPosition.row + 1 });
  }
  return methods;
}

/**
 * Each short method declared by the first body chunk whose rows hold its first
 * line, as `BodyChunkResult.declaredMethodMembers` in source order; the engine
 * composes them into `memberSymbolIds` (`Owner#m` / `Owner.m`). Accessor twins
 * share one id, so a chunk declares it once.
 */
function declareShortMethods(chunks: BodyChunkResult[], shortMethods: Map<number, ShortMethod>): BodyChunkResult[] {
  if (shortMethods.size === 0) return chunks;
  const holds = (chunk: BodyChunkResult, line: number): boolean =>
    line >= chunk.startLine &&
    line <= chunk.endLine &&
    (chunk.lineRanges ?? [{ start: chunk.startLine, end: chunk.endLine }]).some(
      (r) => line >= r.start && line <= r.end,
    );
  const declared = new Map<BodyChunkResult, ShortMethod[]>();
  for (const method of [...shortMethods.values()].sort((a, b) => a.line - b.line)) {
    const chunk = chunks.find((candidate) => holds(candidate, method.line));
    if (!chunk) continue;
    const members = declared.get(chunk) ?? [];
    if (!members.some((m) => m.name === method.name && m.methodKind === method.methodKind)) members.push(method);
    declared.set(chunk, members);
  }
  return chunks.map((chunk) => {
    const members = declared.get(chunk);
    if (!members) return chunk;
    return { ...chunk, declaredMethodMembers: members.map(({ name, methodKind }) => ({ name, methodKind })) };
  });
}

// ── ChunkingHook export ────────────────────────────────────────────

export const typescriptBodyChunkingHook: ChunkingHook = {
  name: "typescriptBodyChunking",
  process(ctx) {
    ctx.bodyChunks = extractBodyChunks(ctx);
  },
};
