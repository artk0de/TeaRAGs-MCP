/**
 * RubyClassBodyChunker — Groups Ruby/Rails class body declarations by semantic type.
 *
 * When a class body is extracted (everything outside methods), this module
 * classifies each line into a declaration group (associations, validations,
 * scopes, callbacks, etc.) and produces separate chunks per group.
 *
 * Designed for Rails models where class bodies are 70-80% DSL declarations.
 */

import type Parser from "tree-sitter";

import type { BodyChunkResult, ChunkingHook } from "../types.js";

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
  lineRanges: Array<{ start: number; end: number }>;
}

// ── Declaration keyword maps ───────────────────────────────────────

/**
 * Maps first identifier on a line to a group type.
 */
const DECLARATION_KEYWORDS: Record<string, string> = {
  // associations
  has_many: "associations",
  has_one: "associations",
  belongs_to: "associations",
  has_and_belongs_to_many: "associations",

  // validations
  validates: "validations",
  validates_with: "validations",
  validate: "validations",
  validates_each: "validations",
  validates_associated: "validations",
  validates_acceptance_of: "validations",
  validates_confirmation_of: "validations",
  validates_exclusion_of: "validations",
  validates_format_of: "validations",
  validates_inclusion_of: "validations",
  validates_length_of: "validations",
  validates_numericality_of: "validations",
  validates_presence_of: "validations",
  validates_uniqueness_of: "validations",

  // scopes
  scope: "scopes",

  // callbacks
  before_validation: "callbacks",
  after_validation: "callbacks",
  before_save: "callbacks",
  after_save: "callbacks",
  around_save: "callbacks",
  before_create: "callbacks",
  after_create: "callbacks",
  around_create: "callbacks",
  before_update: "callbacks",
  after_update: "callbacks",
  around_update: "callbacks",
  before_destroy: "callbacks",
  after_destroy: "callbacks",
  around_destroy: "callbacks",
  after_commit: "callbacks",
  after_rollback: "callbacks",
  after_initialize: "callbacks",
  after_find: "callbacks",
  after_touch: "callbacks",
  before_action: "callbacks",
  after_action: "callbacks",
  around_action: "callbacks",
  before_filter: "callbacks",
  after_filter: "callbacks",
  around_filter: "callbacks",
  skip_before_action: "callbacks",
  skip_after_action: "callbacks",
  skip_around_action: "callbacks",

  // includes/extends
  include: "includes",
  extend: "includes",
  prepend: "includes",

  // attributes
  attr_accessor: "attributes",
  attr_reader: "attributes",
  attr_writer: "attributes",
  attribute: "attributes",
  has_one_attached: "attributes",
  has_many_attached: "attributes",
  class_attribute: "attributes",
  mattr_accessor: "attributes",
  mattr_reader: "attributes",
  mattr_writer: "attributes",
  cattr_accessor: "attributes",
  cattr_reader: "attributes",
  cattr_writer: "attributes",

  // nested attributes
  accepts_nested_attributes_for: "nested_attrs",

  // delegates
  delegate: "delegates",
  delegate_missing_to: "delegates",

  // enums
  enum: "enums",

  // state machine
  aasm: "state_machine",

  // concern hooks (transparent — wrapper lines removed by block-depth logic)
  included: "concern_hooks",
  extended: "concern_hooks",
  class_methods: "concern_hooks",

  // serialization
  serialize: "other",
  store_accessor: "other",
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
        const opensKeywordBlock = blockDepth === 0 && !!kwMatch && KEYWORD_BLOCK_OPENERS.has(kwMatch[1]);

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

      for (let i = 0; i < group.lines.length; i++) {
        const lineLen = group.lines[i].text.length + 1; // +1 for newline
        if (subSize + lineLen > maxChunkSize && subLines.length > 0) {
          result.push({
            type: group.type,
            lines: [...subLines],
            lineRanges: computeLineRanges(subLines),
          });
          subLines = [];
          subSize = 0;
        }
        subLines.push(group.lines[i]);
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
 * Returns "class Foo < Bar" or "module Baz" or undefined.
 */
export function extractClassHeader(node: Parser.SyntaxNode, code: string): string | undefined {
  const lines = code.split("\n");
  const firstLine = lines[node.startPosition.row];
  if (firstLine && /^\s*(class|module)\s+/.test(firstLine)) {
    return firstLine.trim();
  }
  return undefined;
}

/**
 * Extract body lines with source line tracking, excluding method and comment rows.
 */
function extractContainerBodyLines(
  containerNode: Parser.SyntaxNode,
  childNodes: Parser.SyntaxNode[],
  code: string,
  excludedRows: Set<number>,
): BodyLine[] {
  const containerStartRow = containerNode.startPosition.row;
  const containerEndRow = containerNode.endPosition.row;
  const lines = code.split("\n");

  // Build a set of line numbers occupied by child nodes (methods)
  const methodLines = new Set<number>();
  for (const child of childNodes) {
    for (let row = child.startPosition.row; row <= child.endPosition.row; row++) {
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
  containerNode: Parser.SyntaxNode,
  childNodes: Parser.SyntaxNode[],
  code: string,
  excludedRows: Set<number>,
  config: { maxChunkSize: number },
): BodyChunkResult[] {
  const bodyLines = extractContainerBodyLines(containerNode, childNodes, code, excludedRows);
  const groups = bodyGrouper.groupLines(bodyLines, config.maxChunkSize);
  const classHeader = extractClassHeader(containerNode, code);

  const results: BodyChunkResult[] = [];

  for (const group of groups) {
    const groupContent = group.lines
      .map((l) => l.text)
      .join("\n")
      .trim();

    // Prepend class header for context
    const contentWithContext = classHeader ? `${classHeader}\n${groupContent}` : groupContent;

    // Skip tiny groups
    if (contentWithContext.length < 50) continue;

    const minLine = Math.min(...group.lineRanges.map((r) => r.start));
    const maxLine = Math.max(...group.lineRanges.map((r) => r.end));

    results.push({
      content: contentWithContext,
      startLine: minLine,
      endLine: maxLine,
      lineRanges: group.lineRanges,
    });
  }

  return results;
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
function computeLineRanges(lines: BodyLine[]): Array<{ start: number; end: number }> {
  if (lines.length === 0) return [];

  const ranges: Array<{ start: number; end: number }> = [];
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
