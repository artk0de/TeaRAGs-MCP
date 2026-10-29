/**
 * RubyClassBodyChunker — Groups Ruby/Rails class body declarations by semantic type.
 *
 * When a class body is extracted (everything outside methods), this module
 * classifies each line into a declaration group (associations, validations,
 * scopes, callbacks, etc.) and produces separate chunks per group.
 *
 * Designed for Rails models where class bodies are 70-80% DSL declarations.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import {
  bodyChunkContentBudget,
  type BodyChunkResult,
  type ChunkingHook,
  type HookChunkingConfig,
} from "../../../../contracts/types/chunker.js";
import { classifyMethod, type MethodClassification } from "../../../../primitives/ids/index.js";
import { foldSubFloorGroups } from "../../kernel/index.js";
import { RUBY_DSL, type DslCategory, type RubyDslEntry } from "../dsl/index.js";
import { STRUCTURED_MACROS } from "../walker/structured/index.js";
import { collectMethodCommentRows } from "./comment-capture.js";
import { valueClassContainerBody, valueClassContainerHeader } from "./value-class-container.js";

// ── Public interfaces ──────────────────────────────────────────────

export interface BodyLine {
  text: string;
  /** 1-based line number in the original source file */
  sourceLine: number;
}

export interface BodyGroup {
  type: string;
  lines: BodyLine[];
  /** Source line ranges for this group (may be non-contiguous) */
  lineRanges: { start: number; end: number }[];
}

// ── Declaration keyword maps ───────────────────────────────────────

/**
 * Chunk group name per DSL category — the chunker's LOCAL policy (how it names
 * groups), not an intrinsic catalogue fact. `alias` → "aliases" and
 * `dynamic-method` → "dynamic_methods" are NEW groupings (previously these lines
 * fell through to continuation).
 */
const CATEGORY_TO_GROUP: Record<DslCategory, string> = {
  accessor: "attributes",
  delegation: "delegates",
  alias: "aliases",
  "dynamic-method": "dynamic_methods",
  association: "associations",
  validation: "validations",
  scope: "scopes",
  callback: "callbacks",
  include: "includes",
  enum: "enums",
  "state-machine": "state_machine",
  "concern-hook": "concern_hooks",
  "nested-attrs": "nested_attrs",
  other: "other",
};

/**
 * RSpec / FactoryBot testing-DSL keywords. NOT in the Rails catalogue
 * (ruby/dsl/catalogue.ts) — they belong to the separate testing DSL handled by
 * rspec-scope-chunker. Kept hardcoded here as a distinct set; their grouping is
 * likely dead (spec/factory files route through rspec-scope-chunker with
 * skipChildren=true). Removal is a separate follow-up (spec Non-Goals).
 */
const RSPEC_FACTORY_KEYWORDS: Record<string, string> = {
  let: "setup",
  subject: "setup",
  before: "hooks",
  after: "hooks",
  around: "hooks",
  shared_examples: "shared",
  shared_context: "shared",
  include_examples: "shared",
  it_behaves_like: "shared",
  include_context: "shared",
  factory: "factory",
  trait: "factory",
};

/**
 * First identifier on a line → chunk group type. The Rails subset is DERIVED
 * from the shared RUBY_DSL catalogue via CATEGORY_TO_GROUP; the testing-DSL
 * subset is the hardcoded RSPEC_FACTORY_KEYWORDS set above.
 */
const DECLARATION_KEYWORDS: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(RUBY_DSL).map(([keyword, entry]) => [keyword, CATEGORY_TO_GROUP[entry.category]]),
  ),
  ...RSPEC_FACTORY_KEYWORDS,
};

/**
 * Ruby statement-level keywords that start new "other" blocks.
 * These are NOT continuations of a previous declaration.
 */
const STATEMENT_KEYWORDS = new Set([
  "self",
  "class",
  "module",
  "def",
  "private",
  "protected",
  "public",
  "rescue",
  "begin",
  "if",
  "unless",
  "case",
  "when",
  "return",
  "raise",
]);

/**
 * Concern-level DSL methods whose `do...end` blocks should be transparent.
 * Content inside these blocks is classified normally as flat body.
 */
const BLOCK_DEPTH_EXCEPTIONS = new Set(["included", "extended", "class_methods"]);

