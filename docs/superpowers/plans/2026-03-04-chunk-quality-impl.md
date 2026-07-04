# Chunk Quality Improvements Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Fix 0-line chunks, split TypeScript classes into methods with
AST-based body grouping, and merge fragmented small declarations.

**Architecture:** Add TypeScript hook chain (comment-capture +
class-body-chunker) mirroring the Ruby hook pattern but using AST node types
instead of keyword classification. Add post-processing step to merge adjacent
small top-level chunks. Fix endLine computation for single-line AST nodes.

**Tech Stack:** tree-sitter, tree-sitter-typescript, vitest

**Design doc:** `docs/plans/2026-03-04-chunk-quality-design.md`

---

### Task 1: Fix 0-Line Chunks

**Files:**

- Modify: `src/core/ingest/pipeline/chunker/tree-sitter.ts:302-303` (and 4 other
  chunk creation sites)
- Test: `tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`

**Step 1: Write failing test**

Add to `describe("chunk - TypeScript")`:

```typescript
it("should produce at least 1 line for single-line type aliases", async () => {
  const code = `
export type IndexingStatus = "not_indexed" | "indexing" | "indexed";

export type EnrichmentStatusValue = "pending" | "in_progress" | "completed" | "partial" | "failed";
  `;

  const chunks = await chunker.chunk(code, "test.ts", "typescript");
  for (const chunk of chunks) {
    expect(chunk.endLine).toBeGreaterThan(chunk.startLine);
  }
});
```

**Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts -t "single-line type aliases"`
Expected: FAIL — `endLine` equals `startLine` for single-line nodes.

**Step 3: Implement fix**

In `src/core/ingest/pipeline/chunker/tree-sitter.ts`, add helper method to
`TreeSitterChunker` class:

```typescript
/**
 * Compute 1-based endLine from a tree-sitter node.
 * tree-sitter endPosition.row is inclusive (same row for single-line nodes),
 * so we ensure endLine > startLine for at least 1 line span.
 */
private computeEndLine(node: Parser.SyntaxNode): number {
  return Math.max(node.startPosition.row + 2, node.endPosition.row + 1);
}
```

Replace all `node.endPosition.row + 1` with `this.computeEndLine(node)` at these
locations:

- Line ~303: main single-node chunk
- Line ~215: child chunk (method extraction)
- Line ~259: no-children fallback

For sub-chunk offset computations (lines ~185-186 and ~284-285), replace
`childNode.endPosition.row + 1` / `node.startPosition.row + 1` with
`this.computeEndLine(childNode)` / `this.computeEndLine(node)` respectively.

**Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts -t "single-line type aliases"`
Expected: PASS

**Step 5: Run full test suite**

Run:
`npx vitest run tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`
Expected: All existing tests PASS (endLine changes are minimal, +1 for
single-line nodes only).

**Step 6: Commit**

```bash
git add src/core/ingest/pipeline/chunker/tree-sitter.ts tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts
git commit -m "fix(chunker): ensure minimum 1-line span for single-line AST nodes"
```

---

### Task 2: TypeScript Comment Capture Hook

**Files:**

- Create: `src/core/ingest/pipeline/chunker/hooks/typescript/comment-capture.ts`
- Test:
  `tests/core/ingest/pipeline/chunker/hooks/typescript/comment-capture.test.ts`

**Context:** In tree-sitter TypeScript AST, comments are `comment` named
children of `class_body`, accessible via `previousNamedSibling` from method
nodes. Unlike Ruby's text-scanning approach, this hook uses AST traversal.

**Step 1: Write failing tests**

Create
`tests/core/ingest/pipeline/chunker/hooks/typescript/comment-capture.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { createHookContext } from "../../../../../../src/core/ingest/pipeline/chunker/hooks/types.js";
import { TreeSitterChunker } from "../../../../../../src/core/ingest/pipeline/chunker/tree-sitter.js";

describe("TypeScript Comment Capture Hook", () => {
  it("should capture single-line comment before method", async () => {
    const code = `
class Service {
  private db: Database;

  // Find user by ID
  findUser(id: string): User {
    return this.db.find(id);
    // internal comment should not be captured
  }
}
`;
    const chunker = new TreeSitterChunker({
      chunkSize: 500,
      chunkOverlap: 50,
      maxChunkSize: 1000,
    });
    const chunks = await chunker.chunk(code, "test.ts", "typescript");
    const methodChunk = chunks.find((c) => c.metadata.name === "findUser");
    expect(methodChunk).toBeDefined();
    expect(methodChunk!.content).toContain("// Find user by ID");
    expect(methodChunk!.startLine).toBeLessThan(6); // comment line, not def line
  });

  it("should capture multi-line JSDoc before method", async () => {
    const code = `
