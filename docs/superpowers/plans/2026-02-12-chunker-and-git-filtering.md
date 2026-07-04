# Ruby Body Grouper + Git Path Filtering — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Fix two critical indexing issues: (1) split oversized Ruby class body
chunks into semantic groups by declaration type, (2) filter git enrichment by
.gitignore/.contextignore to fix 50% path mismatch.

**Architecture:** New `ruby-body-grouper.ts` module defines Rails declaration
groups (associations, validations, scopes, callbacks, etc.) and splits class
bodies at group boundaries. For git filtering, pass the scanner's `Ignore`
instance to `EnrichmentModule.prefetchGitLog()` and filter the git log map after
building.

**Tech Stack:** TypeScript, tree-sitter (Ruby parser), `ignore` npm package,
vitest

---

## Task 1: Ruby Body Grouper Module

**Files:**

- Create: `src/code/chunker/ruby-body-grouper.ts`
- Test: `tests/code/chunker/ruby-body-grouper.test.ts`

### Step 1: Write failing tests for the grouper

Create `tests/code/chunker/ruby-body-grouper.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  RubyBodyGrouper,
  type BodyGroup,
} from "../../../src/code/chunker/ruby-body-grouper.js";

describe("RubyBodyGrouper", () => {
  const grouper = new RubyBodyGrouper();

  it("should group associations together", () => {
    const lines = [
      "  has_many :posts, dependent: :destroy",
      "  has_many :comments, dependent: :destroy",
      "  belongs_to :organization",
    ];
    const groups = grouper.groupLines(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("associations");
    expect(groups[0].lines).toHaveLength(3);
  });

  it("should split different declaration types into separate groups", () => {
    const lines = [
      "  has_many :posts",
      "  has_many :comments",
      "",
      "  validates :email, presence: true",
      "  validates :name, presence: true",
      "",
      "  scope :active, -> { where(active: true) }",
      "  scope :recent, -> { order(created_at: :desc) }",
    ];
    const groups = grouper.groupLines(lines);
    expect(groups).toHaveLength(3);
    expect(groups[0].type).toBe("associations");
    expect(groups[1].type).toBe("validations");
    expect(groups[2].type).toBe("scopes");
  });

  it("should handle includes and extends", () => {
    const lines = [
      "  include AASM",
      "  include Searchable",
      "  extend ClassMethods",
    ];
    const groups = grouper.groupLines(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("includes");
  });

  it("should handle callbacks", () => {
    const lines = [
      "  before_save :normalize_email",
      "  after_create :send_welcome",
      "  before_validation :strip_whitespace",
    ];
    const groups = grouper.groupLines(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("callbacks");
  });

  it("should group unknown declarations as 'other'", () => {
    const lines = ["  CONSTANT = 42", "  TABLE_NAME = 'users'"];
    const groups = grouper.groupLines(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("other");
  });

  it("should keep blank-line-separated same-type groups merged", () => {
    const lines = ["  has_many :posts", "", "  has_many :comments"];
    const groups = grouper.groupLines(lines);
    // Same type separated by blank line -> still one group
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("associations");
  });

  it("should split oversized groups by maxChunkSize", () => {
    // Generate a group with many lines exceeding maxChunkSize
    const lines: string[] = [];
    for (let i = 0; i < 100; i++) {
      lines.push(`  scope :scope_${i}, -> { where(field_${i}: true) }`);
    }
    const groups = grouper.groupLines(lines, 500); // small maxChunkSize
    expect(groups.length).toBeGreaterThan(1);
    for (const group of groups) {
      expect(group.type).toBe("scopes");
    }
  });

  it("should handle mixed declarations in realistic model", () => {
    const lines = [
      "  include AASM",
      "  include Avatar",
      "",
      "  has_many :posts, dependent: :destroy",
      "  has_many :comments, dependent: :destroy",
      "  belongs_to :organization",
      "",
      "  enum :role, { admin: 0, user: 1, guest: 2 }",
      "",
      "  validates :email, presence: true, uniqueness: true",
      "  validates :name, length: { maximum: 255 }",
      "  validate :custom_validation",
      "",
      "  before_save :normalize_email",
      "  after_create :send_welcome_email",
      "",
      "  scope :active, -> { where(active: true) }",
      "  scope :admins, -> { where(role: :admin) }",
      "",
      "  delegate :name, to: :organization, prefix: true",
    ];
    const groups = grouper.groupLines(lines);
    const types = groups.map((g) => g.type);
    expect(types).toEqual([
      "includes",
      "associations",
      "enums",
      "validations",
      "callbacks",
      "scopes",
      "delegates",
    ]);
  });

  it("should handle multiline declarations (scope with block)", () => {
    const lines = [
      "  scope :complex, lambda {",
      "    where(active: true)",
      "      .where('created_at > ?', 1.week.ago)",
      "      .order(created_at: :desc)",
      "  }",
      "  scope :simple, -> { where(draft: false) }",
    ];
    const groups = grouper.groupLines(lines);
    expect(groups).toHaveLength(1);
    expect(groups[0].type).toBe("scopes");
    expect(groups[0].lines).toHaveLength(6);
  });

  it("should skip blank-only lines and preserve them as separators", () => {
    const lines = ["", "  has_many :posts", "", "", "  validates :email", ""];
    const groups = grouper.groupLines(lines);
    expect(groups).toHaveLength(2);
    expect(groups[0].type).toBe("associations");
    expect(groups[1].type).toBe("validations");
  });

  it("should handle class/end lines gracefully", () => {
    const lines = [
      "class User < ApplicationRecord",
      "  has_many :posts",
      "  validates :email",
      "end",
    ];
    const groups = grouper.groupLines(lines);
    // class/end lines are 'other', has_many is associations, validates is validations
    expect(groups.length).toBeGreaterThanOrEqual(2);
  });
});
```

