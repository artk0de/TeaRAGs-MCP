# Chunk Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add prev/next navigation links to all chunks, generate hash-based
symbolId for documentation chunks, and fix headingPath plumbing.

**Architecture:** Post-processing in `FileProcessor.processFiles()` computes doc
symbolId hashes and navigation links after chunking, before sending to pipeline.
`StaticPayloadBuilder` writes `navigation` and `headingPath` to Qdrant payload.
`SchemaDriftMonitor` detects missing `navigation` in old indexes.

**Tech Stack:** Node.js crypto (SHA-256), Qdrant payload, vitest

**Spec:** `docs/superpowers/specs/2026-04-01-chunk-navigation-design.md`

---

### Task 1: Add `navigation` to `CodeChunk` type

**Files:**

- Modify: `src/core/types.ts:178-212`
- Test: `tests/core/domains/trajectory/static/provider.test.ts` (Task 3)

- [ ] **Step 1: Add navigation field to CodeChunk.metadata**

```typescript
// src/core/types.ts — add after headingPath field (line 210)
    /** Navigation links to adjacent chunks in the same file. */
    navigation?: { prevSymbolId?: string; nextSymbolId?: string };
```

- [ ] **Step 2: Verify types compile**

Run: `npx tsc --noEmit` Expected: PASS (new optional field, no breaking changes)

- [ ] **Step 3: Commit**

```bash
git add src/core/types.ts
git commit -m "feat(types): add navigation field to CodeChunk metadata"
```

---

### Task 2: Generate hash-based symbolId for doc chunks in FileProcessor

**Files:**

- Modify: `src/core/domains/ingest/pipeline/file-processor.ts:89-112`
- Test: `tests/core/domains/ingest/pipeline/file-processor-navigation.test.ts`
  (new)

- [ ] **Step 1: Write failing tests for doc symbolId and navigation**

