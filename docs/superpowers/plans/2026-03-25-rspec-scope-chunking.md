# RSpec Scope-Centric Chunking — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current per-level RSpec chunking with scope-centric
strategy where leaf scopes (describe/context without nested containers) become
the unit of chunking, with parent setup injection.

**Architecture:** New hook `rspec-scope-chunker` walks the full AST subtree in
one pass, builds a scope tree, identifies leaf vs intermediate scopes, collects
setup at each level, and produces all chunks via `ctx.bodyChunks` with
`ctx.skipChildren = true`. Existing `processChildren` recursion is bypassed for
RSpec files.

**Tech Stack:** TypeScript, tree-sitter (Ruby grammar), vitest

**Spec:** `docs/superpowers/specs/2026-03-25-rspec-scope-chunking-design.md`

---

## File Map

| Action | File                                                                                  | Responsibility                                                               |
| ------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Modify | `src/core/domains/ingest/pipeline/chunker/hooks/types.ts`                             | Add `skipChildren` to HookContext, `chunkType`/`symbolId` to BodyChunkResult |
| Modify | `src/core/types.ts:205`                                                               | Extend inline chunkType union                                                |
| Create | `src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.ts`          | Scope-centric chunking logic                                                 |
| Create | `tests/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.test.ts`   | Tests for scope chunker                                                      |
| Modify | `src/core/domains/ingest/pipeline/chunker/hooks/ruby/index.ts`                        | Add hook to chain                                                            |
| Modify | `src/core/domains/ingest/pipeline/chunker/hooks/ruby/class-body-chunker.ts`           | Remove `extractRspecBodyChunk`, add guard, add `let!`                        |
| Modify | `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts:206,224-241,460,544-562,771` | `skipChildren` check, use `result.chunkType`/`result.symbolId`               |

---

### Task 1: Extend HookContext and BodyChunkResult interfaces

**Files:**

- Modify: `src/core/domains/ingest/pipeline/chunker/hooks/types.ts`
- Modify: `src/core/types.ts:205`

- [ ] **Step 1: Add `skipChildren` to HookContext and extend BodyChunkResult**

```typescript
// In hooks/types.ts — BodyChunkResult, add after lineRanges:
export interface BodyChunkResult {
  content: string;
  startLine: number;
  endLine: number;
  lineRanges?: { start: number; end: number }[];
  /** Hook-provided chunk type. When present, chunker uses instead of "block". */
  chunkType?: string;
  /** Hook-provided symbolId. When present, chunker uses instead of buildSymbolId(). */
  symbolId?: string;
  /** Hook-provided chunk name. When present, chunker uses instead of parentName. */
  name?: string;
  /** Hook-provided parent name. */
  parentName?: string;
}

// In hooks/types.ts — HookContext, add to mutable state section:
  /** When true, processChildren() skips child chunk emission. */
  skipChildren?: boolean;
```

- [ ] **Step 2: Update `createHookContext` to initialize `skipChildren`**

Add `skipChildren: false` to the returned object in `createHookContext()`.

- [ ] **Step 3: Extend chunkType union in `src/core/types.ts:205`**

```typescript
// Before:
chunkType?: "function" | "class" | "interface" | "block";

// After:
chunkType?: "function" | "class" | "interface" | "block" | "test" | "test_setup";
```

- [ ] **Step 4: Extend `getChunkType()` return type in `tree-sitter.ts:771`**

```typescript
// Before:
private getChunkType(nodeType: string): "function" | "class" | "interface" | "block" {

// After:
private getChunkType(nodeType: string): "function" | "class" | "interface" | "block" | "test" | "test_setup" {
```

No logic change — just type consistency.

- [ ] **Step 5: Run type check**