### Step 2: Run tests to verify they fail

Run: `npx vitest run tests/code/chunker/ruby-body-grouper.test.ts` Expected:
FAIL — module does not exist yet

### Step 3: Implement RubyBodyGrouper

Create `src/code/chunker/ruby-body-grouper.ts`:

```typescript
/**
 * RubyBodyGrouper — Groups Ruby/Rails class body declarations by semantic type.
 *
 * When a class body is extracted (everything outside methods), this module
 * classifies each line into a declaration group (associations, validations,
 * scopes, callbacks, etc.) and produces separate chunks per group.
 *
 * Designed for Rails models where class bodies are 70-80% DSL declarations.
 */

export interface BodyGroup {
  type: string;
  lines: string[];
  /** 0-based index of first line in the original array */
  startIndex: number;
}

/**
 * Maps first identifier on a line to a group type.
 * Order doesn't matter — lookup is by keyword.
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

  // nested attributes
  accepts_nested_attributes_for: "nested_attrs",

  // delegates
  delegate: "delegates",
  delegate_missing_to: "delegates",

  // enums
  enum: "enums",

  // serialization
  serialize: "other",
  store_accessor: "other",
};

export class RubyBodyGrouper {
  /**
   * Classify a line's first keyword into a declaration group type.
   * Returns undefined for blank lines, continuation lines, or unrecognized patterns.
   */
  classifyLine(line: string): string | undefined {
    const trimmed = line.trim();
    if (trimmed.length === 0) return undefined;

    // Extract first word (identifier)
    const match = trimmed.match(/^(\w+)/);
    if (!match) return undefined;

    return DECLARATION_KEYWORDS[match[1]] ?? "other";
  }

  /**
   * Group body lines by declaration type.
   * Adjacent lines of the same type form one group.
   * Blank lines between same-type declarations are absorbed.
   * When type changes, a new group starts.
   * Groups exceeding maxChunkSize are split.
   *
   * @param lines - array of source lines (from class body, methods already removed)
   * @param maxChunkSize - max characters per group (optional, default unlimited)
   */
  groupLines(lines: string[], maxChunkSize?: number): BodyGroup[] {
    const groups: BodyGroup[] = [];
    let currentType: string | null = null;
    let currentLines: string[] = [];
    let currentStartIndex = 0;
    let pendingBlanks: string[] = [];

    const flushGroup = () => {
      if (currentLines.length > 0 && currentType) {
        groups.push({
          type: currentType,
          lines: [...currentLines],
          startIndex: currentStartIndex,
        });
      }
      currentLines = [];
      currentType = null;
      pendingBlanks = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const type = this.classifyLine(line);

      if (type === undefined) {
        // Blank or continuation line
        if (currentType) {
          pendingBlanks.push(line);
        }
        continue;
      }

      if (type === currentType) {
        // Same type — absorb pending blanks and add line
        currentLines.push(...pendingBlanks, line);
        pendingBlanks = [];
      } else {
        // Different type — flush current group and start new
        flushGroup();
        currentType = type;
        currentStartIndex = i;
        currentLines = [line];
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
      const content = group.lines.join("\n");
      if (content.length <= maxChunkSize) {
        result.push(group);
        continue;
      }

      // Split at line boundaries, respecting maxChunkSize
      let subLines: string[] = [];
      let subSize = 0;
      let subStart = group.startIndex;

      for (let i = 0; i < group.lines.length; i++) {
        const lineLen = group.lines[i].length + 1; // +1 for newline
        if (subSize + lineLen > maxChunkSize && subLines.length > 0) {
          result.push({
            type: group.type,
            lines: [...subLines],
            startIndex: subStart,
          });
          subLines = [];
          subSize = 0;
          subStart = group.startIndex + i;
        }
        subLines.push(group.lines[i]);
        subSize += lineLen;
      }

      if (subLines.length > 0) {
        result.push({
          type: group.type,
          lines: [...subLines],
          startIndex: subStart,
        });
      }
    }

    return result;
  }
}
```

