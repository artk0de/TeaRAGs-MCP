# Chunk Grouping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Unified chunk grouping via ChunkGrouper, file-level find_symbol via
relativePath parameter, parentName → parentSymbolId migration, and #/. symbolId
separator for instance/static methods.

**Architecture:** ChunkGrouper replaces scattered outlineClass/outlineDoc logic
in symbol-resolve.ts with two concrete implementations (CodeChunkGrouper,
DocChunkGrouper). find_symbol gains a `relativePath` parameter
(mutually-exclusive with `symbol`) for file-level lookup. parentName field is
renamed to parentSymbolId across the entire codebase (migration v11 handles
Qdrant). buildSymbolId() switches from `.` to `#` for instance methods.

**Tech Stack:** TypeScript, Vitest, Qdrant (set_payload/delete_payload),
tree-sitter AST

**Spec:** `docs/superpowers/specs/2026-04-02-file-level-find-symbol-design.md`

---

### Task 1: Rename parentName → parentSymbolId (code-only)

Pure field rename across the codebase. No behavioral changes. All references to
`parentName` become `parentSymbolId`. Tests updated to match.

**Files:**

- Modify: `src/core/types.ts:188` — `parentName` → `parentSymbolId`
- Modify: `src/core/domains/trajectory/static/provider.ts:26` — payload key
- Modify: `src/core/domains/trajectory/static/payload-signals.ts:13` — signal
  descriptor key + description
- Modify: `src/core/domains/ingest/pipeline/file-processor.ts:46` — doc chunk
  assignment
- Modify: `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts` — all
  `parentName` metadata assignments (~8 sites)
- Modify: `src/core/domains/ingest/pipeline/chunker/hooks/types.ts:15` —
  BodyChunkResult field
- Modify:
  `src/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.ts` —
  parentName in hook results
- Modify: `src/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.ts` —
  if references parentName
- Modify: `src/core/domains/explore/symbol-resolve.ts` — all `parentName` reads
  from payload
- Modify: `src/core/api/internal/facades/explore-facade.ts:329-331` — parent
  filter scroll key
- Modify:
  `src/core/domains/trajectory/static/rerank/presets/decomposition.ts:28` —
  `groupBy: "parentSymbolId"`
- Modify: `src/core/domains/trajectory/git/rerank/presets/refactoring.ts:30` —
  `groupBy: "parentSymbolId"`
- Modify: `src/mcp/resources/registry.ts` — field description
- Modify: `src/core/domains/ingest/pipeline/types.ts` — if has parentName ref
- Modify: All test files referencing `parentName` in payloads (~8 test files)

- [ ] **Step 1: Update types.ts**

In `src/core/types.ts:188`, rename:

```typescript
// Before
parentName?: string;
// After
parentSymbolId?: string;
```

- [ ] **Step 2: Update ingest pipeline — tree-sitter.ts**

In `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts`, rename ALL
`parentName` metadata assignments to `parentSymbolId`. The field is set in ~8
locations where chunks are created. Also rename the `buildSymbolId` second param
doc from "parentName" (this is just the local variable; the FIELD on metadata is
what matters).

Key sites:

- Line 236: `parentName: result.parentName ?? parentName` →
  `parentSymbolId: result.parentSymbolId ?? parentName`
- Line 258: `parentName,` → `parentSymbolId: parentName,`
- Line 286 (fallback sub-chunks): `parentName,` → `parentSymbolId: parentName,`
- Line 495 (oversized child fallback): same
- Line 531 (nested container path): same
- Line 561 (nested body): same
- Line 601 (leaf child): `parentName,` → `parentSymbolId: parentName,`

Note: The LOCAL variable `parentName` (extracted from AST) keeps its name — it's
not a metadata field name, it's the VALUE being assigned. Only the metadata
FIELD key changes.

- [ ] **Step 3: Update hook types + implementations**

In `src/core/domains/ingest/pipeline/chunker/hooks/types.ts:15`:

```typescript
// Before
parentName?: string;
// After
parentSymbolId?: string;
```

Update `rspec-scope-chunker.ts` and `markdown/chunker.ts` — any place they set
`parentName` on BodyChunkResult.

- [ ] **Step 4: Update file-processor.ts**

In `src/core/domains/ingest/pipeline/file-processor.ts:46`:

```typescript
// Before
chunk.metadata.parentName = relPath;
// After
chunk.metadata.parentSymbolId = relPath;
```

- [ ] **Step 5: Update static provider + payload-signals**

In `src/core/domains/trajectory/static/provider.ts:26`:

```typescript
// Before
if (m.parentName) payload.parentName = m.parentName;
// After
if (m.parentSymbolId) payload.parentSymbolId = m.parentSymbolId;
```

In `payload-signals.ts:13`:

```typescript
// Before
{ key: "parentName", type: "string", description: "Parent symbol name" },
// After
{ key: "parentSymbolId", type: "string", description: "Parent symbol identifier (class name for code, doc:<hash> for docs)" },
```

- [ ] **Step 6: Update symbol-resolve.ts**

Replace all `payload.parentName` reads with `payload.parentSymbolId`:

- Line 47: `c.payload.parentName === classChunk.payload.name` →
  `c.payload.parentSymbolId === classChunk.payload.name`
- Line 61: `c.payload.parentName` → `c.payload.parentSymbolId`
- Line 62: key construction uses `parentName` → `parentSymbolId`
- Line 72: query match against `parentName` → `parentSymbolId`
- Line 179: `parentName: first.payload.parentName` →
  `parentSymbolId: first.payload.parentSymbolId`

