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
 * Decorator is checked BEFORE static/abstract — a @Inject() static field
 * is classified as decorated_members, not static_members.
 */

import type Parser from "tree-sitter";

import type { BodyChunkResult, ChunkingHook, HookContext } from "../types.js";
import { findClassBody } from "./utils.js";

// ── Classification ────────────────────────────────────────────────

type GroupType = "properties" | "static_members" | "decorated_members" | "abstract_members" | "other";

/**
 * Classify a class_body child node into a group type.
 * Returns undefined for nodes that should be skipped (methods, comments).
 */
function classifyNode(node: Parser.SyntaxNode): GroupType | undefined {
  const { type } = node;

  // Skip methods and comments — handled elsewhere
  if (type === "method_definition" || type === "comment") return undefined;

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
    // Check static
    if (hasModifier(node, "static")) return "static_members";
    // Plain property
    return "properties";
  }

  // Everything else
  return "other";
}

/**
 * Check if a node has a direct child of the given type.
 */
function hasChildOfType(node: Parser.SyntaxNode, childType: string): boolean {
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
function hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && !child.isNamed && child.type === modifier) return true;
  }
  return false;
}

// ── Grouping ──────────────────────────────────────────────────────

interface NodeGroup {
  type: GroupType;
  nodes: Parser.SyntaxNode[];
}

/**
 * Group adjacent same-type nodes from class_body.
 */
function groupAdjacentNodes(classBody: Parser.SyntaxNode, excludedRows: Set<number>): NodeGroup[] {
  const groups: NodeGroup[] = [];
  let currentType: GroupType | null = null;
  let currentNodes: Parser.SyntaxNode[] = [];

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

    const nodeType = classifyNode(child);
    if (nodeType === undefined) continue; // skip methods, comments

    if (nodeType === currentType) {
      currentNodes.push(child);
    } else {
      flush();
      currentType = nodeType;
      currentNodes = [child];
    }
  }

  flush();
  return groups;
}

// ── Class header extraction ───────────────────────────────────────

/**
 * Extract the class declaration header line for context injection.
 * Returns "export class Foo extends Bar {" or undefined.
 */
function extractClassHeader(containerNode: Parser.SyntaxNode, codeLines: string[]): string | undefined {
  const firstLine = codeLines[containerNode.startPosition.row];
  if (firstLine && /^\s*(export\s+)?(abstract\s+)?class\s+/.test(firstLine)) {
    return firstLine.trim();
  }
  return undefined;
}

// ── Body chunk extraction ─────────────────────────────────────────

/**
 * Collect non-excluded comment nodes immediately preceding a given node.
 * Returns comment nodes in source order (top to bottom).
 */
function collectPrecedingComments(node: Parser.SyntaxNode, excludedRows: Set<number>): Parser.SyntaxNode[] {
  const commentNodes: Parser.SyntaxNode[] = [];
  let sibling = node.previousNamedSibling;

  while (sibling?.type === "comment") {
    if (!excludedRows.has(sibling.startPosition.row)) {
      commentNodes.unshift(sibling);
    }
    sibling = sibling.previousNamedSibling;
  }

  return commentNodes;
}

/**
 * Append all rows covered by a node to the rows array, and corresponding
 * source lines to the contentLines array.
 */
function appendNodeContent(
  node: Parser.SyntaxNode,
  codeLines: string[],
  contentLines: string[],
  allRows: number[],
): void {
  for (let { row } = node.startPosition; row <= node.endPosition.row; row++) {
    contentLines.push(codeLines[row]);
    allRows.push(row);
  }
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

  const contentLines: string[] = [];
  const allRows: number[] = [];

  for (const node of group.nodes) {
    // Include preceding comments for this node
    const comments = collectPrecedingComments(node, excludedRows);
    for (const c of comments) {
      appendNodeContent(c, codeLines, contentLines, allRows);
    }

    // Include the node itself
    appendNodeContent(node, codeLines, contentLines, allRows);
  }

  allRows.sort((a, b) => a - b);

  if (allRows.length === 0) return null;

  // Convert to 1-based line numbers
  const startLine = allRows[0] + 1;
  const endLine = allRows[allRows.length - 1] + 1;

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
 * Split a body chunk if its content exceeds maxChunkSize.
 * Splits at line boundaries.
 */
function splitOversizedChunk(
  chunk: BodyChunkResult,
  classHeader: string | undefined,
  maxChunkSize: number,
): BodyChunkResult[] {
  if (chunk.content.length <= maxChunkSize) return [chunk];

  // Remove class header for splitting, re-add to each sub-chunk
  const headerPrefix = classHeader ? `${classHeader}\n` : "";
  const bodyContent = classHeader ? chunk.content.slice(headerPrefix.length) : chunk.content;
  const bodyLines = bodyContent.split("\n");

  const results: BodyChunkResult[] = [];
  let subLines: string[] = [];
  let subSize = headerPrefix.length;

  for (const line of bodyLines) {
    const lineLen = line.length + 1; // +1 for newline
    if (subSize + lineLen > maxChunkSize && subLines.length > 0) {
      results.push({
        content: `${headerPrefix}${subLines.join("\n")}`.trim(),
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        lineRanges: chunk.lineRanges,
      });
      subLines = [];
      subSize = headerPrefix.length;
    }
    subLines.push(line);
    subSize += lineLen;
  }

  if (subLines.length > 0) {
    results.push({
      content: `${headerPrefix}${subLines.join("\n")}`.trim(),
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      lineRanges: chunk.lineRanges,
    });
  }

  return results;
}

/**
 * Extract body chunks from a TypeScript class with AST-based semantic grouping.
 */
export function extractBodyChunks(ctx: HookContext): BodyChunkResult[] {
  const classBody = findClassBody(ctx.containerNode);
  if (!classBody) return [];

  const groups = groupAdjacentNodes(classBody, ctx.excludedRows);
  const classHeader = extractClassHeader(ctx.containerNode, ctx.codeLines);
  const results: BodyChunkResult[] = [];

  for (const group of groups) {
    const extracted = extractGroupContent(group, ctx.codeLines, ctx.excludedRows);
    if (!extracted) continue;

    // Prepend class header for context
    const contentWithContext = classHeader ? `${classHeader}\n${extracted.content}` : extracted.content;

    // Skip tiny groups
    if (contentWithContext.length < 50) continue;

    const chunk: BodyChunkResult = {
      content: contentWithContext,
      startLine: extracted.startLine,
      endLine: extracted.endLine,
      lineRanges: extracted.lineRanges,
    };

    // Split oversized groups
    if (chunk.content.length > ctx.config.maxChunkSize) {
      results.push(...splitOversizedChunk(chunk, classHeader, ctx.config.maxChunkSize));
    } else {
      results.push(chunk);
    }
  }

  return results;
}

// ── ChunkingHook export ────────────────────────────────────────────

export const typescriptBodyChunkingHook: ChunkingHook = {
  name: "typescriptBodyChunking",
  process(ctx) {
    ctx.bodyChunks = extractBodyChunks(ctx);
  },
};