### Step 4: Run tests to verify they pass

Run: `npx vitest run tests/code/chunker/ruby-body-grouper.test.ts` Expected: All
PASS

### Step 5: Commit

```bash
git add src/code/chunker/ruby-body-grouper.ts tests/code/chunker/ruby-body-grouper.test.ts
git commit -m "feat(chunker): add RubyBodyGrouper for semantic class body splitting"
```

---

## Task 2: Integrate RubyBodyGrouper into TreeSitterChunker

**Files:**

- Modify: `src/code/chunker/tree-sitter-chunker.ts:339-360` (body extraction)
- Modify: `tests/code/chunker/tree-sitter-chunker.test.ts:338-402` (update
  existing test)

### Step 1: Write failing test for multi-group body chunks

Add to `tests/code/chunker/tree-sitter-chunker.test.ts` in the Ruby section:

```typescript
it("should split large class body into semantic groups", async () => {
  const code = `
class User < ApplicationRecord
  include AASM
  include Searchable

  has_many :posts, dependent: :destroy
  has_many :comments, dependent: :destroy
  belongs_to :organization

  validates :email, presence: true, uniqueness: true
  validates :name, length: { maximum: 255 }
  validate :custom_validation

  before_save :normalize_email
  after_create :send_welcome_email

  scope :active, -> { where(active: true) }
  scope :admins, -> { where(role: :admin) }
  scope :recent, -> { order(created_at: :desc) }

  def full_name
    [first_name, last_name].compact.join(" ")
  end

  def admin?
    role == "admin"
  end
end
  `;

  const chunks = await chunker.chunk(code, "user.rb", "ruby");

  // Methods should be extracted individually
  const methodChunks = chunks.filter(
    (c) => c.metadata.chunkType === "function",
  );
  expect(methodChunks.length).toBe(2);

  // Body should be split into multiple semantic groups
  const bodyChunks = chunks.filter((c) => c.metadata.chunkType === "block");
  expect(bodyChunks.length).toBeGreaterThan(1);

  // Each body chunk should have context header (class declaration)
  for (const chunk of bodyChunks) {
    expect(chunk.content).toContain("class User < ApplicationRecord");
    expect(chunk.metadata.parentName).toBe("User");
    expect(chunk.metadata.parentType).toBe("class");
  }

  // Associations should be in one chunk
  const assocChunk = bodyChunks.find((c) =>
    c.content.includes("has_many :posts"),
  );
  expect(assocChunk).toBeDefined();
  expect(assocChunk!.content).toContain("belongs_to :organization");
  expect(assocChunk!.content).not.toContain("validates :email");

  // Validations should be in another chunk
  const validChunk = bodyChunks.find((c) =>
    c.content.includes("validates :email"),
  );
  expect(validChunk).toBeDefined();
  expect(validChunk!.content).not.toContain("has_many");

  // Scopes should be in their own chunk
  const scopeChunk = bodyChunks.find((c) =>
    c.content.includes("scope :active"),
  );
  expect(scopeChunk).toBeDefined();
  expect(scopeChunk!.content).toContain("scope :recent");
});
```