- [ ] **Step 7: Update explore-facade.ts**

In `explore-facade.ts:329-331`, the parent scroll filter key:

```typescript
// Before
{ key: "parentName", match: { text: request.symbol } },
// After
{ key: "parentSymbolId", match: { text: request.symbol } },
```

- [ ] **Step 8: Update presets groupBy**

In `decomposition.ts:28`:

```typescript
readonly groupBy = "parentSymbolId";
```

In `refactoring.ts:30`:

```typescript
readonly groupBy = "parentSymbolId";
```

- [ ] **Step 9: Update registry.ts**

In `src/mcp/resources/registry.ts`, update the `parentName` description to
`parentSymbolId`:

```
"parentSymbolId (class name for code methods, doc:<hash> for doc chunks)"
```

- [ ] **Step 10: Update ALL test files**

Every test file that creates mock payloads with `parentName` must switch to
`parentSymbolId`. Files to update (grep for `parentName` in tests/):

- `tests/core/domains/explore/symbol-resolve.test.ts`
- `tests/core/api/internal/facades/explore-facade-find-symbol.test.ts`
- `tests/core/domains/ingest/pipeline/file-processor-navigation.test.ts`
- `tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`
- `tests/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts`
- `tests/core/domains/ingest/pipeline/chunker/hooks/ruby/rspec-scope-chunker.test.ts`
- `tests/core/domains/ingest/pipeline/chunk-pipeline.test.ts`

- [ ] **Step 11: Run tests**

```bash
npx vitest run
```

Expected: ALL tests pass (pure rename, no behavioral change).

- [ ] **Step 12: Commit**

```bash
git add -A
git commit -m "refactor(api): rename parentName → parentSymbolId across codebase

Pure field rename. No behavioral changes. Migration v11 (next task) handles
existing Qdrant data."
```

---

### Task 2: Schema V11 Migration — parentName → parentSymbolId in Qdrant

In-place `set_payload` rename on all existing points. Create text index on
`parentSymbolId`, remove old `parentName` index.

**Files:**

- Modify: `src/core/infra/migration/types.ts` — extend IndexStore with
  `setPayloadBatch` + `deletePayloadKey`
- Create:
  `src/core/infra/migration/schema_migrations/schema-v11-rename-parent-symbol-id.ts`
- Modify: `src/core/infra/migration/schema_migrations/index.ts` — export
- Modify: `src/core/infra/migration/schema-migrator.ts` — register
- Create:
  `tests/core/infra/migration/schema-v11-rename-parent-symbol-id.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, expect, it, vi } from "vitest";

import { SchemaV11RenameParentSymbolId } from "../../../../src/core/infra/migration/schema_migrations/schema-v11-rename-parent-symbol-id.js";

describe("SchemaV11RenameParentSymbolId", () => {
  function createMockStore() {
    return {
      getSchemaVersion: vi.fn(),
      ensureIndex: vi.fn().mockResolvedValue(true),
      storeSchemaVersion: vi.fn(),
      hasPayloadIndex: vi.fn().mockResolvedValue(true),
      getCollectionInfo: vi.fn(),
      updateSparseConfig: vi.fn(),
      deletePointsByFilter: vi.fn(),
      scrollAllPayload: vi.fn().mockResolvedValue([
        {
          id: "1",
          payload: { parentName: "MyClass", symbolId: "MyClass.method" },
        },
        {
          id: "2",
          payload: {
            parentName: "docs/api.md",
            isDocumentation: true,
            symbolId: "doc:abc123",
          },
        },
        { id: "3", payload: { symbolId: "topLevel" } }, // no parentName
      ]),
      batchSetPayload: vi.fn().mockResolvedValue(undefined),
      deletePayloadKey: vi.fn().mockResolvedValue(undefined),
    };
  }

  it("renames parentName → parentSymbolId and creates text index", async () => {
    const store = createMockStore();
    const migration = new SchemaV11RenameParentSymbolId(
      "test_collection",
      store,
    );

    expect(migration.version).toBe(11);

    const result = await migration.apply();

    // Should scroll all points
    expect(store.scrollAllPayload).toHaveBeenCalledWith("test_collection");

    // Should batch set parentSymbolId only for points that HAD parentName
    expect(store.batchSetPayload).toHaveBeenCalledWith(
      "test_collection",
      expect.arrayContaining([
        { points: ["1"], payload: { parentSymbolId: "MyClass" } },
        { points: ["2"], payload: { parentSymbolId: "docs/api.md" } },
      ]),
    );
    // Point "3" has no parentName — should NOT be included
    const batchArgs = store.batchSetPayload.mock.calls[0][1];
    expect(batchArgs).toHaveLength(2);

    // Should delete old parentName field
    expect(store.deletePayloadKey).toHaveBeenCalledWith(
      "test_collection",
      "parentName",
    );

    // Should create text index on parentSymbolId
    expect(store.ensureIndex).toHaveBeenCalledWith(
      "test_collection",
      "parentSymbolId",
      "text",
    );

    expect(result.applied).toContain(
      "renamed parentName → parentSymbolId on 2 points",
    );
  });

  it("skips gracefully when no points have parentName", async () => {
    const store = createMockStore();
    store.scrollAllPayload.mockResolvedValue([
      { id: "1", payload: { symbolId: "topLevel" } },
    ]);

    const migration = new SchemaV11RenameParentSymbolId(
      "test_collection",
      store,
    );
    const result = await migration.apply();

    expect(store.batchSetPayload).not.toHaveBeenCalled();
    expect(store.deletePayloadKey).toHaveBeenCalledWith(
      "test_collection",
      "parentName",
    );
    expect(result.applied).toContain("no points with parentName — skip rename");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/core/infra/migration/schema-v11-rename-parent-symbol-id.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Extend IndexStore interface**

In `src/core/infra/migration/types.ts`, add to `IndexStore`:

```typescript
/** Scroll all points returning id + payload (for field rename migrations). */
scrollAllPayload?: (collection: string) =>
  Promise<{ id: string | number; payload: Record<string, unknown> }[]>;