class Service {
  /**
   * Process a payment transaction.
   * @param amount - the payment amount
   * @returns transaction result
   */
  processPayment(amount: number): Result {
    return this.gateway.charge(amount);
    // some internal note
  }
}
`;
    const chunker = new TreeSitterChunker({
      chunkSize: 500,
      chunkOverlap: 50,
      maxChunkSize: 1000,
    });
    const chunks = await chunker.chunk(code, "test.ts", "typescript");
    const methodChunk = chunks.find(
      (c) => c.metadata.name === "processPayment",
    );
    expect(methodChunk).toBeDefined();
    expect(methodChunk!.content).toContain("Process a payment transaction");
    expect(methodChunk!.content).toContain("@param amount");
  });

  it("should capture consecutive comment lines before method", async () => {
    const code = `
class Service {
  // Step 1: validate input
  // Step 2: process data
  // Step 3: return result
  execute(data: Input): Output {
    return this.process(this.validate(data));
    // another internal line for padding
  }
}
`;
    const chunker = new TreeSitterChunker({
      chunkSize: 500,
      chunkOverlap: 50,
      maxChunkSize: 1000,
    });
    const chunks = await chunker.chunk(code, "test.ts", "typescript");
    const methodChunk = chunks.find((c) => c.metadata.name === "execute");
    expect(methodChunk).toBeDefined();
    expect(methodChunk!.content).toContain("Step 1");
    expect(methodChunk!.content).toContain("Step 3");
  });

  it("should not capture comments separated by non-comment lines", async () => {
    const code = `
class Service {
  // This comment is for the property
  private name: string;

  process(): void {
    console.log(this.name);
    // padding to meet 50 char minimum
  }
}
`;
    const chunker = new TreeSitterChunker({
      chunkSize: 500,
      chunkOverlap: 50,
      maxChunkSize: 1000,
    });
    const chunks = await chunker.chunk(code, "test.ts", "typescript");
    const methodChunk = chunks.find((c) => c.metadata.name === "process");
    expect(methodChunk).toBeDefined();
    expect(methodChunk!.content).not.toContain(
      "This comment is for the property",
    );
  });
});
```

**Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/ingest/pipeline/chunker/hooks/typescript/comment-capture.test.ts`
Expected: FAIL — TypeScript config has no hooks yet, comments not captured.

**Step 3: Implement comment capture hook**

Create `src/core/ingest/pipeline/chunker/hooks/typescript/comment-capture.ts`:

```typescript
/**
 * TypeScript Comment Capture Hook — AST-based.
 *
 * Uses tree-sitter AST to find comment nodes preceding methods.
 * Unlike Ruby's text-scanning approach, walks previousNamedSibling
 * from each method_definition in the class_body.
 */

import type Parser from "tree-sitter";

import type { ChunkingHook } from "../types.js";

/**
 * Find the class_body node that contains the given method node.
 * Walks up from the method to find its parent class_body.
 */
function findClassBody(
  containerNode: Parser.SyntaxNode,
): Parser.SyntaxNode | null {
  // containerNode is class_declaration — class_body is a named child
  for (let i = 0; i < containerNode.namedChildCount; i++) {
    const child = containerNode.namedChild(i);
    if (child && child.type === "class_body") {
      return child;
    }
  }
  return null;
}

/**
 * Find the class_body child node that corresponds to a method node by matching position.
 */
function findMethodInClassBody(
  classBody: Parser.SyntaxNode,
  methodNode: Parser.SyntaxNode,
): Parser.SyntaxNode | null {
  for (let i = 0; i < classBody.namedChildCount; i++) {
    const child = classBody.namedChild(i);
    if (
      child &&
      child.type === "method_definition" &&
      child.startPosition.row === methodNode.startPosition.row
    ) {
      return child;
    }
  }
  return null;
}

/**
 * Collect comment nodes preceding a method in the class_body AST.
 * Walks previousNamedSibling while type === "comment".
 * Returns comment nodes in source order (top to bottom).
 */
function collectPrecedingComments(
  methodInBody: Parser.SyntaxNode,
): Parser.SyntaxNode[] {
  const comments: Parser.SyntaxNode[] = [];
  let sibling = methodInBody.previousNamedSibling;

  while (sibling && sibling.type === "comment") {
    comments.unshift(sibling); // prepend to maintain source order
    sibling = sibling.previousNamedSibling;
  }

  return comments;
}