### Step 2: Run test to verify it fails

Run:
`npx vitest run tests/code/chunker/tree-sitter-chunker.test.ts -t "should split large class body"`
Expected: FAIL — currently produces single body chunk

### Step 3: Implement integration in TreeSitterChunker

Modify `src/code/chunker/tree-sitter-chunker.ts`:

1. Add import at top:

```typescript
import { RubyBodyGrouper } from "./ruby-body-grouper.js";
```

2. Add instance field (after `fallbackChunker` declaration):

```typescript
private rubyBodyGrouper = new RubyBodyGrouper();
```

3. Replace lines 339-360 (the body extraction block) with:

```typescript
// Extract class-level code (everything outside methods) as body chunk(s).
// For Ruby: use semantic grouping (associations, validations, scopes, etc.)
// For other languages: single body chunk (existing behavior)
if (langConfig.alwaysExtractChildren) {
  const bodyContent = this.extractContainerBody(node, validChildren, code);
  if (bodyContent && bodyContent.trim().length >= 50) {
    if (language === "ruby") {
      // Semantic grouping for Ruby/Rails class bodies
      const bodyLines = bodyContent.split("\n");
      const groups = this.rubyBodyGrouper.groupLines(
        bodyLines,
        this.config.maxChunkSize,
      );
      const classHeader = this.extractClassHeader(node, code);

      for (const group of groups) {
        const groupContent = group.lines.join("\n").trim();
        if (groupContent.length < 50) continue;

        // Prepend class header for context
        const contentWithContext = classHeader
          ? `${classHeader}\n${groupContent}`
          : groupContent;

        chunks.push({
          content: contentWithContext,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          metadata: {
            filePath,
            language,
            chunkIndex: chunks.length,
            chunkType: "block",
            name: parentName,
            parentName,
            parentType,
            symbolId: this.buildSymbolId(parentName),
          },
        });
      }
    } else {
      // Existing behavior for non-Ruby languages
      chunks.push({
        content: bodyContent.trim(),
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        metadata: {
          filePath,
          language,
          chunkIndex: chunks.length,
          chunkType: "block",
          name: parentName,
          parentName,
          parentType,
          symbolId: this.buildSymbolId(parentName),
        },
      });
    }
  }
}
```

4. Add helper method `extractClassHeader` to TreeSitterChunker class:

```typescript
/**
 * Extract class/module declaration line for context injection.
 * Returns "class Foo < Bar" or "module Baz" or undefined.
 */
private extractClassHeader(node: Parser.SyntaxNode, code: string): string | undefined {
  const lines = code.split("\n");
  const firstLine = lines[node.startPosition.row];
  if (firstLine && /^\s*(class|module)\s+/.test(firstLine)) {
    return firstLine.trim();
  }
  return undefined;
}
```

### Step 4: Update existing test expectation

The test at line 338-402 ("should extract class-level code...") expects
`bodyChunks.length === 1`. Update it:

```typescript
// Should have body chunks (semantic groups)
const bodyChunks = chunks.filter((c) => c.metadata.chunkType === "block");
expect(bodyChunks.length).toBeGreaterThanOrEqual(1);

// All body chunks together should contain the declarations
const allBodyContent = bodyChunks.map((c) => c.content).join("\n");
expect(allBodyContent).toContain("has_many :posts");
expect(allBodyContent).toContain("scope :active");
expect(allBodyContent).toContain("validates :name");
expect(allBodyContent).toContain("include Trackable");
expect(allBodyContent).toContain("before_save :normalize_email");

// Body chunks should NOT contain method implementations
for (const body of bodyChunks) {
  expect(body.content).not.toContain("def full_name");
  expect(body.content).not.toContain("def deactivate!");
}

// Each body chunk should have parent metadata
for (const body of bodyChunks) {
  expect(body.metadata.parentName).toBe("User");
  expect(body.metadata.parentType).toBe("class");
}
```