/** Batch set payload fields on specific points. */
batchSetPayload?: (
  collection: string,
  operations: { payload: Record<string, unknown>; points: (string | number)[] }[],
) => Promise<void>;
/** Delete a payload key from all points in collection. */
deletePayloadKey?: (collection: string, key: string) => Promise<void>;
```

Mark as optional (`?`) to avoid breaking existing migrations that don't need
them. V11 asserts presence at construction time.

- [ ] **Step 4: Implement migration**

Create
`src/core/infra/migration/schema_migrations/schema-v11-rename-parent-symbol-id.ts`:

```typescript
import type { IndexStore, Migration, StepResult } from "../types.js";

export class SchemaV11RenameParentSymbolId implements Migration {
  readonly name = "schema-v11-rename-parent-symbol-id";
  readonly version = 11;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore &
      Required<
        Pick<
          IndexStore,
          "scrollAllPayload" | "batchSetPayload" | "deletePayloadKey"
        >
      >,
  ) {}

  async apply(): Promise<StepResult> {
    const applied: string[] = [];

    // 1. Scroll all points with payload
    const points = await this.store.scrollAllPayload(this.collection);

    // 2. Batch set parentSymbolId for points that have parentName
    const ops = points
      .filter((p) => typeof p.payload.parentName === "string")
      .map((p) => ({
        points: [p.id],
        payload: { parentSymbolId: p.payload.parentName as string },
      }));

    if (ops.length > 0) {
      await this.store.batchSetPayload(this.collection, ops);
      applied.push(
        `renamed parentName → parentSymbolId on ${ops.length} points`,
      );
    } else {
      applied.push("no points with parentName — skip rename");
    }

    // 3. Delete old parentName field from all points
    await this.store.deletePayloadKey(this.collection, "parentName");
    applied.push("deleted parentName field");

    // 4. Create text index on parentSymbolId
    await this.store.ensureIndex(this.collection, "parentSymbolId", "text");
    applied.push("created text index on parentSymbolId");

    return { applied };
  }
}
```

- [ ] **Step 5: Export from barrel + register in migrator**

In `schema_migrations/index.ts`, add:

```typescript
export { SchemaV11RenameParentSymbolId } from "./schema-v11-rename-parent-symbol-id.js";
```

In `schema-migrator.ts`, add after SchemaV10:

```typescript
new SchemaV11RenameParentSymbolId(collection, indexStore),
```

The `indexStore` adapter in `src/core/domains/ingest/factory.ts` must implement
the three new optional methods. Verify the adapter has access to
`QdrantManager.scrollFiltered`, `QdrantManager.setPayload`, and a new
`QdrantManager.deletePayloadKey` method (or direct REST call).

- [ ] **Step 6: Implement IndexStore adapter methods**

Check `src/core/domains/ingest/factory.ts` or wherever IndexStoreAdapter is
defined. Add implementations for `scrollAllPayload`, `batchSetPayload`,
`deletePayloadKey` using QdrantManager.

- [ ] **Step 7: Run tests**

```bash
npx vitest run tests/core/infra/migration/schema-v11-rename-parent-symbol-id.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run full test suite**

```bash
npx vitest run
```

Expected: ALL pass.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(drift): add schema-v11 migration for parentName → parentSymbolId rename

In-place set_payload rename + text index creation. Extends IndexStore
with scrollAllPayload/batchSetPayload/deletePayloadKey."
```

---

### Task 3: Instance/static symbolId separator (#/.)

Change `buildSymbolId()` to use `#` for instance methods and `.` for static.
Default: `#` (instance). Each language hook can signal `isStatic` via a new
optional field on BodyChunkResult.

**Files:**

- Modify: `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts:39-42` —
  `buildSymbolId()` logic
- Modify: `src/core/domains/ingest/pipeline/chunker/hooks/types.ts` — add
  `isStatic?: boolean` to BodyChunkResult
- Modify: `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts` — pass
  `isStatic` from child node detection at leaf child sites
- Test: `tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tree-sitter-chunker.test.ts`:

```typescript
describe("symbolId separator (#/. for instance/static)", () => {
  it("uses # separator for instance methods (default)", () => {
    // TypeScript class with a regular method
    const code = `class Foo {\n  bar() { return 1; }\n}`;
    // After chunking, child "bar" with parent "Foo" → "Foo#bar"
    // ... (test the buildSymbolId output via chunk metadata)
  });

  it("uses . separator for static methods", () => {
    // TypeScript class with static method
    const code = `class Foo {\n  static create() { return new Foo(); }\n}`;
    // After chunking → "Foo.create"
  });
});
```