export const typescriptCommentCaptureHook: ChunkingHook = {
  name: "typescriptCommentCapture",
  process(ctx) {
    const classBody = findClassBody(ctx.containerNode);
    if (!classBody) return;

    for (let i = 0; i < ctx.validChildren.length; i++) {
      const methodNode = ctx.validChildren[i];
      const methodInBody = findMethodInClassBody(classBody, methodNode);
      if (!methodInBody) continue;

      const comments = collectPrecedingComments(methodInBody);
      if (comments.length === 0) continue;

      // Mark comment rows as excluded from body chunks
      for (const comment of comments) {
        for (
          let row = comment.startPosition.row;
          row <= comment.endPosition.row;
          row++
        ) {
          ctx.excludedRows.add(row);
        }
      }

      // Build prefix text from comment content
      const prefixText = comments.map((c) => c.text).join("\n");
      ctx.methodPrefixes.set(i, prefixText);
      ctx.methodStartLines.set(i, comments[0].startPosition.row + 1); // 1-based
    }
  },
};
```

**Step 4: Run tests to verify they pass**

Run:
`npx vitest run tests/core/ingest/pipeline/chunker/hooks/typescript/comment-capture.test.ts`
Expected: Still FAIL — hook exists but not wired into config yet. Will pass
after Task 4 (wiring).

**Step 5: Commit**

```bash
git add src/core/ingest/pipeline/chunker/hooks/typescript/comment-capture.ts tests/core/ingest/pipeline/chunker/hooks/typescript/comment-capture.test.ts
git commit -m "feat(chunker): add TypeScript comment capture hook (AST-based)"
```

---

### Task 3: TypeScript Class Body Chunker Hook

**Files:**

- Create:
  `src/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.ts`
- Test:
  `tests/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.test.ts`

**Context:** Unlike Ruby's keyword-based classification, TS uses AST node types
(`public_field_definition`, `class_static_block`, `abstract_method_signature`)
and modifier child nodes (`static`, `abstract`, `readonly`, `decorator`) for
classification.

**Step 1: Write failing tests**

Create
`tests/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { TreeSitterChunker } from "../../../../../../src/core/ingest/pipeline/chunker/tree-sitter.js";