Run: `npx tsc --noEmit` Expected: PASS (no type errors, no behavior change)

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/pipeline/chunker/hooks/types.ts src/core/types.ts src/core/domains/ingest/pipeline/chunker/tree-sitter.ts
git commit -m "improve(chunker): extend HookContext with skipChildren and BodyChunkResult with chunkType/symbolId"
```

---

### Task 2: Wire `skipChildren` and `result.chunkType`/`result.symbolId` in TreeSitterChunker

**Files:**

- Modify: `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`

- [ ] **Step 1: Add `skipChildren` guard in `processChildren()` (line ~472)**

At the very start of `processChildren()`, before the for loop:

```typescript
async processChildren(...): Promise<void> {
    // If hook chain has taken over chunking (e.g., RSpec scope chunker),
    // skip child emission — all chunks are in ctx.bodyChunks
    if (ctx.skipChildren) return;

    for (let ci = 0; ...
```

- [ ] **Step 2: Use `result.chunkType` and `result.symbolId` in top-level body
      chunk emission (line ~224-241)**

```typescript
// Before (line 234):
chunkType: "block",
// ...
symbolId: this.buildSymbolId(parentName),

// After:
chunkType: (result.chunkType as CodeChunk["metadata"]["chunkType"]) ?? "block",
// ...
symbolId: result.symbolId ?? this.buildSymbolId(parentName),
```

`name` and `parentName` fields already added to `BodyChunkResult` in Task 1.

In tree-sitter.ts top-level emission (~line 224-241):

```typescript
for (const result of ctx.bodyChunks) {
  const bodyContent = `${containerHeader}\n${result.content}`;
  chunks.push({
    content: bodyContent,
    startLine: result.startLine,
    endLine: result.endLine,
    metadata: {
      filePath,
      language,
      chunkIndex: chunks.length,
      chunkType:
        (result.chunkType as CodeChunk["metadata"]["chunkType"]) ?? "block",
      name: result.name ?? parentName,
      parentName: result.parentName ?? parentName,
      parentType,
      symbolId: result.symbolId ?? this.buildSymbolId(parentName),
      lineRanges: result.lineRanges,
    },
  });
}
```

- [ ] **Step 3: Same changes in nested body chunk emission (line ~544-562)**

```typescript
for (const result of childCtx.bodyChunks) {
  const bodyContent =
    hierarchyHeaders.length > 0
      ? `${hierarchyPrefix}${childHeader}\n${result.content}`
      : result.content;
  chunks.push({
    content: bodyContent,
    startLine: result.startLine,
    endLine: result.endLine,
    metadata: {
      filePath,
      language,
      chunkIndex: chunks.length,
      chunkType:
        (result.chunkType as CodeChunk["metadata"]["chunkType"]) ?? "block",
      name: result.name ?? childName,
      parentName: result.parentName ?? fullParentName ?? parentName,
      parentType,
      symbolId: result.symbolId ?? this.buildSymbolId(childName),
      lineRanges: result.lineRanges,
    },
  });
}
```

- [ ] **Step 4: Run existing tests**

Run: `npx vitest run tests/core/domains/ingest/pipeline/chunker/` Expected: ALL
PASS (no behavior change — skipChildren defaults to false,
chunkType/symbolId/name/parentName are undefined in existing hooks so fallbacks
apply)

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/chunker/hooks/types.ts src/core/domains/ingest/pipeline/chunker/tree-sitter.ts
git commit -m "improve(chunker): wire skipChildren guard and hook-provided metadata in body chunk emission"
```

---

### Task 3: Add `let!` to DECLARATION_KEYWORDS and add guard to rubyBodyChunkingHook

**Files:**

- Modify:
  `src/core/domains/ingest/pipeline/chunker/hooks/ruby/class-body-chunker.ts`
- Test:
  `tests/core/domains/ingest/pipeline/chunker/hooks/ruby/class-body-chunker.test.ts`

- [ ] **Step 1: Write failing test for `let!` classification**

In `class-body-chunker.test.ts`, find the `classifyLine` test group and add:

```typescript
it("should classify let! as setup", () => {
  expect(chunker.classifyLine("  let!(:user) { create(:user) }")).toBe("setup");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/chunker/hooks/ruby/class-body-chunker.test.ts -t "let!"`
Expected: FAIL — `let!` starts with `let` but `!` makes it a different token.
Actually `let!` matches `/^(\w+)/` as `let` which IS in DECLARATION_KEYWORDS.
Let me verify...

The regex `match(/^(\w+)/)` on `"let!(:user)..."` captures `"let"` (since `!` is
not `\w`). So `let!` already classifies as `"setup"` via the `let` keyword. The
test should PASS.

Run:
`npx vitest run tests/core/domains/ingest/pipeline/chunker/hooks/ruby/class-body-chunker.test.ts -t "let!"`
Expected: PASS — `let!` already works because regex captures `let` before `!`.

- [ ] **Step 3: Add guard to rubyBodyChunkingHook.process()**

In `class-body-chunker.ts`, modify `rubyBodyChunkingHook.process()` (line ~617):

```typescript
// Before:
export const rubyBodyChunkingHook: ChunkingHook = {
  name: "rubyBodyChunking",
  process(ctx) {
    if (isRspecFile(ctx.filePath)) {
      ctx.bodyChunks = extractRspecBodyChunk(ctx.containerNode, ctx.validChildren, ctx.code, ctx.excludedRows);
    } else {

// After:
export const rubyBodyChunkingHook: ChunkingHook = {
  name: "rubyBodyChunking",
  process(ctx) {
    // Skip if another hook (e.g., rspec-scope-chunker) already produced body chunks
    if (ctx.bodyChunks.length > 0) return;

    if (isRspecFile(ctx.filePath)) {
      ctx.bodyChunks = extractRspecBodyChunk(ctx.containerNode, ctx.validChildren, ctx.code, ctx.excludedRows);
    } else {
```

Note: We keep `extractRspecBodyChunk` for now as fallback. It will be removed in
Task 6 after the scope chunker is working and tested.

- [ ] **Step 4: Run all Ruby hook tests**

Run: `npx vitest run tests/core/domains/ingest/pipeline/chunker/hooks/ruby/`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/chunker/hooks/ruby/class-body-chunker.ts tests/core/domains/ingest/pipeline/chunker/hooks/ruby/class-body-chunker.test.ts
git commit -m "improve(chunker): add bodyChunks guard to rubyBodyChunkingHook and test let! classification"
```

---

### Task 4: Implement rspec-scope-chunker — scope tree builder

**Files:**

- Create:
  `src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.ts`
- Create:
  `tests/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.test.ts`

This task builds the core data structure — the scope tree. No chunk production
yet, just tree building + setup collection.

- [ ] **Step 1: Write failing tests for scope tree building**

Create test file
`tests/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.test.ts`:

```typescript
import Parser from "tree-sitter";
import Ruby from "tree-sitter-ruby";
import { describe, expect, it } from "vitest";

import {
  buildScopeTree,
  type RSpecScope,
} from "../../../../../../../../src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.js";

function parseRuby(code: string): Parser.SyntaxNode {
  const parser = new Parser();
  parser.setLanguage(Ruby as unknown as Parser.Language);
  return parser.parse(code).rootNode;
}

describe("buildScopeTree", () => {
  it("should identify a single leaf scope", () => {
    const code = `
describe User do
  let(:user) { create(:user) }
  it 'has a name' do
    expect(user.name).to be_present
  end
end`;
    const root = parseRuby(code);
    const describeNode = root.children[0]; // call node
    const tree = buildScopeTree(describeNode, code);

    expect(tree.isLeaf).toBe(true);
    expect(tree.name).toBe("describe User");
    expect(tree.setupLines.length).toBeGreaterThan(0);
    expect(tree.children).toHaveLength(0);
  });

  it("should identify intermediate and leaf scopes", () => {
    const code = `
describe User do
  let(:company) { create(:company) }
  context 'when admin' do
    let(:user) { create(:admin) }
    it 'has access' do
      expect(user).to be_admin
    end
  end
end`;
    const root = parseRuby(code);
    const describeNode = root.children[0];
    const tree = buildScopeTree(describeNode, code);

    expect(tree.isLeaf).toBe(false);
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].isLeaf).toBe(true);
    expect(tree.children[0].name).toContain("context");
  });

  it("should collect setup lines from each scope level", () => {
    const code = `
describe User do
  let(:company) { create(:company) }
  before { login(company) }
  context 'when admin' do
    let(:user) { create(:admin) }
    subject { described_class.new(user) }
    it 'works' do
      expect(subject).to be_valid
    end
  end
end`;
    const root = parseRuby(code);
    const describeNode = root.children[0];
    const tree = buildScopeTree(describeNode, code);

    // Root has 2 setup lines: let(:company) + before
    expect(tree.setupLines.length).toBe(2);
    // Child has 2 setup lines: let(:user) + subject
    expect(tree.children[0].setupLines.length).toBe(2);
  });

  it("should detect it blocks at intermediate scope level", () => {
    const code = `
describe User do
  it 'exists' do
    expect(User).to be_a(Class)
  end
  context 'when admin' do
    it 'has access' do
      expect(true).to be true
    end
  end
end`;
    const root = parseRuby(code);
    const describeNode = root.children[0];
    const tree = buildScopeTree(describeNode, code);

    expect(tree.isLeaf).toBe(false);
    expect(tree.ownItBlocks.length).toBe(1); // it 'exists'
    expect(tree.children).toHaveLength(1); // context 'when admin'
  });

  it("should handle deeply nested scopes (3+ levels)", () => {
    const code = `
describe User do
  context 'when admin' do
    context 'with expired token' do
      context 'on weekday' do
        it 'denies' do
          expect(true).to be true
        end
      end
    end
  end
end`;
    const root = parseRuby(code);
    const describeNode = root.children[0];
    const tree = buildScopeTree(describeNode, code);

    expect(tree.isLeaf).toBe(false);
    expect(tree.children[0].isLeaf).toBe(false);
    expect(tree.children[0].children[0].isLeaf).toBe(false);
    expect(tree.children[0].children[0].children[0].isLeaf).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `buildScopeTree` and `RSpecScope` type**

Create
`src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.ts`:

```typescript
/**
 * RSpec Scope-Centric Chunker
 *
 * Walks the full AST subtree of an RSpec file, builds a scope tree,
 * and produces chunks where each leaf scope (describe/context without
 * nested containers) is the unit of chunking.
 *
 * Parent setup (let/before/subject) is injected into each leaf chunk
 * for semantic self-containment.
 */

import type Parser from "tree-sitter";

import type { BodyChunkResult, ChunkingHook, HookContext } from "../types.js";
import { isRspecFile } from "./rspec-filter.js";

// ── Types ────────────────────────────────────────────────────────────

/** RSpec container method names */
const CONTAINER_METHODS = new Set([
  "describe",
  "context",
  "feature",
  "shared_examples",
  "shared_context",
  "shared_examples_for",
]);

/** RSpec example method names */
const EXAMPLE_METHODS = new Set([
  "it",
  "specify",
  "example",
  "scenario",
  "its",
  "xit",
  "xspecify",
  "xexample",
  "fit",
  "fspecify",
  "fexample",
]);

/** Setup method names — lines to collect and inject into leaf chunks */
const SETUP_METHODS = new Set([
  "let",
  "let!",
  "subject",
  "before",
  "after",
  "around",
  "shared_context",
  "include_context",
  "it_behaves_like",
  "include_examples",
]);

export interface SetupLine {
  text: string;
  /** 0-based row in original source */
  row: number;
}

export interface ItBlock {
  /** Full text content of the it block */
  content: string;
  startRow: number;
  endRow: number;
}

export interface RSpecScope {
  /** Scope name from nameExtractor (e.g., "describe User", "context 'when admin'") */
  name: string;
  /** AST node for this scope */
  node: Parser.SyntaxNode;
  /** True if this scope has no nested container scopes */
  isLeaf: boolean;
  /** Setup lines defined at this scope level */
  setupLines: SetupLine[];
  /** it blocks that are direct children of this scope (not inside nested containers) */
  ownItBlocks: ItBlock[];
  /** Nested container scopes */
  children: RSpecScope[];
  /** Content lines that are not setup, not it blocks, not containers (e.g., helper methods) */
  otherLines: SetupLine[];
}

// ── Scope Tree Builder ───────────────────────────────────────────────

/**
 * Extract method name from a call AST node.
 */
function getCallMethodName(
  node: Parser.SyntaxNode,
  code: string,
): string | null {
  if (node.type !== "call") return null;
  const id = node.children.find((c) => c.type === "identifier");
  return id ? code.substring(id.startIndex, id.endIndex) : null;
}

/**
 * Extract the display name for a scope: "methodName firstArg"
 */
function extractScopeName(node: Parser.SyntaxNode, code: string): string {
  const methodName = getCallMethodName(node, code) ?? "unknown";
  const args = node.childForFieldName("arguments");
  if (args && args.namedChildren.length > 0) {
    const firstArg = args.namedChildren[0];
    const argText = code.substring(firstArg.startIndex, firstArg.endIndex);
    return `${methodName} ${argText}`;
  }
  return methodName;
}

/**
 * Check if a call node is a container (describe/context/etc.)
 */
function isContainerCall(node: Parser.SyntaxNode, code: string): boolean {
  const name = getCallMethodName(node, code);
  return name !== null && CONTAINER_METHODS.has(name);
}

/**
 * Check if a call node is an example (it/specify/etc.)
 */
function isExampleCall(node: Parser.SyntaxNode, code: string): boolean {
  const name = getCallMethodName(node, code);
  return name !== null && EXAMPLE_METHODS.has(name);
}

/**
 * Check if a line starts with a setup method.
 */
function isSetupLine(lineText: string): boolean {
  const trimmed = lineText.trim();
  if (trimmed.length === 0) return false;
  const match = trimmed.match(/^(\w+!?)/);
  if (!match) return false;
  return SETUP_METHODS.has(match[1]);
}

/**
 * Build scope tree from an RSpec container AST node.
 * Recursively identifies leaf vs intermediate scopes, collects setup,
 * and categorizes it blocks.
 */
export function buildScopeTree(
  containerNode: Parser.SyntaxNode,
  code: string,
): RSpecScope {
  const name = extractScopeName(containerNode, code);
  const children: RSpecScope[] = [];
  const setupLines: SetupLine[] = [];
  const ownItBlocks: ItBlock[] = [];
  const otherLines: SetupLine[] = [];

  // Find the block body (do_block or block)
  const blockBody = containerNode.children.find(
    (c) => c.type === "do_block" || c.type === "block",
  );
  if (!blockBody) {
    return {
      name,
      node: containerNode,
      isLeaf: true,
      setupLines,
      ownItBlocks,
      children,
      otherLines,
    };
  }

  // Collect rows occupied by child containers and it blocks
  const childNodeRows = new Set<number>();
  const lines = code.split("\n"); // Hoist outside loops — single split

  // Walk direct children of block body to find containers, it blocks, and setup
  const walkChildren = (parent: Parser.SyntaxNode): void => {
    for (const child of parent.children) {
      if (child.type === "call") {
        if (isContainerCall(child, code)) {
          children.push(buildScopeTree(child, code));
          for (
            let r = child.startPosition.row;
            r <= child.endPosition.row;
            r++
          ) {
            childNodeRows.add(r);
          }
          continue;
        }
        if (isExampleCall(child, code)) {
          ownItBlocks.push({
            content: code.substring(child.startIndex, child.endIndex),
            startRow: child.startPosition.row,
            endRow: child.endPosition.row,
          });
          for (
            let r = child.startPosition.row;
            r <= child.endPosition.row;
            r++
          ) {
            childNodeRows.add(r);
          }
          continue;
        }
      }

      // Check if this is a call with setup method (let, before, etc.)
      if (child.type === "call") {
        const methodName = getCallMethodName(child, code);
        if (methodName && SETUP_METHODS.has(methodName)) {
          // Collect all lines of this setup call
          for (
            let r = child.startPosition.row;
            r <= child.endPosition.row;
            r++
          ) {
            setupLines.push({ text: lines[r], row: r });
            childNodeRows.add(r);
          }
          continue;
        }
      }

      // Recurse into non-call children (e.g., body_statement)
      // to find nested calls at any depth within the block
      if (child.type !== "call") {
        walkChildren(child);
      }
    }
  };

  walkChildren(blockBody);

  // Collect remaining lines as "other" (not setup, not it, not containers)
  const blockStartRow = blockBody.startPosition.row;
  const blockEndRow = blockBody.endPosition.row;
  for (let r = blockStartRow + 1; r < blockEndRow; r++) {
    if (!childNodeRows.has(r)) {
      const text = lines[r];
      if (text && text.trim().length > 0) {
        otherLines.push({ text, row: r });
      }
    }
  }

  const isLeaf = children.length === 0;

  return {
    name,
    node: containerNode,
    isLeaf,
    setupLines,
    ownItBlocks,
    children,
    otherLines,
  };
}

// ── Hook Export (placeholder — chunk production in Task 5) ───────────

export const rspecScopeChunkerHook: ChunkingHook = {
  name: "rspec-scope-chunker",

  process(ctx: HookContext): void {
    if (!isRspecFile(ctx.filePath)) return;
    // Chunk production will be implemented in Task 5
  },
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.ts tests/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.test.ts
git commit -m "feat(chunker): add RSpec scope tree builder with leaf/intermediate detection"
```

---

### Task 5: Implement chunk production from scope tree

**Files:**

- Modify:
  `src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.ts`
- Modify:
  `tests/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.test.ts`

- [ ] **Step 1: Write failing tests for chunk production**

Add to the test file:

```typescript
import {
  buildScopeTree,
  produceScopeChunks,
  type RSpecScope,
} from "../../../../../../../../src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.js";

describe("produceScopeChunks", () => {
  it("should produce a single test chunk for a leaf scope", () => {
    const code = `
describe User do
  let(:user) { create(:user) }
  it 'has a name' do
    expect(user.name).to be_present
  end
end`;
    const root = parseRuby(code);
    const tree = buildScopeTree(root.children[0], code);
    const chunks = produceScopeChunks(tree, code, { maxChunkSize: 5000 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test");
    expect(chunks[0].content).toContain("let(:user)");
    expect(chunks[0].content).toContain("has a name");
    expect(chunks[0].symbolId).toBe("User");
  });

  it("should inject parent setup into leaf chunks", () => {
    const code = `
describe User do
  let(:company) { create(:company) }
  context 'when admin' do
    let(:user) { create(:admin) }
    it 'has access' do
      expect(user).to be_admin
    end
  end
end`;
    const root = parseRuby(code);
    const tree = buildScopeTree(root.children[0], code);
    const chunks = produceScopeChunks(tree, code, { maxChunkSize: 5000 });

    // Should have 1 leaf chunk with injected parent setup
    const testChunks = chunks.filter((c) => c.chunkType === "test");
    expect(testChunks).toHaveLength(1);
    expect(testChunks[0].content).toContain("let(:company)");
    expect(testChunks[0].content).toContain("let(:user)");
    expect(testChunks[0].content).toContain("has access");
    expect(testChunks[0].symbolId).toBe("User.context 'when admin'");
  });

  it("should produce test_setup chunk for intermediate scope with own it blocks", () => {
    const code = `
describe User do
  let(:company) { create(:company) }
  it 'exists' do
    expect(User).to be_a(Class)
  end
  context 'when admin' do
    it 'has access' do
      expect(true).to be true
    end
  end
end`;
    const root = parseRuby(code);
    const tree = buildScopeTree(root.children[0], code);
    const chunks = produceScopeChunks(tree, code, { maxChunkSize: 5000 });

    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");
    expect(setupChunks.length).toBeGreaterThanOrEqual(1);
    // Body chunk should contain the intermediate it block
    const bodyContent = setupChunks.map((c) => c.content).join("\n");
    expect(bodyContent).toContain("exists");

    const testChunks = chunks.filter((c) => c.chunkType === "test");
    expect(testChunks).toHaveLength(1);
    expect(testChunks[0].content).toContain("has access");
  });

  it("should split oversized leaf scope by maxChunkSize", () => {
    // Create a leaf scope with many it blocks
    const itBlocks = Array.from(
      { length: 20 },
      (_, i) => `  it 'test ${i}' do\n    expect(${i}).to eq(${i})\n  end`,
    ).join("\n");
    const code = `
describe BigSpec do
  let(:x) { 1 }
${itBlocks}
end`;
    const root = parseRuby(code);
    const tree = buildScopeTree(root.children[0], code);
    // Very small maxChunkSize to force splitting
    const chunks = produceScopeChunks(tree, code, { maxChunkSize: 300 });

    expect(chunks.length).toBeGreaterThan(1);
    // Each sub-chunk should contain the setup
    for (const chunk of chunks) {
      expect(chunk.content).toContain("let(:x)");
      expect(chunk.chunkType).toBe("test");
    }
  });

  it("should produce test_setup for setup-only scope (no it blocks)", () => {
    const code = `
describe User do
  context 'setup only' do
    let(:user) { create(:user) }
    before { user.activate! }
  end
end`;
    const root = parseRuby(code);
    const tree = buildScopeTree(root.children[0], code);
    const chunks = produceScopeChunks(tree, code, { maxChunkSize: 5000 });

    const setupChunks = chunks.filter((c) => c.chunkType === "test_setup");
    expect(setupChunks.length).toBeGreaterThanOrEqual(1);
    const testChunks = chunks.filter((c) => c.chunkType === "test");
    expect(testChunks).toHaveLength(0);
  });

  it("should use 2-level symbolId format", () => {
    const code = `
describe User do
  context 'when admin' do
    context 'with expired token' do
      it 'denies' do
        expect(true).to be true
      end
    end
  end
end`;
    const root = parseRuby(code);
    const tree = buildScopeTree(root.children[0], code);
    const chunks = produceScopeChunks(tree, code, { maxChunkSize: 5000 });

    const testChunk = chunks.find((c) => c.chunkType === "test");
    expect(testChunk).toBeDefined();
    // 2-level: TopLevelDescribe.leafName
    expect(testChunk!.symbolId).toBe("User.context 'with expired token'");
  });

  it("should handle RSpec.describe form (receiver-qualified call)", () => {
    const code = `
RSpec.describe User do
  it 'works' do
    expect(true).to be true
  end
end`;
    const root = parseRuby(code);
    const tree = buildScopeTree(root.children[0], code);
    const chunks = produceScopeChunks(tree, code, { maxChunkSize: 5000 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test");
    expect(chunks[0].symbolId).toBe("User");
  });

  it("should handle top-level shared_examples without wrapping describe", () => {
    const code = `
shared_examples 'authenticable' do
  it 'validates token' do
    expect(subject).to be_valid
  end
end`;
    const root = parseRuby(code);
    const tree = buildScopeTree(root.children[0], code);
    const chunks = produceScopeChunks(tree, code, { maxChunkSize: 5000 });

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkType).toBe("test");
    // TopLevelDescribe fallback for shared_examples
    expect(chunks[0].symbolId).toContain("authenticable");
  });

  it("should include shoulda one-liners as content in leaf scope", () => {
    const code = `
describe User do
  it { is_expected.to validate_presence_of(:name) }
  it { is_expected.to validate_presence_of(:email) }
end`;
    const root = parseRuby(code);
    const tree = buildScopeTree(root.children[0], code);
    const chunks = produceScopeChunks(tree, code, { maxChunkSize: 5000 });

    expect(chunks.length).toBeGreaterThanOrEqual(1);
    const content = chunks.map((c) => c.content).join("\n");
    expect(content).toContain("validate_presence_of(:name)");
    expect(content).toContain("validate_presence_of(:email)");
  });

  it("should produce no chunks for empty describe block", () => {
    const code = `
describe User do
end`;
    const root = parseRuby(code);
    const tree = buildScopeTree(root.children[0], code);
    const chunks = produceScopeChunks(tree, code, { maxChunkSize: 5000 });

    expect(chunks).toHaveLength(0);
  });

  it("should capture let! as setup line", () => {
    const code = `
describe User do
  let!(:user) { create(:user) }
  it 'works' do
    expect(user).to be_persisted
  end
end`;
    const root = parseRuby(code);
    const tree = buildScopeTree(root.children[0], code);

    expect(tree.setupLines.some((s) => s.text.includes("let!"))).toBe(true);
    const chunks = produceScopeChunks(tree, code, { maxChunkSize: 5000 });
    expect(chunks[0].content).toContain("let!");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.test.ts -t "produceScopeChunks"`
Expected: FAIL — `produceScopeChunks` not exported

- [ ] **Step 3: Implement `produceScopeChunks`**

Add to `rspec-scope-chunker.ts`:

```typescript
// ── Chunk Production ─────────────────────────────────────────────────

/**
 * Extract TopLevelDescribe name — first argument of the root describe.
 * e.g., "describe User do" → "User"
 *       "describe 'some string' do" → "'some string'"
 *       "shared_examples 'auth' do" → "shared_examples 'auth'"
 */
function extractTopLevelName(scope: RSpecScope): string {
  const args = scope.node.childForFieldName("arguments");
  if (args && args.namedChildren.length > 0) {
    const firstArg = args.namedChildren[0];
    // For constants (User, Admin::Panel), use the constant name directly
    if (firstArg.type === "constant" || firstArg.type === "scope_resolution") {
      return scope.name.split(" ").slice(1).join(" ");
    }
    // For strings, include them
    return scope.name.split(" ").slice(1).join(" ");
  }
  return scope.name;
}

/**
 * Build 2-level symbolId: "TopLevelDescribe.leafScopeName"
 */
function build2LevelSymbolId(
  topLevelName: string,
  scope: RSpecScope,
  isRoot: boolean,
): string {
  if (isRoot) return topLevelName;
  return `${topLevelName}.${scope.name}`;
}

/**
 * Produce chunks from scope tree.
 *
 * - Leaf scopes → "test" chunks with injected parent setup
 * - Intermediate scopes with own it blocks → "test_setup" body chunks
 * - Setup-only leaf scopes → "test_setup" chunks
 */
export function produceScopeChunks(
  rootScope: RSpecScope,
  code: string,
  config: { maxChunkSize: number },
  parentSetup: SetupLine[] = [],
): BodyChunkResult[] {
  const results: BodyChunkResult[] = [];
  const topLevelName = extractTopLevelName(rootScope);

  function walkScope(scope: RSpecScope, inheritedSetup: SetupLine[]): void {
    const allSetup = [...inheritedSetup, ...scope.setupLines];

    if (scope.isLeaf) {
      // Leaf scope — produce "test" or "test_setup" chunk
      const hasTests = scope.ownItBlocks.length > 0;
      const chunkType = hasTests ? "test" : "test_setup";
      const isRoot = scope === rootScope;

      // Build content: setup + other lines + it blocks
      const setupContent = allSetup.map((s) => s.text).join("\n");
      const otherContent = scope.otherLines.map((s) => s.text).join("\n");
      const itContent = scope.ownItBlocks.map((b) => b.content).join("\n");

      const parts = [setupContent, otherContent, itContent].filter(
        (p) => p.trim().length > 0,
      );
      const fullContent = parts.join("\n");

      if (fullContent.trim().length < 50) return;

      // Check if splitting is needed
      if (
        hasTests &&
        fullContent.length > config.maxChunkSize &&
        scope.ownItBlocks.length > 1
      ) {
        // Split by it blocks, inject setup into each sub-chunk
        const setupPart = [setupContent, otherContent]
          .filter((p) => p.trim().length > 0)
          .join("\n");
        let currentItGroup: ItBlock[] = [];
        let currentSize = setupPart.length;

        for (const itBlock of scope.ownItBlocks) {
          if (
            currentSize + itBlock.content.length > config.maxChunkSize &&
            currentItGroup.length > 0
          ) {
            // Emit sub-chunk
            const subContent = `${setupPart}\n${currentItGroup.map((b) => b.content).join("\n")}`;
            const startRow = Math.min(
              ...currentItGroup.map((b) => b.startRow),
              ...allSetup.map((s) => s.row),
            );
            const endRow = Math.max(...currentItGroup.map((b) => b.endRow));
            results.push({
              content: subContent.trim(),
              startLine: startRow + 1,
              endLine: endRow + 1,
              chunkType,
              symbolId: build2LevelSymbolId(topLevelName, scope, isRoot),
              name: scope.name,
              parentName: topLevelName,
            });
            currentItGroup = [];
            currentSize = setupPart.length;
          }
          currentItGroup.push(itBlock);
          currentSize += itBlock.content.length;
        }

        // Emit remaining
        if (currentItGroup.length > 0) {
          const subContent = `${setupPart}\n${currentItGroup.map((b) => b.content).join("\n")}`;
          const startRow = Math.min(
            ...currentItGroup.map((b) => b.startRow),
            ...allSetup.map((s) => s.row),
          );
          const endRow = Math.max(...currentItGroup.map((b) => b.endRow));
          results.push({
            content: subContent.trim(),
            startLine: startRow + 1,
            endLine: endRow + 1,
            chunkType,
            symbolId: build2LevelSymbolId(topLevelName, scope, isRoot),
            name: scope.name,
            parentName: topLevelName,
          });
        }
      } else {
        // Single chunk
        const startRow = scope.node.startPosition.row;
        const endRow = scope.node.endPosition.row;
        results.push({
          content: fullContent.trim(),
          startLine: startRow + 1,
          endLine: endRow + 1,
          chunkType,
          symbolId: build2LevelSymbolId(topLevelName, scope, isRoot),
          name: scope.name,
          parentName: topLevelName,
        });
      }
      return;
    }

    // Intermediate scope — recurse into children
    for (const child of scope.children) {
      walkScope(child, allSetup);
    }

    // Intermediate scope with own it blocks → body chunk
    if (scope.ownItBlocks.length > 0 || scope.otherLines.length > 0) {
      const setupContent = allSetup.map((s) => s.text).join("\n");
      const itContent = scope.ownItBlocks.map((b) => b.content).join("\n");
      const otherContent = scope.otherLines.map((s) => s.text).join("\n");
      const parts = [setupContent, otherContent, itContent].filter(
        (p) => p.trim().length > 0,
      );
      const bodyContent = parts.join("\n");

      if (bodyContent.trim().length >= 50) {
        const isRoot = scope === rootScope;
        results.push({
          content: bodyContent.trim(),
          startLine: scope.node.startPosition.row + 1,
          endLine: scope.node.endPosition.row + 1,
          chunkType: "test_setup",
          symbolId: build2LevelSymbolId(topLevelName, scope, isRoot),
          name: scope.name,
          parentName: topLevelName,
        });
      }
    }
  }

  walkScope(rootScope, parentSetup);
  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.test.ts`
Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.ts tests/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.test.ts
git commit -m "feat(chunker): add scope-centric chunk production with parent setup injection and oversized splitting"
```

---

### Task 6: Wire rspecScopeChunkerHook.process() and integrate into hook chain

**Files:**

- Modify:
  `src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.ts`
- Modify: `src/core/domains/ingest/pipeline/chunker/hooks/ruby/index.ts`
- Modify:
  `src/core/domains/ingest/pipeline/chunker/hooks/ruby/class-body-chunker.ts`

- [ ] **Step 1: Implement `rspecScopeChunkerHook.process()`**

Replace the placeholder in `rspec-scope-chunker.ts`:

```typescript
export const rspecScopeChunkerHook: ChunkingHook = {
  name: "rspec-scope-chunker",

  process(ctx: HookContext): void {
    if (!isRspecFile(ctx.filePath)) return;

    const tree = buildScopeTree(ctx.containerNode, ctx.code);
    const chunks = produceScopeChunks(tree, ctx.code, ctx.config);

    if (chunks.length > 0) {
      ctx.bodyChunks = chunks;
      ctx.skipChildren = true;
    }
  },
};
```

- [ ] **Step 2: Add hook to chain in `index.ts`**

```typescript
import type { ChunkingHook } from "../types.js";
import { rubyBodyChunkingHook } from "./class-body-chunker.js";
import { rubyCommentCaptureHook } from "./comment-capture.js";
import { rspecFilterHook } from "./rspec-filter.js";
import { rspecScopeChunkerHook } from "./rspec-scope-chunker.js";

export const rubyHooks: ChunkingHook[] = [
  rspecFilterHook, // filterNode: accepts RSpec DSL calls, rejects others
  rubyCommentCaptureHook, // Must run before body chunker (populates excludedRows)
  rspecScopeChunkerHook, // Scope-centric chunking for spec files (sets skipChildren)
  rubyBodyChunkingHook, // Reads excludedRows, classifies body by keyword (skips if bodyChunks set)
];
```

- [ ] **Step 3: Remove `extractRspecBodyChunk` and `isRspecFile` import from
      `class-body-chunker.ts`**

Remove:

- The `extractRspecBodyChunk` function (lines ~591-611)
- The `import { isRspecFile } from "./rspec-filter.js"` (line 14)
- The `if (isRspecFile(ctx.filePath))` branch in
  `rubyBodyChunkingHook.process()` (lines ~618-620)

The guard `if (ctx.bodyChunks.length > 0) return;` (added in Task 3) handles it.

Final `rubyBodyChunkingHook.process()`:

```typescript
export const rubyBodyChunkingHook: ChunkingHook = {
  name: "rubyBodyChunking",
  process(ctx) {
    // Skip if another hook (e.g., rspec-scope-chunker) already produced body chunks
    if (ctx.bodyChunks.length > 0) return;

    ctx.bodyChunks = extractBodyChunks(
      ctx.containerNode,
      ctx.validChildren,
      ctx.code,
      ctx.excludedRows,
      ctx.config,
    );
  },
};
```

- [ ] **Step 4: Run ALL tests**

Run: `npx vitest run` Expected: ALL PASS

- [ ] **Step 5: Run type check**

Run: `npx tsc --noEmit` Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.ts src/core/domains/ingest/pipeline/chunker/hooks/ruby/index.ts src/core/domains/ingest/pipeline/chunker/hooks/ruby/class-body-chunker.ts
git commit -m "feat(chunker): integrate rspec-scope-chunker into Ruby hook chain"
```

---

### Task 7: Integration test — full chunking pipeline with RSpec file

**Files:**

- Create or modify:
  `tests/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.test.ts`

- [ ] **Step 1: Add integration test via TreeSitterChunker**

Add a new `describe("integration")` block that tests the full pipeline:

```typescript
import { TreeSitterChunker } from "../../../../../../../../src/core/domains/ingest/pipeline/chunker/tree-sitter.js";

describe("integration: TreeSitterChunker with RSpec file", () => {
  const chunker = new TreeSitterChunker({
    chunkSize: 4000,
    chunkOverlap: 200,
    maxChunkSize: 5000,
  });

  it("should produce test chunks for a simple spec file", async () => {
    const code = `
describe User do
  let(:user) { create(:user) }

  context 'when admin' do
    let(:role) { :admin }
    before { user.update(role: role) }

    it 'has admin access' do
      expect(user).to be_admin
      expect(user.permissions).to include(:manage)
    end

    it 'can manage users' do
      expect(user).to be_able_to(:manage, User)
    end
  end

  context 'when regular' do
    it 'has limited access' do
      expect(user).not_to be_admin
    end
  end
end`;
    const chunks = await chunker.chunk(
      code,
      "spec/models/user_spec.rb",
      "ruby",
    );

    // Should have 2 test chunks (one per leaf context)
    const testChunks = chunks.filter((c) => c.metadata.chunkType === "test");
    expect(testChunks).toHaveLength(2);

    // 'when admin' leaf should contain injected let(:user) from parent
    const adminChunk = testChunks.find((c) =>
      c.content.includes("admin access"),
    );
    expect(adminChunk).toBeDefined();
    expect(adminChunk!.content).toContain("let(:user)");
    expect(adminChunk!.content).toContain("let(:role)");
    expect(adminChunk!.metadata.chunkType).toBe("test");
    expect(adminChunk!.metadata.symbolId).toBe("User.context 'when admin'");

    // 'when regular' leaf should also have injected let(:user)
    const regularChunk = testChunks.find((c) =>
      c.content.includes("limited access"),
    );
    expect(regularChunk).toBeDefined();
    expect(regularChunk!.content).toContain("let(:user)");
    expect(regularChunk!.metadata.symbolId).toBe("User.context 'when regular'");

    // No mega-chunks
    for (const chunk of chunks) {
      expect(chunk.endLine - chunk.startLine).toBeLessThan(100);
    }
  });

  it("should NOT affect non-spec Ruby files", async () => {
    const code = `
class User < ApplicationRecord
  has_many :posts
  validates :name, presence: true

  def admin?
    role == :admin
  end
end`;
    const chunks = await chunker.chunk(code, "app/models/user.rb", "ruby");

    // Should use normal Ruby chunking (function + block types)
    const testChunks = chunks.filter((c) => c.metadata.chunkType === "test");
    expect(testChunks).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run integration test**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.test.ts -t "integration"`
Expected: ALL PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run` Expected: ALL PASS

- [ ] **Step 4: Commit**

```bash
git add tests/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.test.ts
git commit -m "test(chunker): add integration tests for RSpec scope-centric chunking pipeline"
```

---

### Task 8: Remove `computeLineRanges` from class-body-chunker if unused + cleanup

**Files:**

- Modify:
  `src/core/domains/ingest/pipeline/chunker/hooks/ruby/class-body-chunker.ts`

- [ ] **Step 1: Verify `extractRspecBodyChunk` removal didn't leave dead code**

Check if `computeLineRanges` is still used by `extractBodyChunks` (non-RSpec
path). It IS used by `groupLines` → `flushGroup` → `computeLineRanges`. So keep
it.

Check if `isRspecFile` import is removed (done in Task 6).

- [ ] **Step 2: Run linter**

Run:
`npx eslint src/core/domains/ingest/pipeline/chunker/hooks/ruby/class-body-chunker.ts`
Expected: PASS (no unused imports/variables)

- [ ] **Step 3: Run full test suite one final time**

Run: `npm run build && npx vitest run` Expected: ALL PASS, build succeeds

- [ ] **Step 4: Commit if any cleanup was needed**

```bash
git add -A
git commit -m "chore(chunker): cleanup dead code after rspec-scope-chunker integration"
```