```typescript
// tests/core/domains/ingest/pipeline/file-processor-navigation.test.ts
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { assignNavigationAndDocSymbolId } from "../../../../src/core/domains/ingest/pipeline/file-processor.js";
import type { CodeChunk } from "../../../../src/core/types.js";

function docHash(input: string): string {
  return "doc:" + createHash("sha256").update(input).digest("hex").slice(0, 12);
}

function makeChunk(
  overrides: Partial<CodeChunk> & { metadata: Partial<CodeChunk["metadata"]> },
): CodeChunk {
  return {
    content: overrides.content ?? "test content",
    startLine: overrides.startLine ?? 1,
    endLine: overrides.endLine ?? 10,
    metadata: {
      filePath: "/project/docs/api.md",
      language: "markdown",
      chunkIndex: 0,
      ...overrides.metadata,
    },
  };
}

describe("assignNavigationAndDocSymbolId", () => {
  const basePath = "/project";

  it("generates doc: hash symbolId for documentation chunks with headingPath", () => {
    const chunks: CodeChunk[] = [
      makeChunk({
        metadata: {
          chunkIndex: 0,
          isDocumentation: true,
          symbolId: "Authentication",
          headingPath: [{ depth: 2, text: "Authentication" }],
        },
      }),
    ];

    assignNavigationAndDocSymbolId(chunks, basePath);

    expect(chunks[0].metadata.symbolId).toBe(
      docHash("docs/api.md#Authentication"),
    );
  });

  it("generates doc: hash symbolId for preamble (empty headingPath)", () => {
    const chunks: CodeChunk[] = [
      makeChunk({
        metadata: {
          chunkIndex: 0,
          isDocumentation: true,
          symbolId: "Preamble",
          headingPath: [],
          name: "Preamble",
        },
      }),
    ];

    assignNavigationAndDocSymbolId(chunks, basePath);

    expect(chunks[0].metadata.symbolId).toBe(docHash("docs/api.md#preamble"));
  });

  it("generates doc: hash symbolId using chunkIndex when no headingPath", () => {
    const chunks: CodeChunk[] = [
      makeChunk({
        metadata: {
          chunkIndex: 3,
          isDocumentation: true,
        },
      }),
    ];

    assignNavigationAndDocSymbolId(chunks, basePath);

    expect(chunks[0].metadata.symbolId).toBe(docHash("docs/api.md#3"));
  });

  it("joins multi-level headingPath with ' > '", () => {
    const chunks: CodeChunk[] = [
      makeChunk({
        metadata: {
          chunkIndex: 0,
          isDocumentation: true,
          symbolId: "OAuth",
          headingPath: [
            { depth: 2, text: "Authentication" },
            { depth: 3, text: "OAuth" },
          ],
        },
      }),
    ];

    assignNavigationAndDocSymbolId(chunks, basePath);

    expect(chunks[0].metadata.symbolId).toBe(
      docHash("docs/api.md#Authentication > OAuth"),
    );
  });

  it("does NOT change symbolId for code chunks", () => {
    const chunks: CodeChunk[] = [
      makeChunk({
        metadata: {
          filePath: "/project/src/app.ts",
          language: "typescript",
          chunkIndex: 0,
          symbolId: "Reranker.rerank",
        },
      }),
    ];

    assignNavigationAndDocSymbolId(chunks, basePath);

    expect(chunks[0].metadata.symbolId).toBe("Reranker.rerank");
  });

  it("sets navigation links for ordered chunks", () => {
    const chunks: CodeChunk[] = [
      makeChunk({ metadata: { chunkIndex: 0, symbolId: "first" } }),
      makeChunk({ metadata: { chunkIndex: 1, symbolId: "second" } }),
      makeChunk({ metadata: { chunkIndex: 2, symbolId: "third" } }),
    ];

    assignNavigationAndDocSymbolId(chunks, basePath);

    expect(chunks[0].metadata.navigation).toEqual({ nextSymbolId: "second" });
    expect(chunks[1].metadata.navigation).toEqual({
      prevSymbolId: "first",
      nextSymbolId: "third",
    });
    expect(chunks[2].metadata.navigation).toEqual({ prevSymbolId: "second" });
  });

  it("sets navigation for single chunk (no prev, no next)", () => {
    const chunks: CodeChunk[] = [
      makeChunk({ metadata: { chunkIndex: 0, symbolId: "only" } }),
    ];

    assignNavigationAndDocSymbolId(chunks, basePath);

    expect(chunks[0].metadata.navigation).toEqual({});
  });

  it("computes doc symbolId BEFORE building navigation links", () => {
    const chunks: CodeChunk[] = [
      makeChunk({
        metadata: {
          chunkIndex: 0,
          isDocumentation: true,
          symbolId: "Intro",
          headingPath: [{ depth: 2, text: "Intro" }],
        },
      }),
      makeChunk({
        metadata: {
          chunkIndex: 1,
          symbolId: "Reranker.rerank",
        },
      }),
    ];

    assignNavigationAndDocSymbolId(chunks, basePath);

    const docId = docHash("docs/api.md#Intro");
    expect(chunks[0].metadata.symbolId).toBe(docId);
    expect(chunks[0].metadata.navigation).toEqual({
      nextSymbolId: "Reranker.rerank",
    });
    expect(chunks[1].metadata.navigation).toEqual({ prevSymbolId: docId });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/file-processor-navigation.test.ts`
Expected: FAIL — `assignNavigationAndDocSymbolId` does not exist

- [ ] **Step 3: Implement `assignNavigationAndDocSymbolId` in
      file-processor.ts**

Add a new exported function at the top of `file-processor.ts` (after imports):