describe("TypeScript Class Body Chunker", () => {
  const chunker = new TreeSitterChunker({
    chunkSize: 500,
    chunkOverlap: 50,
    maxChunkSize: 1000,
  });

  it("should group regular properties into a body chunk", async () => {
    const code = `
class UserService {
  private db: Database;
  private cache: CacheService;
  readonly config: ServiceConfig;
  protected logger: Logger;

  constructor(db: Database, cache: CacheService, config: ServiceConfig, logger: Logger) {
    this.db = db;
    this.cache = cache;
    this.config = config;
    this.logger = logger;
  }

  findUser(id: string): User | null {
    const cached = this.cache.get(id);
    if (cached) return cached;
    return this.db.findById(id);
  }

  deleteUser(id: string): boolean {
    this.cache.invalidate(id);
    return this.db.deleteById(id);
  }
}
`;
    const chunks = await chunker.chunk(code, "test.ts", "typescript");
    const bodyChunks = chunks.filter((c) => c.metadata.chunkType === "block");
    const methodChunks = chunks.filter(
      (c) => c.metadata.chunkType === "function",
    );

    // Methods extracted individually
    expect(methodChunks.some((c) => c.metadata.name === "constructor")).toBe(
      true,
    );
    expect(methodChunks.some((c) => c.metadata.name === "findUser")).toBe(true);
    expect(methodChunks.some((c) => c.metadata.name === "deleteUser")).toBe(
      true,
    );

    // Properties grouped into body chunk(s)
    expect(bodyChunks.length).toBeGreaterThanOrEqual(1);
    const propsChunk = bodyChunks.find((c) => c.content.includes("private db"));
    expect(propsChunk).toBeDefined();
    expect(propsChunk!.content).toContain("private cache");
    expect(propsChunk!.content).toContain("readonly config");
  });

  it("should separate static members from regular properties", async () => {
    const code = `
class Registry {
  private items: Map<string, Item> = new Map();
  private name: string;

  static instance: Registry;
  static readonly VERSION = "1.0";

  constructor(name: string) {
    this.name = name;
    this.items = new Map();
  }

  register(key: string, item: Item): void {
    this.items.set(key, item);
    console.log("Registered:", key);
  }
}
`;
    const chunks = await chunker.chunk(code, "test.ts", "typescript");
    const bodyChunks = chunks.filter((c) => c.metadata.chunkType === "block");

    // Should have separate groups for properties vs static
    const propsChunk = bodyChunks.find((c) =>
      c.content.includes("private items"),
    );
    const staticChunk = bodyChunks.find((c) =>
      c.content.includes("static instance"),
    );

    expect(propsChunk).toBeDefined();
    expect(staticChunk).toBeDefined();

    // Static chunk should not contain regular properties
    expect(staticChunk!.content).not.toContain("private items");
    // Properties chunk should not contain static members
    expect(propsChunk!.content).not.toContain("static instance");
  });

  it("should group decorated members separately", async () => {
    const code = `
class Controller {
  private service: UserService;

  @Inject()
  logger: Logger;

  @Inject()
  metrics: MetricsService;

  constructor(service: UserService) {
    this.service = service;
    console.log("Controller created");
  }

  handleRequest(req: Request): Response {
    this.logger.info("Handling request");
    return this.service.process(req);
  }
}
`;
    const chunks = await chunker.chunk(code, "test.ts", "typescript");
    const bodyChunks = chunks.filter((c) => c.metadata.chunkType === "block");

    const decoratedChunk = bodyChunks.find((c) =>
      c.content.includes("@Inject()"),
    );
    expect(decoratedChunk).toBeDefined();
    expect(decoratedChunk!.content).toContain("logger");
    expect(decoratedChunk!.content).toContain("metrics");
    // Should not include non-decorated property
    expect(decoratedChunk!.content).not.toContain("private service");
  });

  it("should handle abstract members", async () => {
    const code = `
abstract class BaseProcessor {
  protected name: string;
  protected config: ProcessorConfig;

  abstract process(input: ProcessorInput): ProcessorOutput;

  abstract validate(data: ValidationData): boolean;

  constructor(name: string, config: ProcessorConfig) {
    this.name = name;
    this.config = config;
  }

  getName(): string {
    return this.name;
    // padding to make this chunk 50 chars
  }
}
`;
    const chunks = await chunker.chunk(code, "test.ts", "typescript");
    const bodyChunks = chunks.filter((c) => c.metadata.chunkType === "block");

    const abstractChunk = bodyChunks.find((c) =>
      c.content.includes("abstract process"),
    );
    expect(abstractChunk).toBeDefined();
    expect(abstractChunk!.content).toContain("abstract validate");
  });

  it("should prepend class header to body chunks", async () => {
    const code = `
export class DataService extends BaseService {
  private pool: ConnectionPool;
  private timeout: number;
  readonly maxRetries: number;

  connect(): Promise<Connection> {
    return this.pool.acquire(this.timeout);
    // some padding comment here
  }
}
`;
    const chunks = await chunker.chunk(code, "test.ts", "typescript");
    const bodyChunk = chunks.find(
      (c) =>
        c.metadata.chunkType === "block" && c.content.includes("private pool"),
    );
    expect(bodyChunk).toBeDefined();
    expect(bodyChunk!.content).toContain(
      "export class DataService extends BaseService",
    );
  });

  it("should set parentName and parentType on body chunks", async () => {
    const code = `
class MyClass {
  private field1: string;
  private field2: number;
  readonly field3: boolean;

  doWork(): void {
    console.log(this.field1, this.field2, this.field3);
  }
}
`;
    const chunks = await chunker.chunk(code, "test.ts", "typescript");
    const bodyChunk = chunks.find((c) => c.metadata.chunkType === "block");
    expect(bodyChunk).toBeDefined();
    expect(bodyChunk!.metadata.parentName).toBe("MyClass");
    expect(bodyChunk!.metadata.parentType).toBe("class_declaration");
  });
});
```

**Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.test.ts`
Expected: FAIL — no TS hooks wired, classes not split.

**Step 3: Implement class body chunker**

Create
`src/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.ts`:

```typescript
/**
 * TypeScriptClassBodyChunker — Groups TypeScript class body declarations by AST type.
 *
 * When a class body is extracted (everything outside methods), this module
 * classifies each remaining AST node into a group (properties, static_members,
 * decorated_members, abstract_members, other) and produces separate body chunks per group.
 *
 * Uses tree-sitter AST node types and modifiers — more robust than keyword matching.
 */

import type Parser from "tree-sitter";

import type { BodyChunkResult, ChunkingHook } from "../types.js";

// ── Body element classification ────────────────────────────────────

type BodyGroup =
  | "properties"
  | "static_members"
  | "decorated_members"
  | "abstract_members"
  | "other";

interface ClassifiedNode {
  node: Parser.SyntaxNode;
  group: BodyGroup;
}

/**
 * Check if an AST node has a specific modifier as direct child.
 */
function hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === modifier) return true;
  }
  return false;
}

/**
 * Check if an AST node has a decorator child.
 */
function hasDecorator(node: Parser.SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && child.type === "decorator") return true;
  }
  return false;
}

/**
 * Classify a class_body child node into a body group.
 */
function classifyNode(node: Parser.SyntaxNode): BodyGroup {
  switch (node.type) {
    case "public_field_definition": {
      if (hasDecorator(node)) return "decorated_members";
      if (hasModifier(node, "abstract")) return "abstract_members";
      if (hasModifier(node, "static")) return "static_members";
      return "properties";
    }
    case "class_static_block":
      return "static_members";
    case "abstract_method_signature":
      return "abstract_members";
    default:
      return "other";
  }
}

// ── Body chunk extraction ──────────────────────────────────────────

interface BodyNodeGroup {
  group: BodyGroup;
  nodes: Parser.SyntaxNode[];
}

/**
 * Group adjacent same-type body nodes.
 */
function groupAdjacentNodes(classified: ClassifiedNode[]): BodyNodeGroup[] {
  if (classified.length === 0) return [];

  const groups: BodyNodeGroup[] = [];
  let current: BodyNodeGroup = {
    group: classified[0].group,
    nodes: [classified[0].node],
  };

  for (let i = 1; i < classified.length; i++) {
    if (classified[i].group === current.group) {
      current.nodes.push(classified[i].node);
    } else {
      groups.push(current);
      current = { group: classified[i].group, nodes: [classified[i].node] };
    }
  }
  groups.push(current);

  return groups;
}

/**
 * Extract class header line for context injection.
 * Returns "export class Foo extends Bar" or "class Baz implements Qux".
 */
function extractClassHeader(
  containerNode: Parser.SyntaxNode,
  code: string,
): string | undefined {
  const lines = code.split("\n");
  const firstLine = lines[containerNode.startPosition.row];
  if (firstLine && /^\s*(export\s+)?(abstract\s+)?class\s+/.test(firstLine)) {
    return firstLine.trim();
  }
  return undefined;
}

/**
 * Extract body chunks from a TypeScript class with AST-based grouping.
 */
export function extractBodyChunks(
  containerNode: Parser.SyntaxNode,
  childNodes: Parser.SyntaxNode[],
  code: string,
  excludedRows: Set<number>,
  config: { maxChunkSize: number },
): BodyChunkResult[] {
  // Find class_body
  let classBody: Parser.SyntaxNode | null = null;
  for (let i = 0; i < containerNode.namedChildCount; i++) {
    const child = containerNode.namedChild(i);
    if (child && child.type === "class_body") {
      classBody = child;
      break;
    }
  }
  if (!classBody) return [];

  // Build sets of rows occupied by methods and excluded rows (comments captured by comment hook)
  const methodRows = new Set<number>();
  for (const child of childNodes) {
    for (
      let row = child.startPosition.row;
      row <= child.endPosition.row;
      row++
    ) {
      methodRows.add(row);
    }
  }

  // Classify non-method, non-comment body children
  const classified: ClassifiedNode[] = [];
  for (let i = 0; i < classBody.namedChildCount; i++) {
    const child = classBody.namedChild(i);
    if (!child) continue;
    // Skip methods (already extracted) and comments (handled by comment hook)
    if (child.type === "method_definition" || child.type === "comment")
      continue;
    // Skip nodes in excluded rows
    if (excludedRows.has(child.startPosition.row)) continue;
    classified.push({ node: child, group: classifyNode(child) });
  }

  // Group adjacent same-type nodes
  const nodeGroups = groupAdjacentNodes(classified);
  const classHeader = extractClassHeader(containerNode, code);
  const lines = code.split("\n");

  const results: BodyChunkResult[] = [];

  for (const nodeGroup of nodeGroups) {
    // Extract content from all nodes in the group
    const groupLines: string[] = [];
    const lineRanges: { start: number; end: number }[] = [];

    for (const node of nodeGroup.nodes) {
      const startRow = node.startPosition.row;
      const endRow = node.endPosition.row;

      // Include any preceding comment that wasn't excluded (property comments)
      const prev = node.previousNamedSibling;
      let commentStartRow = startRow;
      if (
        prev &&
        prev.type === "comment" &&
        !excludedRows.has(prev.startPosition.row)
      ) {
        commentStartRow = prev.startPosition.row;
      }

      for (let row = commentStartRow; row <= endRow; row++) {
        if (lines[row] !== undefined) {
          groupLines.push(lines[row]);
        }
      }

      lineRanges.push({ start: commentStartRow + 1, end: endRow + 1 }); // 1-based
    }

    const groupContent = groupLines.join("\n").trim();
    const contentWithContext = classHeader
      ? `${classHeader}\n${groupContent}`
      : groupContent;

    // Skip tiny groups
    if (contentWithContext.length < 50) continue;

    // Split oversized groups
    if (contentWithContext.length > config.maxChunkSize) {
      const subResults = splitOversizedContent(
        groupLines,
        lineRanges,
        classHeader,
        config.maxChunkSize,
      );
      results.push(...subResults);
      continue;
    }

    const minLine = Math.min(...lineRanges.map((r) => r.start));
    const maxLine = Math.max(...lineRanges.map((r) => r.end));

    results.push({
      content: contentWithContext,
      startLine: minLine,
      endLine: maxLine,
      lineRanges,
    });
  }

  return results;
}

/**
 * Split oversized body content into smaller chunks at node boundaries.
 */
function splitOversizedContent(
  groupLines: string[],
  lineRanges: { start: number; end: number }[],
  classHeader: string | undefined,
  maxChunkSize: number,
): BodyChunkResult[] {
  const results: BodyChunkResult[] = [];
  let currentLines: string[] = [];
  let currentRanges: { start: number; end: number }[] = [];
  let currentSize = classHeader ? classHeader.length + 1 : 0;

  // Split by lineRange boundaries
  let lineOffset = 0;
  for (const range of lineRanges) {
    const rangeLineCount = range.end - range.start + 1;
    const rangeLines = groupLines.slice(
      lineOffset,
      lineOffset + rangeLineCount,
    );
    const rangeSize = rangeLines.join("\n").length + 1;

    if (currentSize + rangeSize > maxChunkSize && currentLines.length > 0) {
      const content = currentLines.join("\n").trim();
      const withHeader = classHeader ? `${classHeader}\n${content}` : content;
      if (withHeader.length >= 50) {
        results.push({
          content: withHeader,
          startLine: Math.min(...currentRanges.map((r) => r.start)),
          endLine: Math.max(...currentRanges.map((r) => r.end)),
          lineRanges: [...currentRanges],
        });
      }
      currentLines = [];
      currentRanges = [];
      currentSize = classHeader ? classHeader.length + 1 : 0;
    }

    currentLines.push(...rangeLines);
    currentRanges.push(range);
    currentSize += rangeSize;
    lineOffset += rangeLineCount;
  }

  // Flush remaining
  if (currentLines.length > 0) {
    const content = currentLines.join("\n").trim();
    const withHeader = classHeader ? `${classHeader}\n${content}` : content;
    if (withHeader.length >= 50) {
      results.push({
        content: withHeader,
        startLine: Math.min(...currentRanges.map((r) => r.start)),
        endLine: Math.max(...currentRanges.map((r) => r.end)),
        lineRanges: [...currentRanges],
      });
    }
  }

  return results;
}

// ── ChunkingHook export ────────────────────────────────────────────

export const typescriptBodyChunkingHook: ChunkingHook = {
  name: "typescriptBodyChunking",
  process(ctx) {
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

**Step 4: Run tests (still failing — hook not wired yet)**

Run:
`npx vitest run tests/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.test.ts`
Expected: FAIL — hooks not in config yet.

**Step 5: Commit**

```bash
git add src/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.ts tests/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.test.ts
git commit -m "feat(chunker): add TypeScript class body chunker hook (AST-based)"
```

---

### Task 4: Wire TypeScript Hooks into Config

**Files:**

- Create: `src/core/ingest/pipeline/chunker/hooks/typescript/index.ts`
- Modify: `src/core/ingest/pipeline/chunker/config.ts`

**Step 1: Create hooks barrel**

Create `src/core/ingest/pipeline/chunker/hooks/typescript/index.ts`:

```typescript
import type { ChunkingHook } from "../types.js";
import { typescriptBodyChunkingHook } from "./class-body-chunker.js";
import { typescriptCommentCaptureHook } from "./comment-capture.js";

