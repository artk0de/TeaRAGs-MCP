/**
 * RubyBodyGrouper — Groups Ruby/Rails class body declarations by semantic type.
 *
 * When a class body is extracted (everything outside methods), this module
 * classifies each line into a declaration group (associations, validations,
 * scopes, callbacks, etc.) and produces separate chunks per group.
 *
 * Designed for Rails models where class bodies are 70-80% DSL declarations.
 */

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
const BLOCK_DEPTH_EXCEPTIONS = new Set([
  "included",
  "extended",
  "class_methods",
]);

/** Matches a `do` keyword at end of line (with optional block params and comment) */
const DO_END_REGEX = /\bdo\s*(\|[^|]*\|)?\s*(#.*)?$/;

/** Matches a standalone `end` keyword (possibly with trailing comment) */
const END_REGEX = /^\s*end\s*(#.*)?$/;

export class RubyBodyGrouper {
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

    const flushGroup = () => {
      if (currentLines.length > 0 && currentType) {
        groups.push({
          type: currentType,
          lines: [...currentLines],
          lineRanges: computeLineRanges(currentLines),
        });
      }
      currentLines = [];
      currentType = null;
      pendingBlanks = [];
    };

    for (const line of lines) {
      const trimmed = line.text.trim();

      // --- Inside a do...end block (non-transparent) ---
      if (blockDepth > 0 && !transparentBlock) {
        // Check for nested do → blockDepth++
        if (DO_END_REGEX.test(trimmed)) {
          blockDepth++;
        }
        // Check for end → blockDepth--
        if (END_REGEX.test(trimmed)) {
          blockDepth--;
        }

        if (blockDepth === 0) {
          // Block closed — absorb all pending blanks + this end line into current group
          currentLines.push(...pendingBlanks, line);
          pendingBlanks = [];
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
        // Blank or continuation line — queue as pending
        if (currentType) {
          pendingBlanks.push(line);
        }
        continue;
      }

      if (type === currentType) {
        // Same type — absorb pending blanks as continuation, add current line
        currentLines.push(...pendingBlanks, line);
        pendingBlanks = [];
      } else {
        // Different type — flush current group and start new
        flushGroup();
        currentType = type;
        currentLines = [line];
      }

      // --- Check if this line opens a do...end block ---
      if (DO_END_REGEX.test(trimmed)) {
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

      // --- Check if this line opens a multiline brace block ---
      const opens = (trimmed.match(/{/g) || []).length;
      const closes = (trimmed.match(/}/g) || []).length;
      const balance = opens - closes;
      if (balance > 0) {
        braceDepth = balance;
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
  private splitOversizedGroups(
    groups: BodyGroup[],
    maxChunkSize: number,
  ): BodyGroup[] {
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

/**
 * Compute non-contiguous line ranges from BodyLine source lines.
 * Consecutive source lines form one range; gaps create new ranges.
 */
function computeLineRanges(
  lines: BodyLine[],
): Array<{ start: number; end: number }> {
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