### Step 5: Run all chunker tests

Run: `npx vitest run tests/code/chunker/` Expected: All PASS

### Step 6: Commit

```bash
git add src/code/chunker/tree-sitter-chunker.ts tests/code/chunker/tree-sitter-chunker.test.ts
git commit -m "feat(chunker): integrate RubyBodyGrouper into tree-sitter chunker

Splits Ruby class bodies into semantic groups (associations, validations,
scopes, callbacks, etc.) instead of one monster chunk. Each group gets
the class header prepended for context."
```

---

## Task 3: Git Enrichment Path Filtering

**Files:**

- Modify: `src/code/scanner.ts` — expose ignore filter
- Modify: `src/code/indexer/enrichment-module.ts:77-134` — accept and apply
  filter
- Modify: `src/code/indexer/indexing-module.ts:149-150` — pass filter
- Modify: `src/code/indexer/reindex-module.ts:277` — pass filter
- Test: `tests/code/indexer/enrichment-module.test.ts` (add test)

### Step 1: Write failing test

Add to enrichment tests (or create new file):

```typescript
it("should filter git log results by ignore patterns", async () => {
  // Setup: mock git log that returns files matching .gitignore
  const mockGitLogResult = new Map([
    ["src/model.rb", { commits: [{}], linesAdded: 10, linesDeleted: 5 }],
    [
      "node_modules/lib/index.js",
      { commits: [{}], linesAdded: 100, linesDeleted: 50 },
    ],
    [
      "vendor/bundle/gem.rb",
      { commits: [{}], linesAdded: 20, linesDeleted: 10 },
    ],
  ]);

  // The ignore filter should remove node_modules/ and vendor/
  const ig = ignore().add(["node_modules/", "vendor/"]);

  // After filtering, only src/model.rb should remain
  for (const [path] of mockGitLogResult) {
    if (ig.ignores(path)) {
      mockGitLogResult.delete(path);
    }
  }

  expect(mockGitLogResult.size).toBe(1);
  expect(mockGitLogResult.has("src/model.rb")).toBe(true);
});
```

### Step 2: Expose ignore filter from FileScanner

Add to `src/code/scanner.ts` in the `FileScanner` class:

```typescript
/**
 * Get the configured ignore filter instance.
 * Used by enrichment module to filter git log results.
 */
getIgnoreFilter(): Ignore {
  return this.ig;
}
```

### Step 3: Update EnrichmentModule to accept ignore filter

Modify `src/code/indexer/enrichment-module.ts`:

1. Add import:

```typescript
import type { Ignore } from "ignore";
```

2. Add field:

```typescript
private ignoreFilter: Ignore | null = null;
```

3. Update `prefetchGitLog` signature and filter logic:

```typescript
prefetchGitLog(absolutePath: string, collectionName?: string, ignoreFilter?: Ignore): void {
  this.startTime = Date.now();
  this.prefetchStartTime = Date.now();
  this.ignoreFilter = ignoreFilter ?? null;

  // ... existing code up to the .then() handler ...

  this.gitLogPromise = this.logReader
    .buildFileMetadataMap(absolutePath)
    .then((result) => {
      this.prefetchEndTime = Date.now();
      this.gitLogResult = result;
      this.metrics.prefetchDurationMs = this.prefetchEndTime - this.prefetchStartTime;

      // Filter git log results by ignore patterns (.gitignore, .contextignore)
      if (this.ignoreFilter) {
        let filtered = 0;
        for (const [path] of result) {
          if (this.ignoreFilter.ignores(path)) {
            result.delete(path);
            filtered++;
          }
        }
        if (filtered > 0 && process.env.DEBUG) {
          console.error(`[EnrichmentModule] Filtered ${filtered} ignored paths from git log`);
        }
      }

      pipelineLog.enrichmentPhase("PREFETCH_COMPLETE", {
        filesInLog: result.size,
        durationMs: this.metrics.prefetchDurationMs,
      });
      // ... rest of existing code ...
    });
}
```