export const typescriptHooks: ChunkingHook[] = [
  typescriptCommentCaptureHook, // Must run first (populates excludedRows)
  typescriptBodyChunkingHook, // Reads excludedRows
];
```

**Step 2: Update TypeScript config**

In `src/core/ingest/pipeline/chunker/config.ts`, add import and update
definition:

Add import at top:

```typescript
import { typescriptHooks } from "./hooks/typescript/index.js";
```

Update `typescript` entry:

```typescript
typescript: {
  loadModule: async () => import("tree-sitter-typescript") as Promise<TreeSitterLanguageModule>,
  extractLanguage: (mod: TreeSitterLanguageModule) => {
    if (typeof mod.default === "object" && mod.default !== null && "typescript" in mod.default) {
      return (mod.default as Record<string, unknown>).typescript;
    }
    return mod.typescript;
  },
  chunkableTypes: [
    "function_declaration",
    "method_definition",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
  ],
  childChunkTypes: ["method_definition"],
  alwaysExtractChildren: true,
  hooks: typescriptHooks,
},
```

**Step 3: Run all TS hook tests**

Run: `npx vitest run tests/core/ingest/pipeline/chunker/hooks/typescript/`
Expected: ALL PASS — hooks now wired and active.

**Step 4: Run full chunker test suite**

Run:
`npx vitest run tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`
Expected: Some existing TS tests may need updates — the old test "should chunk
TypeScript classes" expected `chunkType === "class"` for the whole class, now
classes are split into methods. Fix assertions:

The test at ~line 38 that asserts
`chunks.some((c) => c.metadata.chunkType === "class")` will fail because classes
are now split. Update to check for extracted methods instead.

**Step 5: Fix broken existing tests**

The existing test "should chunk TypeScript classes" needs updating — it now
produces method chunks instead of a single class chunk:

```typescript
it("should chunk TypeScript classes into methods", async () => {
  const code = `
class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }

  subtract(a: number, b: number): number {
    return a - b;
  }
}
  `;

  const chunks = await chunker.chunk(code, "test.ts", "typescript");
  expect(chunks.length).toBeGreaterThan(0);
  // Methods should be extracted with class as parent
  const methodChunks = chunks.filter(
    (c) => c.metadata.chunkType === "function",
  );
  expect(methodChunks.some((c) => c.metadata.name === "add")).toBe(true);
  expect(methodChunks.some((c) => c.metadata.name === "subtract")).toBe(true);
  expect(
    methodChunks.every((c) => c.metadata.parentName === "Calculator"),
  ).toBe(true);
});
```

**Step 6: Run full test suite again**

Run: `npx vitest run tests/core/ingest/pipeline/chunker/` Expected: ALL PASS

**Step 7: Commit**

```bash
git add src/core/ingest/pipeline/chunker/hooks/typescript/ src/core/ingest/pipeline/chunker/config.ts tests/
git commit -m "feat(chunker): wire TypeScript hooks and enable class method extraction"
```

---

### Task 5: Top-Level Small Chunk Merging

**Files:**

- Modify: `src/core/ingest/pipeline/chunker/tree-sitter.ts`
- Test: `tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`

**Step 1: Write failing test**

Add to `describe("chunk - TypeScript")`:

```typescript
it("should merge adjacent small type aliases and interfaces into a block", async () => {
  const code = `
export type IndexingStatus = "not_indexed" | "indexing" | "indexed";

export type EnrichmentStatusValue = "pending" | "in_progress" | "completed" | "partial" | "failed";

export type ProgressCallback = (progress: ProgressUpdate) => void;

export interface WorkItem { path: string; content: string; language: string; }

export interface DeleteItem { id: string; hash: string; }

export interface LargeInterface {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  isActive: boolean;
  metadata: Record<string, unknown>;
}
  `;

  const chunks = await chunker.chunk(code, "test.ts", "typescript");

  // The 5 small declarations (type aliases + small interfaces) should be merged
  // LargeInterface (8+ lines) should remain separate
  const blockChunks = chunks.filter(
    (c) => c.metadata.chunkType === "block" && !c.metadata.parentName,
  );
  const interfaceChunks = chunks.filter(
    (c) => c.metadata.chunkType === "interface",
  );

  // Small declarations merged into 1 block
  expect(blockChunks.length).toBe(1);
  expect(blockChunks[0].content).toContain("IndexingStatus");
  expect(blockChunks[0].content).toContain("DeleteItem");

  // Large interface stays separate
  expect(
    interfaceChunks.some((c) => c.metadata.name === "LargeInterface"),
  ).toBe(true);
});