/** Matches a `do` keyword at end of line (with optional block params and comment) */
const DO_END_REGEX = /\bdo\s*(\|[^|]*\|)?\s*(#.*)?$/;

/** Matches a standalone `end` keyword (possibly with trailing comment) */
const END_REGEX = /^\s*end\s*(#.*)?$/;

/**
 * Keywords that open a block terminated by `end` (without `do`).
 * Used to track block depth for `class << self...end`, `module...end`, etc.
 */
const KEYWORD_BLOCK_OPENERS = new Set(["class", "module"]);

/** A row opening with a hash key (`foreign_key: :id`, `class: Foo`) — an argument continuation. */
const HASH_KEY_ROW = /^\s*\w+:(?!:)/;

// ── RubyClassBodyChunker class ─────────────────────────────────────

export class RubyClassBodyChunker {
  /**
   * Classify a line's first keyword into a declaration group type.
   * Returns undefined for blank lines, continuation lines, or non-identifier starts.
   *
   * Known Rails keywords → their group type.
   * Constants (ALL_CAPS) and statement keywords (self, class, end, etc.) → "other".
   * Everything else → undefined (treated as continuation of previous declaration).
   */
  classifyLine(line: string): string | undefined {
    const trimmed = line.trim();
    if (trimmed.length === 0) return undefined;

    // Non-identifier start: continuation line (., }, ), #, etc.)
    const match = trimmed.match(/^(\w+)/);
    if (!match) return undefined;

    const keyword = match[1];

    // A hash-key row (`scope: :firm_id`, `if: :active?`) continues a statement's
    // argument list, whatever word the key is (bd tea-rags-mcp-5ivtb).
    if (HASH_KEY_ROW.test(trimmed)) return undefined;

    // Known Rails/Ruby declaration keyword
    if (keyword in DECLARATION_KEYWORDS) return DECLARATION_KEYWORDS[keyword];

    // Constants (ALL_CAPS like CONSTANT, TABLE_NAME) → new "other" statement
    if (/^[A-Z][A-Z_0-9]*$/.test(keyword)) return "other";

    // Ruby statement-level keywords → new "other" statement
    if (STATEMENT_KEYWORDS.has(keyword)) return "other";

    // Everything else (method calls like `where`, `presence`, etc.) → continuation
    return undefined;
  }

  /**
   * Group body lines by declaration type.
   * Adjacent lines of the same type form one group.
   * Blank lines between same-type declarations are absorbed (but not included in group lines).
   * When type changes, a new group starts.
   * Groups exceeding maxChunkSize are split.
   *
   * @param lines - array of BodyLine (from class body, methods already removed)
   * @param maxChunkSize - max characters per group (optional, default unlimited)
   */
  groupLines(lines: BodyLine[], maxChunkSize?: number): BodyGroup[] {
    const groups: BodyGroup[] = [];
    let currentType: string | null = null;
    let currentLines: BodyLine[] = [];
    let pendingBlanks: BodyLine[] = [];
    let blockDepth = 0;
    let braceDepth = 0;
    /** True when inside a transparent block (included/extended/class_methods) */
    let transparentBlock = false;
    /** True when inside a keyword block (class/module) that flushes on close */
    let keywordBlock = false;

    /**
     * Flush current group and return non-blank pending lines (comments)
     * that should attach to the next group rather than being dropped.
     */
    const flushGroup = (): BodyLine[] => {
      // A pending row that is neither blank nor a comment continues the
      // statement above it (`has_many :x,` / `  foreign_key: :y`): it stays in
      // the current group, so one statement never spans two chunks (bd
      // tea-rags-mcp-5ivtb). Only the comment rows after it lead the next group.
      let continuationEnd = -1;
      pendingBlanks.forEach((l, i) => {
        const text = l.text.trim();
        if (text.length > 0 && !text.startsWith("#")) continuationEnd = i;
      });
      if (currentType && continuationEnd >= 0) {
        currentLines.push(...pendingBlanks.slice(0, continuationEnd + 1));
        pendingBlanks = pendingBlanks.slice(continuationEnd + 1);
      }
      if (currentLines.length > 0 && currentType) {
        groups.push({
          type: currentType,
          lines: [...currentLines],
          lineRanges: computeLineRanges(currentLines),
        });
      }
      // Preserve non-blank pending lines (comments) for the next group
      const carryOver = pendingBlanks.filter((l) => l.text.trim().length > 0);
      currentLines = [];
      currentType = null;
      pendingBlanks = [];
      return carryOver;
    };

    for (const line of lines) {
      const trimmed = line.text.trim();

      // --- Inside a do...end or keyword block (non-transparent) ---
      if (blockDepth > 0 && !transparentBlock) {
        // Check for nested do or keyword block → blockDepth++
        if (DO_END_REGEX.test(trimmed)) {
          blockDepth++;
        } else {
          const kwMatch = trimmed.match(/^(\w+)/);
          if (kwMatch && KEYWORD_BLOCK_OPENERS.has(kwMatch[1])) {
            blockDepth++;
          }
        }
        // Check for end → blockDepth--
        if (END_REGEX.test(trimmed)) {
          blockDepth--;
        }

        if (blockDepth === 0) {
          // Block closed — absorb all pending blanks + this end line into current group
          currentLines.push(...pendingBlanks, line);
          pendingBlanks = [];
          // Keyword blocks (class/module) flush immediately on close
          if (keywordBlock) {
            keywordBlock = false;
            flushGroup();
          }
        } else {
          // Still inside block — accumulate
          pendingBlanks.push(line);
        }
        continue;
      }

      // --- Inside a transparent do...end block ---
      if (blockDepth > 0 && transparentBlock) {
        // Check for end that closes the transparent block
        if (END_REGEX.test(trimmed)) {
          blockDepth--;
          if (blockDepth === 0) {
            transparentBlock = false;
            // Drop the `end` line — transparent wrapper
            continue;
          }
        }
        // Check for nested do inside transparent block
        if (DO_END_REGEX.test(trimmed)) {
          blockDepth++;
        }
        // Fall through to normal classification below
      }

      // --- Inside a multiline brace block ---
      if (braceDepth > 0) {
        const opens = (trimmed.match(/{/g) || []).length;
        const closes = (trimmed.match(/}/g) || []).length;
        braceDepth += opens - closes;

        if (braceDepth <= 0) {
          // Brace block closed — absorb pending + this line
          braceDepth = 0;
          currentLines.push(...pendingBlanks, line);
          pendingBlanks = [];
        } else {
          pendingBlanks.push(line);
        }
        continue;
      }

      // --- Normal classification ---
      const type = this.classifyLine(line.text);

      if (type === undefined) {
        // Check if this unclassified line opens a block (do...end or class/module)
        // Only when not already inside a block (transparent blocks handle depth internally)
        const opensDo = blockDepth === 0 && DO_END_REGEX.test(trimmed);
        const kwMatch = trimmed.match(/^(\w+)/);
        const opensKeywordBlock =
          blockDepth === 0 && !!kwMatch && KEYWORD_BLOCK_OPENERS.has(kwMatch[1]) && !HASH_KEY_ROW.test(trimmed);

        if (opensDo || opensKeywordBlock) {
          // Unclassified line that opens a block → start new "other" group
          const carry = flushGroup();
          currentType = "other";
          currentLines = [...carry, line];
          blockDepth = 1;
          keywordBlock = opensKeywordBlock;
        } else if (currentType) {
          // Active group — queue as pending continuation
          pendingBlanks.push(line);
        } else if (trimmed.length > 0) {
          // No active group, non-blank unclassified line — start "other" group
          currentType = "other";
          currentLines = [line];
        }
        continue;
      }

      if (type === currentType) {
        // Same type — absorb pending blanks as continuation, add current line
        currentLines.push(...pendingBlanks, line);
        pendingBlanks = [];
      } else {
        // Different type — flush current group, carry comments to new group
        const carry = flushGroup();
        currentType = type;
        currentLines = [...carry, line];
      }

      // --- Check if this line opens a do...end block ---
      // Skip if already inside a block (transparent blocks manage depth internally)
      if (blockDepth === 0 && DO_END_REGEX.test(trimmed)) {
        // Extract the first keyword to check exceptions
        const kwMatch = trimmed.match(/^(\w+)/);
        if (kwMatch && BLOCK_DEPTH_EXCEPTIONS.has(kwMatch[1])) {
          // Transparent block — don't add to group, content is classified normally
          transparentBlock = true;
          blockDepth = 1;
          // Remove this line from current group (it was just added above)
          currentLines.pop();
          // If that was the only line, reset group
          if (currentLines.length === 0) {
            currentType = null;
          }
        } else {
          blockDepth = 1;
        }
      }

      // --- Check if this line opens a class/module...end block ---
      if (blockDepth === 0) {
        const kwMatch = trimmed.match(/^(\w+)/);
        if (kwMatch && KEYWORD_BLOCK_OPENERS.has(kwMatch[1])) {
          blockDepth = 1;
          keywordBlock = true;
        }
      }

      // --- Check if this line opens a multiline brace block ---
      const opens = (trimmed.match(/{/g) || []).length;
      const closes = (trimmed.match(/}/g) || []).length;
      const balance = opens - closes;
      if (balance > 0) {
        braceDepth = balance;
      }
    }

    // Absorb trailing non-blank pending lines into current group before final flush.
    // At end-of-input there's no next classified line to disambiguate — these are
    // continuations of the current group (e.g. `date_ransackers` after a ransacker do..end).
    if (currentType && pendingBlanks.length > 0) {
      const trailingNonBlanks = pendingBlanks.filter((l) => l.text.trim().length > 0);
      if (trailingNonBlanks.length > 0) {
        currentLines.push(...pendingBlanks);
        pendingBlanks = [];
      }
    }

    // Flush last group
    flushGroup();

    // Split oversized groups if maxChunkSize is set
    if (maxChunkSize && maxChunkSize > 0) {
      return this.splitOversizedGroups(groups, maxChunkSize);
    }

    return groups;
  }

  /**
   * Split groups that exceed maxChunkSize into smaller sub-groups.
   */
  private splitOversizedGroups(groups: BodyGroup[], maxChunkSize: number): BodyGroup[] {
    const result: BodyGroup[] = [];

    for (const group of groups) {
      const content = group.lines.map((l) => l.text).join("\n");
      if (content.length <= maxChunkSize) {
        result.push(group);
        continue;
      }

      // Split at line boundaries, respecting maxChunkSize
      let subLines: BodyLine[] = [];
      let subSize = 0;

      for (const groupLine of group.lines) {
        const lineLen = groupLine.text.length + 1; // +1 for newline
        if (subSize + lineLen > maxChunkSize && subLines.length > 0) {
          result.push({
            type: group.type,
            lines: [...subLines],
            lineRanges: computeLineRanges(subLines),
          });
          subLines = [];
          subSize = 0;
        }
        subLines.push(groupLine);
        subSize += lineLen;
      }

      if (subLines.length > 0) {
        result.push({
          type: group.type,
          lines: [...subLines],
          lineRanges: computeLineRanges(subLines),
        });
      }
    }

    return result;
  }
}

// ── Body chunk extraction (used by rubyBodyChunkingHook) ───────────

const bodyGrouper = new RubyClassBodyChunker();

/**
 * Extract class/module header line for context injection.
 * Returns "class Foo < Bar" or "module Baz", the whole assignment row of a
 * value-class container ("Billing::Entry = Data.define(:a) do", bd 0td4h), or
 * undefined.
 */
export function extractClassHeader(node: AstNode, code: string): string | undefined {
  const valueClassHeader = valueClassContainerHeader(node, code);
  if (valueClassHeader !== undefined) return valueClassHeader;
  const firstLine = code.split("\n")[node.startPosition.row];
  return firstLine && /^\s*(class|module)\s+/.test(firstLine) ? firstLine.trim() : undefined;
}

/**
 * Extract body lines with source line tracking, excluding method and comment rows.
 */
function extractContainerBodyLines(
  containerNode: AstNode,
  childNodes: AstNode[],
  code: string,
  excludedRows: Set<number>,
): BodyLine[] {
  const containerStartRow = containerNode.startPosition.row;
  const containerEndRow = containerNode.endPosition.row;
  const lines = code.split("\n");

  // Build a set of line numbers occupied by child nodes (methods)
  const methodLines = new Set<number>();
  for (const child of childNodes) {
    for (let { row } = child.startPosition; row <= child.endPosition.row; row++) {
      methodLines.add(row);
    }
  }
  // Also exclude rows claimed by method comments
  for (const row of excludedRows) {
    methodLines.add(row);
  }

  // Collect non-method lines with their 1-based source line numbers.
  // Skip container boundaries (class/end lines) — the header is prepended separately.
  const bodyLines: BodyLine[] = [];
  for (let row = containerStartRow + 1; row < containerEndRow; row++) {
    if (!methodLines.has(row)) {
      bodyLines.push({
        text: lines[row],
        sourceLine: row + 1, // 1-based
      });
    }
  }

  return bodyLines;
}

/**
 * Extract body chunks from a Ruby class/module with semantic grouping.
 * Combines body line extraction, RubyClassBodyChunker, and class header injection.
 */
export function extractBodyChunks(
  containerNode: AstNode,
  childNodes: AstNode[],
  code: string,
  excludedRows: Set<number>,
  config: HookChunkingConfig,
): BodyChunkResult[] {
  const bodyLines = extractContainerBodyLines(containerNode, childNodes, code, excludedRows);
  // The group rows get the class header (written below) and the engine's
  // hierarchy on top; `bodyChunkPrefixLength` reserves both, so a group sized to
  // what is left fits the cap whole instead of being line-cut by the post-pass
  // into a headerless `#part2` (bd tea-rags-mcp-j4jrn).
  const budget = bodyChunkContentBudget(config);
  const classHeader = extractClassHeader(containerNode, code);
  const constants = [
    ...containerConstantAssignments(containerNode, code),
    ...containerInlineNestedContainers(containerNode, childNodes, code),
  ];
  const shortMethods = containerShortMethods(containerNode, childNodes, code);
  const dslMembers = containerDslMembers(containerNode, code);
  const withHeader = (group: BodyGroup): string => {
    const groupContent = groupText(group);
    return classHeader ? `${classHeader}\n${groupContent}` : groupContent;
  };
  const declaresMember = (group: BodyGroup): boolean =>
    group.lines.some((l) => constants.some((c) => c.line === l.sourceLine) || shortMethods.has(l.sourceLine));
  // A sub-floor group folds into a neighbour instead of being dropped (bd
  // tea-rags-mcp-30qdc); a group declaring a member is never noise.
  const fits = (group: BodyGroup): boolean => groupText(group).length <= budget;
  // The leading comment runs through the same grouper, so a comment block over
  // the budget is split at row boundaries here, never line-cut by the post-pass.
  const plainGroups = bodyGrouper.groupLines(bodyLines, budget);
  const commentGroups = bodyGrouper.groupLines(containerLeadingCommentLines(containerNode, code), budget);
  // The floor measures the group's rows joined and trimmed, not the chunk text:
  // the first row's indentation, kept for display, must not lift a lone
  // `include` over it and take the container rows from the engine remainder.
  const floorLength = (group: BodyGroup): number => {
    const text = group.lines
      .map((l) => l.text)
      .join("\n")
      .trim();
    return classHeader ? classHeader.length + 1 + text.length : text.length;
  };
  const subFloorFold = {
    isSubFloor: (group: BodyGroup) => floorLength(group) < 50 && !declaresMember(group),
    fits,
    merge: mergeBodyGroups,
    startOf: (group: BodyGroup) => group.lines[0].sourceLine,
  };
  const bodyGroups = withLeadingComment(plainGroups, commentGroups, fits);
  const groups =
    commentGroups.length === 0 || foldSubFloorGroups(plainGroups, subFloorFold).length > 0
      ? foldSubFloorGroups(bodyGroups, subFloorFold)
      : commentOnlyHeaderBlock(foldSubFloorGroups(bodyGroups, subFloorFold), bodyGroups, {
          headerLine: containerNode.startPosition.row + 1,
          endLine: containerNode.endPosition.row + 1,
        });

  const results: BodyChunkResult[] = [];

  for (const group of groups) {
    const minLine = Math.min(...group.lineRanges.map((r) => r.start));
    const maxLine = Math.max(...group.lineRanges.map((r) => r.end));
    const groupLines = new Set(group.lines.map((l) => l.sourceLine));
    const declaredMemberNames = constants.filter((c) => groupLines.has(c.line)).map((c) => c.name);
    // Short defs and DSL statements interleave in source order (bd tea-rags-mcp-5ivtb).
    const declaredMethodMembers = [
      ...[...shortMethods].map(([line, method]) => [line, [method]] as const),
      ...dslMembers,
    ]
      .filter(([line]) => groupLines.has(line))
      .sort(([a], [b]) => a - b)
      .flatMap(([, members]) => members);

    results.push({
      content: withHeader(group),
      startLine: minLine,
      endLine: maxLine,
      lineRanges: group.lineRanges,
      ...(declaredMemberNames.length > 0 ? { declaredMemberNames } : {}),
      ...(declaredMethodMembers.length > 0 ? { declaredMethodMembers } : {}),
    });
  }

  return results;
}

/**
 * A group's rows as chunk text: each row with its own indentation, leading and
 * trailing blank rows dropped, and every run of blank rows — the gaps left
 * where the container's methods were taken out — collapsed to one blank row.
 * Text only: the group's `lineRanges` still name every source row it claims.
 */
function groupText(group: BodyGroup): string {
  const textRows: string[] = [];
  for (const { text } of group.lines) {
    if (text.trim().length > 0) textRows.push(text);
    else if (textRows.length > 0 && textRows[textRows.length - 1] !== "") textRows.push("");
  }
  return textRows.join("\n").trimEnd();
}

/**
 * The comment block directly above the container's declaration, as body lines
 * — the same rows `collectMethodCommentRows` gives a method (up to one blank
 * row between block and declaration). A nested container's block is a row the
 * enclosing comment-capture promised to this container, so this container's
 * header block is the one chunk that carries it.
 */
function containerLeadingCommentLines(containerNode: AstNode, code: string): BodyLine[] {
  const codeLines = code.split("\n");
  return [...collectMethodCommentRows(containerNode, codeLines)]
    .sort((a, b) => a - b)
    .map((row) => ({ text: codeLines[row], sourceLine: row + 1 }));
}

/**
 * The body groups with the container's leading comment joined to the first —
 * the header block — so it opens the chunk that names the container, the way a
 * method's leading comment opens the method chunk. `commentGroups` is that
 * comment already split to the budget; its last part joins the first body
 * group when the two fit together, else every part stays a group of its own.
 * A container whose body is only methods has no body group: the comment parts
 * are its groups.
 */
function withLeadingComment(
  groups: BodyGroup[],
  commentGroups: BodyGroup[],
  fits: (group: BodyGroup) => boolean,
): BodyGroup[] {
  const last = commentGroups.at(-1);
  if (last === undefined) return groups;
  if (groups.length === 0) return commentGroups;
  const leading = commentGroups.slice(0, -1);
  const [headerGroup, ...rest] = groups;
  const joined = mergeBodyGroups(headerGroup, last);
  return fits(joined) ? [...leading, joined, ...rest] : [...commentGroups, ...groups];
}

/** Two body line groups as one, rows in source order, under the host's type. */
function mergeBodyGroups(host: BodyGroup, guest: BodyGroup): BodyGroup {
  const lines = [...host.lines, ...guest.lines].sort((a, b) => a.sourceLine - b.sourceLine);
  return { type: host.type, lines, lineRanges: computeLineRanges(lines) };
}

/**
 * The constants a class / module body assigns at its own level (`FOO_SQL =
 * <<~SQL`, `LIMIT ||= 10`), each with its 1-based line (bd tea-rags-mcp-1x85g).
 * Only direct statements of the container's body: a constant assigned inside
 * a method, a block or a nested container belongs to that scope, not to this
 * body chunk.
 */
/** The statements of a container's own body — a class / module body, or a value-class builder's block (bd 0td4h). */
function containerBody(containerNode: AstNode): AstNode | null {
  return containerNode.childForFieldName("body") ?? valueClassContainerBody(containerNode);
}

function containerConstantAssignments(containerNode: AstNode, code: string): { name: string; line: number }[] {
  const body = containerBody(containerNode);
  if (!body) return [];
  const constants: { name: string; line: number }[] = [];
  for (const statement of body.namedChildren) {
    if (statement.type !== "assignment" && statement.type !== "operator_assignment") continue;
    const left = statement.childForFieldName("left");
    if (left?.type !== "constant") continue;
    constants.push({
      name: code.substring(left.startIndex, left.endIndex),
      line: statement.startPosition.row + 1,
    });
  }
  return constants;
}

/**
 * The header block of a container whose own body would write no chunk — only
 * methods, or rows all under the noise floor — so that only its leading
 * comment makes this hook write one. Writing it keeps the engine's container
 * remainder out, and that remainder held the declaration row, the closing
 * `end` row and the sub-floor rows. So the block keeps them all: `folded` when
 * the comment cleared the floor, else every group merged into one (a comment
 * is never dropped as noise), with the declaration (`headerLine`, which the
 * chunk text opens with) and `end` (`endLine`) rows added to the first group's
 * ranges — one owner per row.
 */
function commentOnlyHeaderBlock(
  folded: BodyGroup[],
  bodyGroups: BodyGroup[],
  containerRows: { headerLine: number; endLine: number },
): BodyGroup[] {
  const [headerGroup, ...rest] = folded.length > 0 ? folded : [bodyGroups.reduce(mergeBodyGroups)];
  const claimed = [
    ...headerGroup.lines,
    { text: "", sourceLine: containerRows.headerLine },
    { text: "", sourceLine: containerRows.endLine },
  ].sort((a, b) => a.sourceLine - b.sourceLine);
  return [{ ...headerGroup, lineRanges: computeLineRanges(claimed) }, ...rest];
}

/**
 * The nested classes / modules a container body declares with no body of their
 * own — `class NotFound < StandardError; end`, `module Flags; end`, or the same
 * spread over two rows — each with its 1-based line. Their rows reach this hook
 * as body lines, so the body chunk holding them declares them as `Owner::Name`
 * members exactly like a constant. A nested container the engine extracted as a
 * child is its own chunk, never a member of this one.
 */
function containerInlineNestedContainers(
  containerNode: AstNode,
  extractedChildren: AstNode[],
  code: string,
): { name: string; line: number }[] {
  const body = containerBody(containerNode);
  if (!body) return [];
  const extracted = new Set(extractedChildren.map((c) => c.startIndex));
  const nested: { name: string; line: number }[] = [];
  for (const statement of body.namedChildren) {
    if (statement.type !== "class" && statement.type !== "module") continue;
    if (extracted.has(statement.startIndex) || statement.childForFieldName("body")) continue;
    const name = statement.childForFieldName("name");
    if (!name) continue;
    nested.push({ name: code.substring(name.startIndex, name.endIndex), line: statement.startPosition.row + 1 });
  }
  return nested;
}

/**
 * The methods a class / module body declares that the engine did not extract
 * as children — a `def` under its 50-char child floor — keyed by the 1-based
 * line of their `def` row (bd tea-rags-mcp-30qdc). Their rows reach this hook
 * as body lines, so the body chunk holding that row declares the method and
 * `find_symbol("Owner#m")` answers through it. Direct statements of the body
 * plus those of a `class << self` block (class methods there); a `def` nested
 * in a method, a block or a nested container belongs to that scope.
 */
function containerShortMethods(
  containerNode: AstNode,
  extractedChildren: AstNode[],
  code: string,
): Map<number, { name: string; methodKind: MethodClassification }> {
  const extracted = new Set(extractedChildren.map((c) => c.startIndex));
  const methods = new Map<number, { name: string; methodKind: MethodClassification }>();
  const collect = (body: AstNode | null): void => {
    for (const statement of body?.namedChildren ?? []) {
      if (statement.type === "singleton_class") {
        collect(statement.childForFieldName("body"));
        continue;
      }
      if (statement.type !== "method" && statement.type !== "singleton_method") continue;
      if (extracted.has(statement.startIndex)) continue;
      const name = statement.childForFieldName("name");
      const methodKind = classifyMethod(statement);
      if (!name || !methodKind) continue;
      methods.set(statement.startPosition.row + 1, {
        name: code.substring(name.startIndex, name.endIndex),
        methodKind,
      });
    }
  };
  collect(containerBody(containerNode));
  return methods;
}

/** Argument shapes that name a DSL call as written: `:title`, `Library::Author`, `"admin"`. */
const DSL_CALL_NAME_ARGUMENTS = new Set(["simple_symbol", "constant", "scope_resolution", "string"]);

/**
 * The addresses a container's class-level DSL statements take, keyed by the
 * statement's 1-based start line (bd tea-rags-mcp-5ivtb), so the body chunk
 * holding the row names them in `memberSymbolIds` and the class outline draws
 * them. A receiverless call to a catalogued macro qualifies; the `included do`
 * / `class_methods do` wrappers do not — their inner rows are what is read.
 *
 * - A statement whose operand names a method the codegraph declares for it
 *   (`walker/macro-expansion.ts`) takes THAT method's id, so the outline id
 *   and the graph agree: `has_many :chapters` → `#chapters`, `scope :recent` →
 *   `.recent`, `enum :status, {…}` → `#status`, `attr_reader :a, :b` → `#a`,
 *   `#b`.
 * - Any other statement — `validates :title`, `before_save :x`, `include M`,
 *   `aasm do`, an enum over a constant — declares no method of that name and
 *   is named by its call, the macro plus its first argument as written, the
 *   way an RSpec scope is named (`Owner.validates :title`); the `.` marks it
 *   class-level, and a repeat of the same call within the container takes
 *   `~N`, as a repeated example does.
 */
/**
 * The names a DSL call's operands could declare: its symbol arguments (only
 * the first under `first-symbol`, all but the first under `skip-first`, as the
 * codegraph reads them) and the keys of a leading hash (`enum status: {…}`).
 */
function dslOperandNames(entry: RubyDslEntry, args: AstNode | null): string[] {
  const symbols = (args?.namedChildren ?? [])
    .filter((arg) => arg.type === "simple_symbol")
    .map((arg) => arg.text.replace(/^:/, ""));
  const keys = (args?.namedChildren ?? []).flatMap((arg) => {
    const key = arg.type === "pair" ? arg.childForFieldName("key") : null;
    return key?.type === "hash_key_symbol" ? [key.text] : [];
  });
  if (entry.operands === "first-symbol") return symbols.slice(0, 1);
  if (entry.operands === "skip-first") return symbols.slice(1);
  // A hash key names an operand only for a structured macro (`enum status: {…}`);
  // on any other call it is an option (`class_name:`), never a declared name.
  return entry.declares ? symbols : [...symbols, ...keys];
}

/**
 * The methods the codegraph synthesises for one operand of a DSL call: a
 * structured macro's expander (`enum`, `aasm`) over the whole call, else the
 * catalogue entry's `declares` for that operand — the two sources
 * `walker/macro-expansion.ts` dispatches over for `cg_symbols`.
 */
function dslDeclaredMethods(
  statement: AstNode,
  macroName: string,
  entry: RubyDslEntry,
  operand: string,
): { name: string; kind: "instance" | "static" }[] {
  const structured = STRUCTURED_MACROS.find((expander) => expander.macroName === macroName);
  if (structured) return structured.expand(statement, statement.startPosition.row + 1, statement.endPosition.row + 1);
  return entry.declares?.(operand) ?? [];
}

function containerDslMembers(
  containerNode: AstNode,
  code: string,
): Map<number, { name: string; methodKind: "instance" | "static" }[]> {
  const members = new Map<number, { name: string; methodKind: "instance" | "static" }[]>();
  const callNameCounts = new Map<string, number>();
  for (const statement of containerBody(containerNode)?.namedChildren ?? []) {
    if (statement.type !== "call" || statement.childForFieldName("receiver")) continue;
    const macro = statement.childForFieldName("method");
    if (!macro) continue;
    const macroName = code.substring(macro.startIndex, macro.endIndex);
    const entry = Object.hasOwn(RUBY_DSL, macroName) ? RUBY_DSL[macroName] : undefined;
    if (entry === undefined || entry.category === "concern-hook") continue;
    const args = statement.childForFieldName("arguments");
    const named = dslOperandNames(entry, args).flatMap((operand) => {
      const method = dslDeclaredMethods(statement, macroName, entry, operand).find((m) => m.name === operand);
      return method ? [{ name: method.name, methodKind: method.kind }] : [];
    });
    if (named.length > 0) {
      members.set(statement.startPosition.row + 1, named);
      continue;
    }
    const first = args?.namedChildren[0];
    const argument =
      first && DSL_CALL_NAME_ARGUMENTS.has(first.type) && !first.text.includes("\n") ? ` ${first.text}` : "";
    const callName = `${macroName}${argument}`;
    const repeat = (callNameCounts.get(callName) ?? 0) + 1;
    callNameCounts.set(callName, repeat);
    members.set(statement.startPosition.row + 1, [
      { name: repeat === 1 ? callName : `${callName}~${repeat}`, methodKind: "static" },
    ]);
  }
  return members;
}

// ── ChunkingHook export ────────────────────────────────────────────

export const rubyBodyChunkingHook: ChunkingHook = {
  name: "rubyBodyChunking",
  process(ctx) {
    ctx.bodyChunks = extractBodyChunks(ctx.containerNode, ctx.validChildren, ctx.code, ctx.excludedRows, ctx.config);
  },
};

// ── Utility ────────────────────────────────────────────────────────

/**
 * Compute non-contiguous line ranges from BodyLine source lines.
 * Consecutive source lines form one range; gaps create new ranges.
 */
function computeLineRanges(lines: BodyLine[]): { start: number; end: number }[] {
  if (lines.length === 0) return [];

  const ranges: { start: number; end: number }[] = [];
  let rangeStart = lines[0].sourceLine;
  let rangeEnd = lines[0].sourceLine;

  for (let i = 1; i < lines.length; i++) {
    const sl = lines[i].sourceLine;
    if (sl === rangeEnd + 1) {
      // Contiguous — extend current range
      rangeEnd = sl;
    } else {
      // Gap — push current range, start new
      ranges.push({ start: rangeStart, end: rangeEnd });
      rangeStart = sl;
      rangeEnd = sl;
    }
  }

  ranges.push({ start: rangeStart, end: rangeEnd });
  return ranges;
}