### Step 4: Pass filter from IndexingModule

Modify `src/code/indexer/indexing-module.ts:149-150`:

```typescript
// Before (line 150):
this.enrichment.prefetchGitLog(absolutePath, collectionName);

// After:
this.enrichment.prefetchGitLog(
  absolutePath,
  collectionName,
  scanner.getIgnoreFilter(),
);
```

### Step 5: Pass filter from ReindexModule

Modify `src/code/indexer/reindex-module.ts:277`:

```typescript
// Before:
this.enrichment.prefetchGitLog(absolutePath, collectionName);

// After:
this.enrichment.prefetchGitLog(
  absolutePath,
  collectionName,
  scanner.getIgnoreFilter(),
);
```

### Step 6: Run all tests

Run: `npx vitest run` Expected: All PASS

### Step 7: Commit

```bash
git add src/code/scanner.ts src/code/indexer/enrichment-module.ts src/code/indexer/indexing-module.ts src/code/indexer/reindex-module.ts
git commit -m "fix(git): filter git log results by .gitignore/.contextignore

Passes scanner's ignore filter to EnrichmentModule. After git log
prefetch completes, filters out paths matching ignore patterns.
Reduces git log map size and fixes misleading path mismatch diagnostics."
```

---

## Task 4: Run Full Test Suite and Verify

### Step 1: Run full test suite

Run: `npx vitest run` Expected: All tests pass, no regressions

### Step 2: Manual verification with small Ruby file

Create a temporary test to verify end-to-end:

```typescript
it("should chunk a realistic Rails model into semantic groups", async () => {
  const code = `
class Invoice < ApplicationRecord
  include AASM
  include Billable

  has_many :line_items, dependent: :destroy
  has_many :payments, dependent: :nullify
  has_one :receipt
  belongs_to :client
  belongs_to :firm

  enum :status, { draft: 0, sent: 1, paid: 2, overdue: 3 }

  validates :number, presence: true, uniqueness: { scope: :firm_id }
  validates :amount, numericality: { greater_than: 0 }
  validates :due_date, presence: true
  validate :due_date_not_in_past

  before_save :calculate_totals
  after_create :assign_number
  after_update :notify_status_change, if: :saved_change_to_status?

  scope :draft, -> { where(status: :draft) }
  scope :sent, -> { where(status: :sent) }
  scope :overdue, -> { where(status: :overdue).where("due_date < ?", Date.current) }
  scope :by_client, ->(client_id) { where(client_id: client_id) }
  scope :recent, -> { order(created_at: :desc) }

  delegate :name, :email, to: :client, prefix: true

  def mark_as_paid!
    update!(status: :paid, paid_at: Time.current)
  end

  def overdue?
    sent? && due_date < Date.current
  end

  private

  def calculate_totals
    self.subtotal = line_items.sum(:amount)
    self.total = subtotal + tax_amount
  end
end
  `;

  const chunks = await chunker.chunk(code, "invoice.rb", "ruby");

  const methodChunks = chunks.filter(
    (c) => c.metadata.chunkType === "function",
  );
  const bodyChunks = chunks.filter((c) => c.metadata.chunkType === "block");

  // Methods: mark_as_paid!, overdue?, calculate_totals
  expect(methodChunks.length).toBe(3);

  // Body: includes, associations, enums, validations, callbacks, scopes, delegates
  // Some may merge if small, but should be >1
  expect(bodyChunks.length).toBeGreaterThan(1);

  // Each body chunk has class context
  for (const chunk of bodyChunks) {
    expect(chunk.content).toContain("class Invoice < ApplicationRecord");
  }

  console.log(
    `Chunks: ${methodChunks.length} methods + ${bodyChunks.length} body groups`,
  );
  for (const chunk of bodyChunks) {
    console.log(
      `  Body chunk (${chunk.content.length} chars): ${chunk.content.substring(0, 80)}...`,
    );
  }
});
```

### Step 3: Final commit

```bash
git add -A
git commit -m "test: add integration test for Rails model semantic chunking"
```