The exact test structure depends on how tree-sitter-chunker.test.ts is organized
— follow existing patterns. The key assertion: instance method symbolId contains
`#`, static method symbolId contains `.`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/core/domains/ingest/pipeline/chunker/tree-sitter-chunker.test.ts
```

Expected: FAIL — symbolId uses `.` for both.

- [ ] **Step 3: Add isStatic to BodyChunkResult**

In `hooks/types.ts`, add field:

```typescript
/** Whether this chunk represents a static/class method. Default: false (instance). */
isStatic?: boolean;
```

- [ ] **Step 4: Update buildSymbolId()**

In `tree-sitter.ts:39-42`:

```typescript
private buildSymbolId(name?: string, parentName?: string, isStatic?: boolean): string | undefined {
  if (!name) return undefined;
  if (!parentName) return name;
  const separator = isStatic ? "." : "#";
  return `${parentName}${separator}${name}`;
}
```

- [ ] **Step 5: Detect static at leaf child emission sites**

In `tree-sitter.ts`, where leaf children are emitted (line ~602):

```typescript
// Detect static modifier on child node
const isStatic = this.hasModifier(childNode, "static");
// ...
symbolId: this.buildSymbolId(childName, parentName, isStatic),
```

Add helper `hasModifier()`:

```typescript
private hasModifier(node: Parser.SyntaxNode, modifier: string): boolean {
  for (const child of node.children) {
    if (child.type === modifier || child.text === modifier) return true;
  }
  return false;
}
```

For hook-provided chunks (line ~238), pass through from BodyChunkResult:

```typescript
symbolId: result.symbolId ?? this.buildSymbolId(
  result.name ?? parentName,
  parentName,
  result.isStatic,
),
```

Wait — hooks that provide `symbolId` directly skip `buildSymbolId`. Hooks that
provide `name` without `symbolId` go through `buildSymbolId`. The `isStatic`
field on BodyChunkResult lets hooks control the separator.

- [ ] **Step 6: Update existing tests**

Existing tests that assert `symbolId: "Parent.child"` format for instance
methods need updating to `"Parent#child"`. This includes:

- `tree-sitter-chunker.test.ts` — all instance method assertions
- `symbol-resolve.test.ts` — mock payloads with `Reranker.score` →
  `Reranker#score`, `Reranker.rerank` → `Reranker#rerank`
- `explore-facade-find-symbol.test.ts` — same pattern

Static method tests should keep `.` separator.

- [ ] **Step 7: Run full test suite**

```bash
npx vitest run
```

Expected: ALL pass.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(chunker): use # separator for instance methods, . for static

buildSymbolId() now produces Class#method (instance) and Class.method (static).
TypeScript static detection via hasModifier(). Hook types gain isStatic field."
```

---

### Task 4: ChunkGrouper — interface + CodeChunkGrouper + DocChunkGrouper

New component replacing outlineClass/outlineDoc in symbol-resolve.ts.

**Files:**

- Create: `src/core/domains/explore/chunk-grouping/chunk-grouper.ts` —
  interface + dispatch
- Create: `src/core/domains/explore/chunk-grouping/code.ts` — CodeChunkGrouper
- Create: `src/core/domains/explore/chunk-grouping/doc.ts` — DocChunkGrouper
- Create: `src/core/domains/explore/chunk-grouping/index.ts` — barrel
- Create: `tests/core/domains/explore/chunk-grouping/code.test.ts`
- Create: `tests/core/domains/explore/chunk-grouping/doc.test.ts`

- [ ] **Step 1: Write CodeChunkGrouper tests**

Create `tests/core/domains/explore/chunk-grouping/code.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { CodeChunkGrouper } from "../../../../../src/core/domains/explore/chunk-grouping/code.js";

describe("CodeChunkGrouper", () => {
  it("renders class outline with instance and static members", () => {
    const classChunk = {
      id: "class-1",
      payload: {
        symbolId: "Reranker",
        chunkType: "class",
        name: "Reranker",
        relativePath: "src/reranker.ts",
        language: "typescript",
        content: "class Reranker { ... }",
        startLine: 10,
        endLine: 25,
        git: { file: { commitCount: 15 } },
      },
    };
    const memberChunks = [
      {
        id: "m1",
        payload: {
          symbolId: "Reranker#rerank",
          relativePath: "src/reranker.ts",
          startLine: 30,
          endLine: 50,
        },
      },
      {
        id: "m2",
        payload: {
          symbolId: "Reranker#score",
          relativePath: "src/reranker.ts",
          startLine: 55,
          endLine: 70,
        },
      },
      {
        id: "m3",
        payload: {
          symbolId: "Reranker.create",
          relativePath: "src/reranker.ts",
          startLine: 75,
          endLine: 80,
        },
      },
    ];

    const grouper = new CodeChunkGrouper();
    const result = grouper.group(classChunk, memberChunks);

    expect(result.payload?.symbolId).toBe("Reranker");
    expect(result.payload?.members).toEqual([
      "Reranker#rerank",
      "Reranker#score",
      "Reranker.create",
    ]);
    // Content is synthetic outline
    expect(result.payload?.content).toContain("class Reranker");
    expect(result.payload?.content).toContain("Reranker#rerank");
    expect(result.payload?.content).toContain("Reranker.create");
    // Git stripped to file level
    expect(result.payload?.git).toEqual({ file: { commitCount: 15 } });
    // Stats
    expect(result.payload?.chunkCount).toBe(4); // class + 3 members
  });

  it("renders file-level outline with multiple top-level symbols", () => {
    const chunks = [
      {
        id: "1",
        payload: {
          symbolId: "Reranker",
          chunkType: "class",
          name: "Reranker",
          relativePath: "src/reranker.ts",
          startLine: 10,
          endLine: 80,
        },
      },
      {
        id: "2",
        payload: {
          symbolId: "Reranker#rerank",
          parentSymbolId: "Reranker",
          relativePath: "src/reranker.ts",
          startLine: 30,
          endLine: 50,
        },
      },
      {
        id: "3",
        payload: {
          symbolId: "createReranker",
          relativePath: "src/reranker.ts",
          startLine: 85,
          endLine: 95,
        },
      },
      {
        id: "4",
        payload: {
          symbolId: "DEFAULTS",
          relativePath: "src/reranker.ts",
          startLine: 1,
          endLine: 5,
        },
      },
    ];

    const grouper = new CodeChunkGrouper();
    const result = grouper.groupFile(chunks);

    expect(result.payload?.content).toContain("src/reranker.ts");
    expect(result.payload?.content).toContain("Reranker");
    expect(result.payload?.content).toContain("Reranker#rerank");
    expect(result.payload?.content).toContain("createReranker");
    expect(result.payload?.content).toContain("DEFAULTS");
    expect(result.payload?.chunkCount).toBe(4);
  });
});
```

- [ ] **Step 2: Write DocChunkGrouper tests**

Create `tests/core/domains/explore/chunk-grouping/doc.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { DocChunkGrouper } from "../../../../../src/core/domains/explore/chunk-grouping/doc.js";