it("should not merge small chunks separated by large declarations", async () => {
  const code = `
export type SmallTypeA = "a" | "b" | "c" | "d" | "e" | "f" | "g" | "h";

export interface LargeInterface {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  isActive: boolean;
  metadata: Record<string, unknown>;
}

export type SmallTypeB = "x" | "y" | "z" | "w" | "v" | "u" | "t" | "s";
  `;

  const chunks = await chunker.chunk(code, "test.ts", "typescript");

  // SmallTypeA and SmallTypeB should NOT be merged (LargeInterface between them)
  // Each small type stays individual (no merge partner)
  const blockChunks = chunks.filter(
    (c) => c.metadata.chunkType === "block" && !c.metadata.parentName,
  );
  expect(blockChunks.length).toBe(0); // No merged blocks, each type stays as-is
});
```

**Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts -t "merge adjacent"`
Expected: FAIL — no merging logic exists.

**Step 3: Implement mergeSmallChunks**

Add private method to `TreeSitterChunker` class in `tree-sitter.ts`:

```typescript
/** Maximum lines for a chunk to be considered a merge candidate */
private static readonly MERGE_THRESHOLD = 5;
/** Maximum gap (in source lines) between mergeable chunks */
private static readonly MERGE_GAP = 2;
/** Chunk types eligible for merging */
private static readonly MERGEABLE_TYPES = new Set(["block", "interface"]);

/**
 * Merge adjacent small top-level chunks into combined block chunks.
 * Language-agnostic post-processing step.
 */
private mergeSmallChunks(chunks: CodeChunk[]): CodeChunk[] {
  if (chunks.length < 2) return chunks;

  const result: CodeChunk[] = [];
  let mergeGroup: CodeChunk[] = [];

  const isMergeable = (chunk: CodeChunk): boolean => {
    const lines = chunk.endLine - chunk.startLine;
    return (
      lines <= TreeSitterChunker.MERGE_THRESHOLD &&
      !chunk.metadata.parentName &&
      TreeSitterChunker.MERGEABLE_TYPES.has(chunk.metadata.chunkType ?? "")
    );
  };

  const flushGroup = (): void => {
    if (mergeGroup.length >= 2) {
      // Merge into single block chunk
      const content = mergeGroup.map((c) => c.content).join("\n\n");
      if (content.length <= this.config.maxChunkSize) {
        result.push({
          content,
          startLine: mergeGroup[0].startLine,
          endLine: mergeGroup[mergeGroup.length - 1].endLine,
          metadata: {
            filePath: mergeGroup[0].metadata.filePath,
            language: mergeGroup[0].metadata.language,
            chunkIndex: mergeGroup[0].metadata.chunkIndex,
            chunkType: "block",
            name: `${mergeGroup[0].metadata.name ?? "declarations"}...`,
          },
        });
        mergeGroup = [];
        return;
      }
    }
    // Single or oversized — emit individually
    result.push(...mergeGroup);
    mergeGroup = [];
  };

  for (const chunk of chunks) {
    if (isMergeable(chunk)) {
      if (mergeGroup.length > 0) {
        const lastEnd = mergeGroup[mergeGroup.length - 1].endLine;
        const gap = chunk.startLine - lastEnd;
        if (gap > TreeSitterChunker.MERGE_GAP) {
          flushGroup();
        }
      }
      mergeGroup.push(chunk);
    } else {
      flushGroup();
      result.push(chunk);
    }
  }
  flushGroup();

  // Re-index chunkIndex
  for (let i = 0; i < result.length; i++) {
    result[i].metadata.chunkIndex = i;
  }

  return result;
}
```