```typescript
import { createHash } from "node:crypto";
import { relative } from "node:path";

/**
 * Post-process chunks of a single file:
 * 1. Replace readable symbolId with doc:hash for documentation chunks
 * 2. Assign navigation links (prevSymbolId / nextSymbolId) for all chunks
 *
 * Mutates chunks in place. Must be called AFTER chunking, BEFORE pipeline.
 */
export function assignNavigationAndDocSymbolId(
  chunks: CodeChunk[],
  basePath: string,
): void {
  // Phase 1: compute doc symbolIds
  for (const chunk of chunks) {
    if (chunk.metadata.isDocumentation) {
      const relPath = relative(basePath, chunk.metadata.filePath);
      const hp = chunk.metadata.headingPath;
      let hashInput: string;
      if (hp && hp.length > 0) {
        hashInput = relPath + "#" + hp.map((h) => h.text).join(" > ");
      } else if (chunk.metadata.name === "Preamble") {
        hashInput = relPath + "#preamble";
      } else {
        hashInput = relPath + "#" + chunk.metadata.chunkIndex;
      }
      chunk.metadata.symbolId =
        "doc:" +
        createHash("sha256").update(hashInput).digest("hex").slice(0, 12);
    }
  }

  // Phase 2: assign navigation
  for (let i = 0; i < chunks.length; i++) {
    const nav: { prevSymbolId?: string; nextSymbolId?: string } = {};
    if (i > 0 && chunks[i - 1].metadata.symbolId) {
      nav.prevSymbolId = chunks[i - 1].metadata.symbolId;
    }
    if (i < chunks.length - 1 && chunks[i + 1].metadata.symbolId) {
      nav.nextSymbolId = chunks[i + 1].metadata.symbolId;
    }
    chunks[i].metadata.navigation = nav;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/file-processor-navigation.test.ts`
Expected: PASS

- [ ] **Step 5: Wire into `processFiles()` loop**

In `file-processor.ts`, after `chunkerPool.processFile()` returns (line 83) and
before the `for (const chunk of chunksToAdd)` loop (line 89), insert:

```typescript
// Post-process: doc symbolIds + navigation links
assignNavigationAndDocSymbolId(chunks, basePath);
```

- [ ] **Step 6: Pass `headingPath` and `navigation` through baseChunk metadata**

In `file-processor.ts`, inside the `baseChunk` metadata construction (lines
99-111), add after `methodLines` (line 109):

```typescript
              headingPath: chunk.metadata.headingPath,
              navigation: chunk.metadata.navigation,
```

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/core/domains/ingest/pipeline/file-processor.ts tests/core/domains/ingest/pipeline/file-processor-navigation.test.ts
git commit -m "feat(pipeline): generate doc symbolId hashes and navigation links"
```

---

### Task 3: Write `navigation` and `headingPath` in StaticPayloadBuilder

**Files:**

- Modify: `src/core/domains/trajectory/static/provider.ts:28-43`
- Test: `tests/core/domains/trajectory/static/provider.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/core/domains/trajectory/static/provider.test.ts`:

```typescript
it("writes navigation to payload", () => {
  const chunk = {
    content: "test",
    startLine: 1,
    endLine: 5,
    metadata: {
      filePath: "/project/src/app.ts",
      language: "typescript",
      chunkIndex: 0,
      symbolId: "App.run",
      navigation: { prevSymbolId: "App.init", nextSymbolId: "App.stop" },
    } as Record<string, unknown>,
  };

  const payload = builder.buildPayload(chunk, "/project");

  expect(payload.navigation).toEqual({
    prevSymbolId: "App.init",
    nextSymbolId: "App.stop",
  });
});

it("writes headingPath to payload for documentation chunks", () => {
  const chunk = {
    content: "# Auth\nSome content",
    startLine: 1,
    endLine: 5,
    metadata: {
      filePath: "/project/docs/api.md",
      language: "markdown",
      chunkIndex: 0,
      isDocumentation: true,
      headingPath: [
        { depth: 1, text: "API" },
        { depth: 2, text: "Auth" },
      ],
    } as Record<string, unknown>,
  };

  const payload = builder.buildPayload(chunk, "/project");

  expect(payload.headingPath).toEqual([
    { depth: 1, text: "API" },
    { depth: 2, text: "Auth" },
  ]);
});