describe("DocChunkGrouper", () => {
  it("renders TOC with heading hierarchy and symbolIds", () => {
    const chunks = [
      {
        id: "d1",
        payload: {
          symbolId: "doc:abc123",
          parentSymbolId: "doc:parent1",
          relativePath: "docs/api.md",
          isDocumentation: true,
          headingPath: [{ depth: 1, text: "API Guide" }],
          startLine: 1,
          endLine: 10,
        },
      },
      {
        id: "d2",
        payload: {
          symbolId: "doc:def456",
          parentSymbolId: "doc:parent1",
          relativePath: "docs/api.md",
          isDocumentation: true,
          headingPath: [
            { depth: 1, text: "API Guide" },
            { depth: 2, text: "Authentication" },
          ],
          startLine: 12,
          endLine: 25,
        },
      },
      {
        id: "d3",
        payload: {
          symbolId: "doc:ghi789",
          parentSymbolId: "doc:parent1",
          relativePath: "docs/api.md",
          isDocumentation: true,
          headingPath: [
            { depth: 1, text: "API Guide" },
            { depth: 2, text: "Authentication" },
            { depth: 3, text: "OAuth" },
          ],
          startLine: 15,
          endLine: 20,
        },
      },
      {
        id: "d4",
        payload: {
          symbolId: "doc:jkl012",
          parentSymbolId: "doc:parent1",
          relativePath: "docs/api.md",
          isDocumentation: true,
          headingPath: [
            { depth: 1, text: "API Guide" },
            { depth: 2, text: "Usage" },
          ],
          startLine: 27,
          endLine: 40,
        },
      },
    ];

    const grouper = new DocChunkGrouper();
    const result = grouper.group(chunks);

    // TOC content
    const content = result.payload?.content as string;
    expect(content).toContain("# API Guide");
    expect(content).toContain("## Authentication");
    expect(content).toContain("### OAuth");
    expect(content).toContain("## Usage");
    expect(content).toContain("doc:abc123");
    expect(content).toContain("doc:def456");
    expect(content).toContain("doc:jkl012");

    // Members
    expect(result.payload?.members).toEqual([
      "doc:abc123",
      "doc:def456",
      "doc:ghi789",
      "doc:jkl012",
    ]);
    expect(result.payload?.isDocumentation).toBe(true);
    expect(result.payload?.chunkCount).toBe(4);
  });

  it("deduplicates consecutive headings from adjacent chunks", () => {
    const chunks = [
      {
        id: "d1",
        payload: {
          symbolId: "doc:aaa",
          parentSymbolId: "doc:p1",
          relativePath: "docs/guide.md",
          isDocumentation: true,
          headingPath: [
            { depth: 1, text: "Guide" },
            { depth: 2, text: "Setup" },
          ],
          startLine: 1,
          endLine: 15,
        },
      },
      {
        id: "d2",
        payload: {
          symbolId: "doc:bbb",
          parentSymbolId: "doc:p1",
          relativePath: "docs/guide.md",
          isDocumentation: true,
          headingPath: [
            { depth: 1, text: "Guide" },
            { depth: 2, text: "Setup" },
          ],
          startLine: 16,
          endLine: 30,
        },
      },
    ];

    const grouper = new DocChunkGrouper();
    const result = grouper.group(chunks);
    const content = result.payload?.content as string;

    // "Setup" appears only once despite being in both chunks
    const setupMatches = content.match(/## Setup/g);
    expect(setupMatches).toHaveLength(1);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
npx vitest run tests/core/domains/explore/chunk-grouping/
```

Expected: FAIL — modules not found.

- [ ] **Step 4: Implement ChunkGrouper interface**

Create `src/core/domains/explore/chunk-grouping/chunk-grouper.ts`:

```typescript
import type { SearchResult } from "../../../api/public/dto/explore.js";

interface ScrollChunk {
  id: string | number;
  payload: Record<string, unknown>;
}

/** Dispatch to the appropriate grouper based on chunk type. */
export function groupChunks(
  anchorChunk: ScrollChunk,
  memberChunks: ScrollChunk[],
): SearchResult {
  if (anchorChunk.payload.isDocumentation) {
    const { DocChunkGrouper } = require("./doc.js");
    return new DocChunkGrouper().group([anchorChunk, ...memberChunks]);
  }
  const { CodeChunkGrouper } = require("./code.js");
  return new CodeChunkGrouper().group(anchorChunk, memberChunks);
}

export type { ScrollChunk };
```

Actually — use static imports, not require. The dispatch function can be
simpler:

```typescript
import type { SearchResult } from "../../../api/public/dto/explore.js";
import { CodeChunkGrouper } from "./code.js";
import { DocChunkGrouper } from "./doc.js";

export interface ScrollChunk {
  id: string | number;
  payload: Record<string, unknown>;
}

export interface ChunkGrouper<TArgs extends unknown[] = [ScrollChunk[]]> {
  group(...args: TArgs): SearchResult;
}

export const codeGrouper = new CodeChunkGrouper();
export const docGrouper = new DocChunkGrouper();
```

- [ ] **Step 5: Implement CodeChunkGrouper**

Create `src/core/domains/explore/chunk-grouping/code.ts`:

```typescript
import type { SearchResult } from "../../../api/public/dto/explore.js";

interface ScrollChunk {
  id: string | number;
  payload: Record<string, unknown>;
}

export class CodeChunkGrouper {
  /** Group class chunk + member chunks into outline. */
  group(classChunk: ScrollChunk, memberChunks: ScrollChunk[]): SearchResult {
    const sorted = [...memberChunks].sort(
      (a, b) =>
        (Number(a.payload.startLine) || 0) - (Number(b.payload.startLine) || 0),
    );
    const members = sorted.map((c) => (c.payload.symbolId as string) ?? "");

    // Synthetic outline content
    const lines: string[] = [`class ${classChunk.payload.name as string}`];
    for (const sym of members) {
      lines.push(`  ${sym}`);
    }
    const content = lines.join("\n");

    const payload: Record<string, unknown> = {
      ...classChunk.payload,
      content,
      git: classChunk.payload.git
        ? { file: (classChunk.payload.git as Record<string, unknown>).file }
        : undefined,
      members: members.length > 0 ? members : undefined,
      chunkCount: 1 + memberChunks.length,
      contentSize: memberChunks.reduce(
        (sum, c) => sum + ((c.payload.content as string)?.length ?? 0),
        (classChunk.payload.content as string)?.length ?? 0,
      ),
    };

    return { id: classChunk.id, score: 1.0, payload };
  }

  /** Group all chunks of a file into file-level outline. */
  groupFile(chunks: ScrollChunk[]): SearchResult {
    const sorted = [...chunks].sort(
      (a, b) =>
        (Number(a.payload.startLine) || 0) - (Number(b.payload.startLine) || 0),
    );
    const first = sorted[0];
    const path = (first.payload.relativePath as string) ?? "";

    // Build hierarchy: top-level symbols + nested members
    const topLevel: ScrollChunk[] = [];
    const byParent = new Map<string, ScrollChunk[]>();
    for (const c of sorted) {
      const parent = c.payload.parentSymbolId as string | undefined;
      if (parent) {
        const list = byParent.get(parent) ?? [];
        list.push(c);
        byParent.set(parent, list);
      } else {
        topLevel.push(c);
      }
    }

    const lines: string[] = [path];
    for (const c of topLevel) {
      const sym =
        (c.payload.symbolId as string) ?? (c.payload.name as string) ?? "";
      lines.push(`  ${sym}`);
      const children = byParent.get(c.payload.name as string) ?? [];
      for (const child of children) {
        lines.push(`    ${(child.payload.symbolId as string) ?? ""}`);
      }
    }

    const payload: Record<string, unknown> = {
      relativePath: path,
      language: first.payload.language,
      fileExtension: first.payload.fileExtension,
      content: lines.join("\n"),
      startLine: first.payload.startLine,
      endLine: sorted[sorted.length - 1].payload.endLine,
      chunkCount: sorted.length,
      contentSize: sorted.reduce(
        (sum, c) => sum + ((c.payload.content as string)?.length ?? 0),
        0,
      ),
      git: first.payload.git
        ? { file: (first.payload.git as Record<string, unknown>).file }
        : undefined,
    };

    return { id: first.id, score: 1.0, payload };
  }
}
```

- [ ] **Step 6: Implement DocChunkGrouper**

Create `src/core/domains/explore/chunk-grouping/doc.ts`:

```typescript
import type { SearchResult } from "../../../api/public/dto/explore.js";

interface ScrollChunk {
  id: string | number;
  payload: Record<string, unknown>;
}

export class DocChunkGrouper {
  /** Group doc chunks into TOC outline. */
  group(chunks: ScrollChunk[]): SearchResult {
    const sorted = [...chunks].sort(
      (a, b) =>
        (Number(a.payload.startLine) || 0) - (Number(b.payload.startLine) || 0),
    );
    const first = sorted[0];

    // Build TOC from headingPath entries
    const tocLines: string[] = [];
    const seen = new Set<string>();

    for (const c of sorted) {
      const hp = c.payload.headingPath as
        | { depth: number; text: string }[]
        | undefined;
      if (!hp) continue;
      for (const entry of hp) {
        const dedupKey = `${entry.depth}:${entry.text}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);

        const prefix = "#".repeat(entry.depth);
        const indent = "  ".repeat(entry.depth - 1);
        const symbolId = (c.payload.symbolId as string) ?? "";
        tocLines.push(
          `${indent}${prefix} ${entry.text}${symbolId ? `  ${symbolId}` : ""}`,
        );
      }
    }

    const members = sorted.map((c) => (c.payload.symbolId as string) ?? "");
    const mergedHeadingPath: { depth: number; text: string }[] = [];
    const hpSeen = new Set<string>();
    for (const c of sorted) {
      const hp = c.payload.headingPath as
        | { depth: number; text: string }[]
        | undefined;
      if (!hp) continue;
      for (const entry of hp) {
        const key = `${entry.depth}:${entry.text}`;
        if (!hpSeen.has(key)) {
          hpSeen.add(key);
          mergedHeadingPath.push(entry);
        }
      }
    }

    const payload: Record<string, unknown> = {
      relativePath: first.payload.relativePath,
      language: first.payload.language,
      isDocumentation: true,
      parentSymbolId: first.payload.parentSymbolId,
      symbolId: first.payload.parentSymbolId, // grouped result uses parent hash as symbolId
      content: tocLines.join("\n"),
      headingPath: mergedHeadingPath,
      members,
      startLine: first.payload.startLine,
      endLine: sorted[sorted.length - 1].payload.endLine,
      chunkCount: sorted.length,
      contentSize: sorted.reduce(
        (sum, c) => sum + ((c.payload.content as string)?.length ?? 0),
        0,
      ),
      git: first.payload.git
        ? { file: (first.payload.git as Record<string, unknown>).file }
        : undefined,
    };

    return { id: first.id, score: 1.0, payload };
  }
}
```

- [ ] **Step 7: Create barrel**

Create `src/core/domains/explore/chunk-grouping/index.ts`:

```typescript
export { CodeChunkGrouper } from "./code.js";
export { DocChunkGrouper } from "./doc.js";
export type { ScrollChunk } from "./chunk-grouper.js";
```

- [ ] **Step 8: Run tests**

```bash
npx vitest run tests/core/domains/explore/chunk-grouping/
```

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(explore): add ChunkGrouper component (CodeChunkGrouper + DocChunkGrouper)

Replaces outlineClass/outlineDoc with dedicated grouping classes.
CodeChunkGrouper renders class/file outlines.
DocChunkGrouper renders heading TOC with symbolId references."
```

---

### Task 5: Integrate ChunkGrouper into resolveSymbols

Replace outlineClass/outlineDoc calls in symbol-resolve.ts with ChunkGrouper.

**Files:**

- Modify: `src/core/domains/explore/symbol-resolve.ts` — replace
  outlineClass/outlineDoc with CodeChunkGrouper/DocChunkGrouper
- Modify: `tests/core/domains/explore/symbol-resolve.test.ts` — update
  assertions for new output format (synthetic content, chunkCount)

- [ ] **Step 1: Update symbol-resolve.ts**

Replace `outlineClass()` and `outlineDoc()` with imports from chunk-grouping:

```typescript
import { CodeChunkGrouper } from "./chunk-grouping/code.js";
import { DocChunkGrouper } from "./chunk-grouping/doc.js";

const codeGrouper = new CodeChunkGrouper();
const docGrouper = new DocChunkGrouper();
```

In the class outline pass (line ~51):

```typescript
// Before
results.push(outlineClass(classChunk, memberChunks));
// After
results.push(codeGrouper.group(classChunk, memberChunks));
```

In the doc outline pass (line ~73):

```typescript
// Before
results.push(outlineDoc(docChunks));
// After
results.push(docGrouper.group(docChunks));
```

Delete the old `outlineClass()` and `outlineDoc()` functions (lines 137-188).
Keep `groupChunks()`, `mergeChunks()`, `sortResults()` — they still serve the
function merge strategy.

- [ ] **Step 2: Update symbol-resolve tests**

The output format changes:

- Class results now have synthetic outline content (not raw class body)
- Class results have `chunkCount` and `contentSize`
- Doc results have TOC content with `#` headings
- Doc results have `chunkCount`

Update assertions in `symbol-resolve.test.ts` to match new format. The `members`
array and git stripping behavior should be identical.

- [ ] **Step 3: Run tests**

```bash
npx vitest run tests/core/domains/explore/symbol-resolve.test.ts
npx vitest run
```

Expected: ALL pass.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(explore): integrate ChunkGrouper into resolveSymbols

Replace outlineClass/outlineDoc with CodeChunkGrouper/DocChunkGrouper.
Class results now have synthetic outline content. Doc results have TOC."
```

---

### Task 6: relativePath parameter for find_symbol

New `relativePath` parameter on `FindSymbolRequest`, mutually exclusive with
`symbol`. Scrolls by `relativePath` field, returns all chunks → ChunkGrouper.

**Files:**

- Modify: `src/core/api/public/dto/explore.ts:122-130` — add `relativePath`,
  make `symbol` optional
- Modify: `src/core/api/internal/facades/explore-facade.ts:302-377` — new branch
  for relativePath
- Modify: `src/mcp/tools/explore.ts` — update find_symbol schema + description
- Modify: `src/core/api/internal/infra/schema-builder.ts` — if schema is
  generated dynamically
- Test: `tests/core/api/internal/facades/explore-facade-find-symbol.test.ts`

- [ ] **Step 1: Write failing test**

Add to `explore-facade-find-symbol.test.ts`:

```typescript
describe("findSymbol with relativePath", () => {
  it("returns file outline for code file", async () => {
    // Mock qdrant.scrollFiltered to return chunks for a .ts file
    // Call facade.findSymbol({ relativePath: "src/reranker.ts", collection: "..." })
    // Assert: result uses CodeChunkGrouper output format
  });

  it("returns TOC for markdown file", async () => {
    // Mock qdrant.scrollFiltered to return doc chunks for a .md file
    // Call facade.findSymbol({ relativePath: "docs/api.md", collection: "..." })
    // Assert: result uses DocChunkGrouper output format
  });

  it("rejects when both symbol and relativePath are provided", async () => {
    // Should throw InputValidationError
  });

  it("rejects when neither symbol nor relativePath is provided", async () => {
    // Should throw InputValidationError
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run tests/core/api/internal/facades/explore-facade-find-symbol.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Update FindSymbolRequest DTO**

In `src/core/api/public/dto/explore.ts`:

```typescript
export interface FindSymbolRequest extends CollectionRef {
  /** Symbol name to find. Mutually exclusive with relativePath. */
  symbol?: string;
  /** File path for file-level lookup. Mutually exclusive with symbol. */
  relativePath?: string;
  language?: string;
  pathPattern?: string;
  metaOnly?: boolean;
  rerank?: string | { custom: Record<string, number> };
  limit?: number;
  offset?: number;
}
```

- [ ] **Step 4: Update explore-facade.ts findSymbol()**

Add validation + relativePath branch:

```typescript
async findSymbol(request: FindSymbolRequest): Promise<ExploreResponse> {
  // Validate: exactly one of symbol or relativePath
  if (request.symbol && request.relativePath) {
    throw new FindSymbolValidationError("symbol and relativePath are mutually exclusive");
  }
  if (!request.symbol && !request.relativePath) {
    throw new FindSymbolValidationError("either symbol or relativePath is required");
  }

  const { collectionName, path } = await this.resolveAndGuard(request.collection, request.path);

  if (request.relativePath) {
    return this.findByRelativePath(collectionName, request, path);
  }

  // existing symbol-based logic...
}

private async findByRelativePath(
  collectionName: string,
  request: FindSymbolRequest,
  path?: string,
): Promise<ExploreResponse> {
  const must: Record<string, unknown>[] = [
    { key: "relativePath", match: { text: request.relativePath! } },
  ];
  if (request.language) {
    must.push({ key: "language", match: { value: request.language } });
  }

  const chunks = await this.qdrant.scrollFiltered(collectionName, { must }, 200);

  if (chunks.length === 0) {
    const driftWarning = path ? await this.checkDrift(path) : null;
    return { results: [], driftWarning };
  }

  // Dispatch to appropriate grouper
  const isDoc = chunks.some((c) => c.payload.isDocumentation);
  let results: SearchResult[];

  if (isDoc) {
    results = [docGrouper.group(chunks)];
  } else {
    results = [codeGrouper.groupFile(chunks)];
  }

  if (request.metaOnly) {
    for (const r of results) {
      if (r.payload) delete r.payload.content;
    }
  }

  // Optional reranking
  if (request.rerank) {
    await this.ensureStats(collectionName);
    results = this.reranker.rerank(results, request.rerank, "find_symbol");
  }

  const driftWarning = path ? await this.checkDrift(path) : null;
  return { results, driftWarning };
}
```

- [ ] **Step 5: Update MCP tool schema**

In `src/mcp/tools/explore.ts`, update find_symbol registration:

- Add `relativePath` parameter to schema (string, optional)
- Update description to mention file-level lookup
- Handler: pass `relativePath` through to `app.findSymbol()`

The schema may come from `SchemaBuilder` — check if `FindSymbolSchema` is
auto-generated or manually defined.

- [ ] **Step 6: Run tests**

```bash
npx vitest run tests/core/api/internal/facades/explore-facade-find-symbol.test.ts
npx vitest run
```

Expected: ALL pass.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(api): add relativePath parameter to find_symbol

File-level lookup: find_symbol(relativePath: 'src/app.ts') returns
CodeChunkGrouper outline. For .md files returns DocChunkGrouper TOC.
Mutually exclusive with symbol parameter."
```

---

### Task 7: Registry + MCP description updates

Update field descriptions and MCP tool documentation.

**Files:**

- Modify: `src/mcp/resources/registry.ts` — `parentSymbolId` description in
  `buildFiltersDoc()`
- Modify: `src/mcp/tools/explore.ts` — `find_symbol` tool description

- [ ] **Step 1: Update registry.ts**

In `buildFiltersDoc()`, replace parentName description:

```
"parentSymbolId (class name for code methods, doc:<hash> for doc chunks)"
```

- [ ] **Step 2: Update find_symbol tool description**

```
Find symbol by name or file path — direct lookup, no embedding.
Returns source code for individual symbols (functions, methods).
Returns structural outline for classes and files.
For doc files: heading TOC with chunk symbolId references.
Use relativePath parameter for file-level lookup.
Use # separator for instance methods (Class#method), . for static (Class.method).
```

- [ ] **Step 3: Run tests**

```bash
npx vitest run
```

Expected: ALL pass (description-only changes).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs(mcp): update find_symbol description and registry field docs

Reflects parentSymbolId rename, relativePath parameter, #/. separator."
```

---

### Task 8: search-cascade update (separate session)

Use `/optimize-skill` on search-cascade to add:

- File outline via `find_symbol(relativePath:)`
- `#` vs `.` in symbolId convention
- `parentSymbolId` (renamed from `parentName`)
- Doc TOC usage pattern

**This task is a separate skill invocation — not part of the code plan.**

---

## Dependency Graph

```
Task 1 (rename) ──→ Task 2 (migration v11)
     │
     ├──→ Task 3 (#/. separator) ──→ Task 4 (ChunkGrouper)
     │                                       │
     └───────────────────────────────────────→ Task 5 (integrate)
                                              │
                                              └──→ Task 6 (relativePath)
                                                   │
                                                   └──→ Task 7 (docs)
                                                        │
                                                        └──→ Task 8 (cascade)
```

Tasks 2 and 3 can run in parallel after Task 1. Tasks 4 depends on Task 3
(symbolId format in test fixtures). Tasks 5-8 are sequential.