Call it before returning chunks in the `chunk()` method (line ~320):

```typescript
// Before: return chunks;
// After:
return this.mergeSmallChunks(chunks);
```

**Step 4: Run tests**

Run:
`npx vitest run tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts -t "merge adjacent"`
Expected: PASS

**Step 5: Run full test suite**

Run: `npx vitest run tests/core/ingest/pipeline/chunker/` Expected: ALL PASS —
existing tests unaffected (they use chunks > 5 lines or have parentName).

**Step 6: Commit**

```bash
git add src/core/ingest/pipeline/chunker/tree-sitter.ts tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts
git commit -m "feat(chunker): merge adjacent small top-level declarations into blocks"
```

---

### Task 6: isDocumentation Verification

**Files:** None (verification only)

**Step 1: Re-index project**

```bash
# After all code changes are committed, re-index
```

Use tea-rags MCP `index_codebase` with `forceReindex: true` on project path.

**Step 2: Query for documentation chunks**

Use tea-rags MCP `semantic_search`:

```json
{
  "collection": "<collection_name>",
  "query": "contributing guide development setup",
  "filter": {
    "must": [{ "key": "isDocumentation", "match": { "value": true } }]
  },
  "limit": 5
}
```

**Step 3: Evaluate result**

- If .md chunks returned with `isDocumentation: true` → **not a bug**, close.
- If empty → investigate `chunk-pipeline.ts:338-339` spread condition and fix.

**Step 4: Commit (only if fix needed)**

```bash
git commit -m "fix(chunker): ensure isDocumentation flag reaches Qdrant payload"
```

---

### Task 7: Final Validation

**Step 1: Run full test suite**

Run: `npx vitest run` Expected: ALL PASS

**Step 2: Type check**

Run: `npx tsc --noEmit` Expected: No errors

**Step 3: Re-index and compare chunk quality**

Re-index project and run same chunk quality analysis as before:

- Count monster chunks (>300 lines) — should be 0 for TypeScript
- Count tiny chunks (0-3 lines) — should be significantly reduced
- Count 0-line chunks — should be 0
- Check class method extraction — QdrantManager, TreeSitterChunker etc. should
  be split

**Step 4: Final commit if any fixes needed**

```bash
git commit -m "fix(chunker): address chunk quality issues from validation"
```