it("omits navigation from payload when not present", () => {
  const chunk = {
    content: "test",
    startLine: 1,
    endLine: 5,
    metadata: {
      filePath: "/project/src/app.ts",
      language: "typescript",
      chunkIndex: 0,
    } as Record<string, unknown>,
  };

  const payload = builder.buildPayload(chunk, "/project");

  expect(payload.navigation).toBeUndefined();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/domains/trajectory/static/provider.test.ts`
Expected: FAIL — `navigation` and `headingPath` not written

- [ ] **Step 3: Add `navigation` and `headingPath` to
      StaticPayloadBuilder.buildPayload()**

In `src/core/domains/trajectory/static/provider.ts`, after the `imports` block
(line 31), add:

```typescript
const headingPath = m.headingPath as
  | { depth: number; text: string }[]
  | undefined;
if (headingPath?.length) payload.headingPath = headingPath;
const navigation = m.navigation as
  | { prevSymbolId?: string; nextSymbolId?: string }
  | undefined;
if (navigation) payload.navigation = navigation;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/domains/trajectory/static/provider.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/trajectory/static/provider.ts tests/core/domains/trajectory/static/provider.test.ts
git commit -m "feat(trajectory): write navigation and headingPath to Qdrant payload"
```

---

### Task 4: Verify `stripInternalFields` does NOT strip `navigation`

**Files:**

- Test: `tests/core/api/public/dto/sanitize.test.ts`

- [ ] **Step 1: Write test**

Add to `tests/core/api/public/dto/sanitize.test.ts`:

```typescript
it("does NOT strip navigation field", () => {
  const payload = {
    relativePath: "src/app.ts",
    headingPath: [{ depth: 1, text: "Title" }],
    navigation: { prevSymbolId: "doc:abc123", nextSymbolId: "App.run" },
    content: "code here",
  };

  const result = stripInternalFields(payload);

  expect(result.navigation).toEqual({
    prevSymbolId: "doc:abc123",
    nextSymbolId: "App.run",
  });
  expect(result.headingPath).toBeUndefined(); // still stripped
});
```

- [ ] **Step 2: Run test**

Run: `npx vitest run tests/core/api/public/dto/sanitize.test.ts` Expected: PASS
(no code changes needed — `navigation` is not in `INTERNAL_PAYLOAD_FIELDS`)

- [ ] **Step 3: Commit**

```bash
git add tests/core/api/public/dto/sanitize.test.ts
git commit -m "test(dto): verify navigation field is not stripped from API responses"
```

---

### Task 5: Add `navigation` to schemaDrift detection

**Files:**

- Modify: `src/core/api/internal/facades/ingest-facade.ts:318`
- Modify: `src/bootstrap/factory.ts:144`
- Test: `tests/core/infra/schema-drift.test.ts`

The current schemaDrift system tracks `allPayloadSignals.map(d => d.key)` —
signal descriptor keys from trajectory providers. `navigation` is not a signal
descriptor. We add it as a structural payload key alongside signal keys.

- [ ] **Step 1: Write failing test for navigation in drift detection**

Add to `tests/core/infra/schema-drift.test.ts`:

```typescript
it("detects drift when navigation key is missing from cached index", () => {
  const cachedKeys = ["git.file.ageDays", "git.file.commitCount"];
  const currentKeys = [
    "git.file.ageDays",
    "git.file.commitCount",
    "navigation",
  ];

  const drift = StatsCache.checkSchemaDrift(cachedKeys, currentKeys);

  expect(drift).not.toBeNull();
  expect(drift!.added).toContain("navigation");
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run tests/core/infra/schema-drift.test.ts` Expected: PASS —
`checkSchemaDrift` is a generic set-diff, it already works. The real change is
making sure `"navigation"` appears in `currentKeys`.

- [ ] **Step 3: Add `"navigation"` to payload keys in IngestFacade**

In `src/core/api/internal/facades/ingest-facade.ts`, line 318, change:

```typescript
const payloadFieldKeys = this.allPayloadSignals.map((d) => d.key);
```

to:

```typescript
const payloadFieldKeys = [
  ...this.allPayloadSignals.map((d) => d.key),
  "navigation",
];
```

- [ ] **Step 4: Add `"navigation"` to currentPayloadKeys in factory.ts**

In `src/bootstrap/factory.ts`, line 144, change:

```typescript
    allPayloadSignalDescriptors.map((d) => d.key),
```

to:

```typescript
    [...allPayloadSignalDescriptors.map((d) => d.key), "navigation"],
```

- [ ] **Step 5: Write integration test for drift warning message**

Add to `tests/core/infra/schema-drift.test.ts`:

```typescript
it("formats drift warning mentioning navigation requires reindex", () => {
  const drift: SchemaDrift = { added: ["navigation"], removed: [] };

  const warning = StatsCache.formatSchemaDriftWarning(drift);

  expect(warning).toContain("navigation");
  expect(warning).toContain("reindex");
});
```

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/api/internal/facades/ingest-facade.ts src/bootstrap/factory.ts tests/core/infra/schema-drift.test.ts
git commit -m "feat(drift): track navigation field in schema drift detection"
```

---

### Task 6: Update search-cascade rule and add schemaDrift/migration rule

**Files:**

- Modify: search-cascade documentation (agent instructions)
- Create: `src/core/.claude/rules/.local/schema-drift-vs-migration.md` (or
  project-level rules)

- [ ] **Step 1: Add navigation guidance to search-cascade**

Add new section to search-cascade after "Fallback Chains":

```markdown
## Chunk Navigation

After finding a chunk via search, use `navigation` field to explore surrounding
context without `Read`:
```

Need context around a found chunk? ├─ Check navigation.prevSymbolId /
navigation.nextSymbolId in result payload ├─ Call find_symbol(symbol:
<symbolId>) to get adjacent chunk ├─ Found middle of file? Navigate both
directions as needed ├─ Don't read entire file — take only chunks you need └─ No
navigation field? Index predates this feature — use Read as fallback

```

**Doc symbolId format:** Documentation chunks use opaque hash IDs (`doc:a3f8b2c1e4d7`).
Do NOT guess or construct these — always take from search results or
`navigation` links. Code chunks keep readable symbolId (`Class.method`).
```

- [ ] **Step 2: Create schemaDrift vs migration rule**

```markdown
# Schema Drift vs Migrations

## Schema Drift (schemaDrift)

Used for **new version breaking changes** — when a new code version adds payload
fields that require full reindexation to populate.

- Detects: new fields in code that don't exist in cached index
- Action: prompts user to run `index_codebase` with `forceReindex=true`
- Message: "New fields: navigation (require reindex to populate). Run
  index_codebase with forceReindex=true for new features."
- User reindexes when convenient — no forced migration

## Migrations

Used when there is a way to **partially update** existing data without full
reindexation.

- Currently: no partial update mechanism exists for Qdrant payload fields
- All payload changes require full reindexation
- Migrations are reserved for future use (e.g., Qdrant index changes, snapshot
  format changes, sparse vector rebuilds)
```

- [ ] **Step 3: Commit**

```bash
git add <search-cascade-file> <rules-file>
git commit -m "docs(search-cascade): add chunk navigation guidance and drift vs migration rule"
```

---

### Task 7: End-to-end integration test

**Files:**

- Test: `tests/core/domains/ingest/pipeline/navigation-integration.test.ts`
  (new)

- [ ] **Step 1: Write integration test covering full pipeline path**

This test verifies the complete chain: MarkdownChunker → FileProcessor →
StaticPayloadBuilder → payload with navigation + doc symbolId + headingPath.

```typescript
// tests/core/domains/ingest/pipeline/navigation-integration.test.ts
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createTempTestDir } from "../__helpers__/test-helpers.js";
import { MarkdownChunker } from "../../../../src/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.js";
import { assignNavigationAndDocSymbolId } from "../../../../src/core/domains/ingest/pipeline/file-processor.js";
import { StaticPayloadBuilder } from "../../../../src/core/domains/trajectory/static/provider.js";

function docHash(input: string): string {
  return "doc:" + createHash("sha256").update(input).digest("hex").slice(0, 12);
}

describe("navigation integration", () => {
  it("markdown chunks get doc: symbolId, navigation, and headingPath in Qdrant payload", async () => {
    const tmpDir = createTempTestDir();
    const filePath = join(tmpDir, "guide.md");
    const markdown = [
      "# Guide",
      "",
      "Introduction paragraph that is long enough to pass minimum size check for preamble content.",
      "",
      "## Installation",
      "",
      "Run npm install to get started with the project setup and configuration.",
      "",
      "## Usage",
      "",
      "Import the module and call the main function to start processing your data.",
    ].join("\n");
    writeFileSync(filePath, markdown);

    // Step 1: Chunk
    const chunker = new MarkdownChunker({ maxChunkSize: 5000 });
    const chunks = await chunker.chunk(markdown, filePath, "markdown");

    // Step 2: Post-process (doc symbolIds + navigation)
    assignNavigationAndDocSymbolId(chunks, tmpDir);

    // Verify doc symbolIds are hashes
    for (const chunk of chunks) {
      expect(chunk.metadata.symbolId).toMatch(/^doc:[a-f0-9]{12}$/);
    }

    // Verify navigation chain
    for (let i = 0; i < chunks.length; i++) {
      const nav = chunks[i].metadata.navigation!;
      if (i > 0) {
        expect(nav.prevSymbolId).toBe(chunks[i - 1].metadata.symbolId);
      } else {
        expect(nav.prevSymbolId).toBeUndefined();
      }
      if (i < chunks.length - 1) {
        expect(nav.nextSymbolId).toBe(chunks[i + 1].metadata.symbolId);
      } else {
        expect(nav.nextSymbolId).toBeUndefined();
      }
    }

    // Step 3: Build Qdrant payloads
    const builder = new StaticPayloadBuilder();
    const payloads = chunks.map((c) => builder.buildPayload(c, tmpDir));

    // Verify navigation appears in payload
    for (const payload of payloads) {
      expect(payload.navigation).toBeDefined();
    }

    // Verify headingPath appears in payload for chunks that have it
    const withHeadings = payloads.filter((p) => {
      const hp = p.headingPath as unknown[];
      return hp && hp.length > 0;
    });
    expect(withHeadings.length).toBeGreaterThan(0);
  });

  it("code chunks keep readable symbolId with navigation", async () => {
    const chunks = [
      {
        content: "function init() {}",
        startLine: 1,
        endLine: 1,
        metadata: {
          filePath: "/project/src/app.ts",
          language: "typescript",
          chunkIndex: 0,
          chunkType: "function" as const,
          symbolId: "init",
        },
      },
      {
        content: "function run() {}",
        startLine: 3,
        endLine: 3,
        metadata: {
          filePath: "/project/src/app.ts",
          language: "typescript",
          chunkIndex: 1,
          chunkType: "function" as const,
          symbolId: "run",
        },
      },
    ];

    assignNavigationAndDocSymbolId(chunks, "/project");

    expect(chunks[0].metadata.symbolId).toBe("init"); // NOT hashed
    expect(chunks[1].metadata.symbolId).toBe("run");
    expect(chunks[0].metadata.navigation).toEqual({ nextSymbolId: "run" });
    expect(chunks[1].metadata.navigation).toEqual({ prevSymbolId: "init" });
  });
});
```

- [ ] **Step 2: Run integration test**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/navigation-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add tests/core/domains/ingest/pipeline/navigation-integration.test.ts
git commit -m "test(pipeline): add navigation integration tests"
```
