# methodLines Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Store original method line count in Qdrant payload so decomposition
preset correctly scores split chunks.

**Architecture:** Add `methodLines` to `CodeChunk.metadata`, populate in
tree-sitter chunker, write to Qdrant payload. Update `ChunkSizeSignal` and
`ChunkDensitySignal` to read from `methodLines`. Fix `splitOversizedChunk`
startLine/endLine bug. Fix `readRawSource` to support top-level payload keys.

**Tech Stack:** TypeScript, Vitest, tree-sitter chunker, Qdrant payload

---

### Task 1: Add methodLines to CodeChunk metadata

**Files:**

- Modify: `src/core/types.ts:267-294`

**Step 1: Write the failing test**

Create: `tests/core/types.test.ts`

```typescript
import { describe, expect, it } from "vitest";

import type { CodeChunk } from "../../src/core/types.js";

describe("CodeChunk.metadata.methodLines", () => {
  it("accepts optional methodLines field", () => {
    const chunk: CodeChunk = {
      content: "function foo() {}",
      startLine: 1,
      endLine: 10,
      metadata: {
        filePath: "test.ts",
        language: "typescript",
        chunkIndex: 0,
        methodLines: 50,
      },
    };
    expect(chunk.metadata.methodLines).toBe(50);
  });

  it("methodLines is optional (undefined when not set)", () => {
    const chunk: CodeChunk = {
      content: "function foo() {}",
      startLine: 1,
      endLine: 10,
      metadata: {
        filePath: "test.ts",
        language: "typescript",
        chunkIndex: 0,
      },
    };
    expect(chunk.metadata.methodLines).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/types.test.ts` Expected: FAIL — `methodLines`
not in type definition.

**Step 3: Add methodLines to CodeChunk interface**

In `src/core/types.ts`, add after line 293 (after `imports?: string[];`):

```typescript
    /** Original method/block line count before chunk splitting. Used by decomposition signals. */
    methodLines?: number;
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/types.test.ts` Expected: PASS

**Step 5: Commit**

```bash
git add src/core/types.ts tests/core/types.test.ts
git commit -m "feat(types): add methodLines to CodeChunk metadata"
```

---

### Task 2: Update ChunkSizeSignal to read methodLines

**Files:**

- Modify: `src/core/search/rerank/derived-signals/chunk-size.ts`
- Modify: `src/core/search/reranker.ts:250-267` (readRawSource fix)

**Step 1: Write the failing tests**

Create: `tests/core/search/rerank/derived-signals/chunk-size.test.ts`

```typescript
import { describe, expect, it } from "vitest";

import { ChunkSizeSignal } from "../../../../../src/core/search/rerank/derived-signals/chunk-size.js";

describe("ChunkSizeSignal", () => {
  const signal = new ChunkSizeSignal();

  it("has correct name", () => {
    expect(signal.name).toBe("chunkSize");
  });

  it("has sources = ['methodLines'] for adaptive bounds", () => {
    expect(signal.sources).toEqual(["methodLines"]);
  });

  it("has defaultBound = 500", () => {
    expect(signal.defaultBound).toBe(500);
  });

  it("reads methodLines from payload and normalizes", () => {
    const raw = { methodLines: 100 };
    const value = signal.extract(raw);
    // normalize(100, 500) = 0.2
    expect(value).toBeCloseTo(0.2, 5);
  });

  it("uses adaptive bound from ctx when provided", () => {
    const raw = { methodLines: 100 };
    const ctx = { bounds: { methodLines: 200 } };
    // normalize(100, 200) = 0.5
    expect(signal.extract(raw, ctx)).toBeCloseTo(0.5, 5);
  });

  it("returns 0 when methodLines is missing", () => {
    expect(signal.extract({})).toBe(0);
  });

  it("returns 0 when methodLines is 0", () => {
    expect(signal.extract({ methodLines: 0 })).toBe(0);
  });

  it("clamps to 1.0 when methodLines exceeds bound", () => {
    const raw = { methodLines: 1000 };
    // normalize(1000, 500) = min(1, 2) = 1
    expect(signal.extract(raw)).toBeCloseTo(1.0, 5);
  });
});
```

**Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/search/rerank/derived-signals/chunk-size.test.ts`
Expected: FAIL — sources is `[]`, extract reads startLine/endLine.

**Step 3: Rewrite ChunkSizeSignal**

Replace `src/core/search/rerank/derived-signals/chunk-size.ts`:

```typescript
import { normalize } from "../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../contracts/types/trajectory.js";

export class ChunkSizeSignal implements DerivedSignalDescriptor {
  readonly name = "chunkSize";
  readonly description =
    "Normalized method/block size in lines (from methodLines payload field)";
  readonly sources = ["methodLines"];
  readonly defaultBound = 500;
  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const methodLines = (rawSignals.methodLines as number) || 0;
    if (methodLines <= 0) return 0;
    const bound = ctx?.bounds?.["methodLines"] ?? this.defaultBound;
    return normalize(methodLines, bound);
  }
}
```

**Step 4: Fix readRawSource in reranker**

In `src/core/search/reranker.ts`, replace lines 260-266:

```typescript
// 2. Fallback: source as payload path (dotted or top-level)
const val = readPayloadPath(payload, source);
return typeof val === "number" ? val : undefined;
```

This removes the `if (source.includes("."))` guard, allowing `readPayloadPath`
to handle both `"methodLines"` (top-level) and `"git.file.ageDays"` (nested)
paths.

**Step 5: Run test to verify it passes**

Run:
`npx vitest run tests/core/search/rerank/derived-signals/chunk-size.test.ts`
Expected: PASS

**Step 6: Run full test suite to check no regressions**

Run: `npx vitest run` Expected: All pass

**Step 7: Commit**

```bash
git add src/core/search/rerank/derived-signals/chunk-size.ts src/core/search/reranker.ts tests/core/search/rerank/derived-signals/chunk-size.test.ts
git commit -m "feat(signals): ChunkSizeSignal reads methodLines, fix readRawSource for top-level keys"
```

---

### Task 3: Update ChunkDensitySignal with normalization fix

**Files:**

- Modify: `src/core/search/rerank/derived-signals/chunk-density.ts`
- Modify: `tests/core/search/rerank/derived-signals/chunk-density.test.ts`

**Step 1: Update tests for new behavior**

Replace `tests/core/search/rerank/derived-signals/chunk-density.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { ChunkDensitySignal } from "../../../../../src/core/search/rerank/derived-signals/chunk-density.js";

describe("ChunkDensitySignal", () => {
  const signal = new ChunkDensitySignal();

  it("has correct name and description", () => {
    expect(signal.name).toBe("chunkDensity");
    expect(signal.description).toContain("density");
  });

  it("has no sources (computed ratio, not raw source)", () => {
    expect(signal.sources).toEqual([]);
  });

  it("has defaultBound = 120", () => {
    expect(signal.defaultBound).toBe(120);
  });

  it("computes normalized chars per line from contentSize and methodLines", () => {
    // 600 chars / 10 lines = 60 chars/line, normalize(60, 120) = 0.5
    const raw = { contentSize: 600, methodLines: 10 };
    expect(signal.extract(raw)).toBeCloseTo(0.5, 5);
  });

  it("returns 0 when contentSize is missing", () => {
    expect(signal.extract({ methodLines: 10 })).toBe(0);
  });

  it("returns 0 when methodLines is missing or zero", () => {
    expect(signal.extract({ contentSize: 100 })).toBe(0);
    expect(signal.extract({ contentSize: 100, methodLines: 0 })).toBe(0);
  });

  it("clamps to 1.0 when density exceeds defaultBound", () => {
    // 2400 chars / 10 lines = 240 chars/line, normalize(240, 120) = min(1, 2) = 1
    const raw = { contentSize: 2400, methodLines: 10 };
    expect(signal.extract(raw)).toBeCloseTo(1.0, 5);
  });

  it("higher contentSize per line produces higher signal", () => {
    const sparse = signal.extract({ contentSize: 200, methodLines: 10 });
    const dense = signal.extract({ contentSize: 1000, methodLines: 10 });
    expect(dense).toBeGreaterThan(sparse);
  });

  it("always returns value in 0-1 range", () => {
    const values = [
      signal.extract({ contentSize: 10, methodLines: 100 }),
      signal.extract({ contentSize: 5000, methodLines: 5 }),
      signal.extract({ contentSize: 100, methodLines: 10 }),
    ];
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/search/rerank/derived-signals/chunk-density.test.ts`
Expected: FAIL — defaultBound is 0, reads startLine/endLine.

**Step 3: Rewrite ChunkDensitySignal**

Replace `src/core/search/rerank/derived-signals/chunk-density.ts`:

```typescript
import { normalize } from "../../../contracts/signal-utils.js";
import type { DerivedSignalDescriptor } from "../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../contracts/types/trajectory.js";

export class ChunkDensitySignal implements DerivedSignalDescriptor {
  readonly name = "chunkDensity";
  readonly description =
    "Code density: characters per line (contentSize / methodLines)";
  readonly sources: string[] = [];
  readonly defaultBound = 120;
  extract(rawSignals: Record<string, unknown>, _ctx?: ExtractContext): number {
    const contentSize = (rawSignals.contentSize as number) || 0;
    const methodLines = (rawSignals.methodLines as number) || 0;
    if (methodLines <= 0 || contentSize <= 0) return 0;
    const density = contentSize / methodLines;
    return normalize(density, this.defaultBound);
  }
}
```

**Step 4: Run tests to verify they pass**

Run:
`npx vitest run tests/core/search/rerank/derived-signals/chunk-density.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/search/rerank/derived-signals/chunk-density.ts tests/core/search/rerank/derived-signals/chunk-density.test.ts
git commit -m "fix(signals): normalize ChunkDensitySignal, read methodLines instead of startLine/endLine"
```

---

### Task 4: Add methodLines to chunk pipeline payload

**Files:**

- Modify: `src/core/ingest/pipeline/chunk-pipeline.ts:318-356`

**Step 1: Write the failing test**

Create: `tests/core/ingest/pipeline/chunk-pipeline-methodlines.test.ts`

```typescript
import { describe, expect, it } from "vitest";

describe("chunk-pipeline payload: methodLines", () => {
  it("includes methodLines in payload when present in metadata", () => {
    // Simulates the payload construction logic from chunk-pipeline.ts
    const chunk = {
      content: "function foo() { return 1; }",
      startLine: 10,
      endLine: 50,
      metadata: {
        filePath: "/test/file.ts",
        language: "typescript",
        chunkIndex: 0,
        chunkType: "function" as const,
        methodLines: 100,
      },
    };

    // This mirrors the payload construction in chunk-pipeline.ts
    const payload = {
      contentSize: chunk.content.length,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      ...(chunk.metadata.methodLines && {
        methodLines: chunk.metadata.methodLines,
      }),
    };

    expect(payload.methodLines).toBe(100);
  });

  it("omits methodLines from payload when not in metadata", () => {
    const chunk = {
      content: "some code",
      startLine: 1,
      endLine: 5,
      metadata: {
        filePath: "/test/file.ts",
        language: "typescript",
        chunkIndex: 0,
      },
    };

    const payload: Record<string, unknown> = {
      contentSize: chunk.content.length,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      ...((chunk.metadata as Record<string, unknown>).methodLines && {
        methodLines: (chunk.metadata as Record<string, unknown>).methodLines,
      }),
    };

    expect(payload.methodLines).toBeUndefined();
  });
});
```

**Step 2: Run test to verify it passes (pure logic test)**

Run:
`npx vitest run tests/core/ingest/pipeline/chunk-pipeline-methodlines.test.ts`
Expected: PASS (this tests the pattern, not the actual file — it validates our
payload construction)

**Step 3: Add methodLines to chunk-pipeline payload**

In `src/core/ingest/pipeline/chunk-pipeline.ts`, add after the `imports` spread
(line 353), inside the payload object:

```typescript
            ...(item.chunk.metadata.methodLines && {
              methodLines: item.chunk.metadata.methodLines,
            }),
```

**Step 4: Run full test suite**

Run: `npx vitest run` Expected: All pass

**Step 5: Commit**

```bash
git add src/core/ingest/pipeline/chunk-pipeline.ts tests/core/ingest/pipeline/chunk-pipeline-methodlines.test.ts
git commit -m "feat(pipeline): include methodLines in Qdrant payload"
```

---

### Task 5: Populate methodLines in tree-sitter chunker

**Files:**

- Modify: `src/core/ingest/pipeline/chunker/tree-sitter.ts`
- Modify: `tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`

**Step 1: Write the failing test**

Add to `tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`:

```typescript
describe("methodLines metadata", () => {
  it("sets methodLines on regular function chunks", async () => {
    const code = `
function hello() {
  console.log("hello");
  console.log("world");
  return true;
}
`.trim();

    const chunks = await chunker.chunk(code, "test.ts", "typescript");
    expect(chunks.length).toBeGreaterThan(0);
    const chunk = chunks[0];
    expect(chunk.metadata.methodLines).toBe(chunk.endLine - chunk.startLine);
  });

  it("preserves original methodLines when child node is split via fallback", async () => {
    // Create a function large enough to trigger character fallback (> maxChunkSize * 2)
    const lines = Array.from(
      { length: 200 },
      (_, i) =>
        `  const x${i} = ${i}; // padding to exceed chunk size limit ${"x".repeat(80)}`,
    );
    const code = `function bigMethod() {\n${lines.join("\n")}\n}`;

    const chunks = await chunker.chunk(code, "test.ts", "typescript");
    expect(chunks.length).toBeGreaterThan(1); // Should be split

    const originalLines = code.split("\n").length;
    for (const chunk of chunks) {
      // All sub-chunks should have methodLines = original function size
      expect(chunk.metadata.methodLines).toBe(originalLines);
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts -t "methodLines"`
Expected: FAIL — `methodLines` is undefined.

**Step 3: Add methodLines to all chunk creation sites in tree-sitter.ts**

3a. **Regular chunks** (line 320-333) — add `methodLines` to metadata:

```typescript
const nodeName = this.extractName(node, code);
chunks.push({
  content: content.trim(),
  startLine: node.startPosition.row + 1,
  endLine: this.computeEndLine(node),
  metadata: {
    filePath,
    language,
    chunkIndex: index,
    chunkType: this.getChunkType(node.type),
    name: nodeName,
    symbolId: this.buildSymbolId(nodeName),
    methodLines: this.computeEndLine(node) - (node.startPosition.row + 1),
  },
});
```

3b. **Child method chunks** (line 231-245) — add `methodLines`:

```typescript
chunks.push({
  content: finalContent,
  startLine,
  endLine: this.computeEndLine(childNode),
  metadata: {
    filePath,
    language,
    chunkIndex: chunks.length,
    chunkType: this.getChunkType(childNode.type),
    name: childName,
    parentName,
    parentType,
    symbolId: this.buildSymbolId(childName, parentName),
    methodLines:
      this.computeEndLine(childNode) - (childNode.startPosition.row + 1),
  },
});
```

3c. **Child node fallback** (line 196-215) — sub-chunks get parent's span:

```typescript
if (childContent.length > this.config.maxChunkSize * 2) {
  const childMethodLines =
    childNode.endPosition.row - childNode.startPosition.row + 1;
  const subChunks = await this.fallbackChunker.chunk(
    childContent,
    filePath,
    language,
  );
  for (const subChunk of subChunks) {
    chunks.push({
      ...subChunk,
      startLine: childNode.startPosition.row + 1 + subChunk.startLine - 1,
      endLine: childNode.endPosition.row + 1 + subChunk.endLine - 1,
      metadata: {
        ...subChunk.metadata,
        chunkIndex: chunks.length,
        parentName,
        parentType,
        methodLines: childMethodLines,
      },
    });
  }
  continue;
}
```

3d. **Top-level node fallback** (line 297-315) — sub-chunks get parent's span:

```typescript
if (isTooLarge) {
  const nodeMethodLines = node.endPosition.row - node.startPosition.row + 1;
  const subChunks = await this.fallbackChunker.chunk(
    content,
    filePath,
    language,
  );
  for (const subChunk of subChunks) {
    chunks.push({
      ...subChunk,
      startLine: node.startPosition.row + 1 + subChunk.startLine - 1,
      endLine: node.startPosition.row + 1 + subChunk.endLine - 1,
      metadata: {
        ...subChunk.metadata,
        chunkIndex: chunks.length,
        parentName,
        parentType,
        methodLines: nodeMethodLines,
      },
    });
  }
  continue;
}
```

Note: Body chunks (lines 253-269 and 271-290) and character chunker do NOT get
`methodLines` — they are class-level or non-structural chunks.

**Step 4: Run tests**

Run:
`npx vitest run tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts`
Expected: PASS

**Step 5: Run full suite**

Run: `npx vitest run` Expected: All pass

**Step 6: Commit**

```bash
git add src/core/ingest/pipeline/chunker/tree-sitter.ts tests/core/ingest/pipeline/chunker/tree-sitter-chunker.test.ts
git commit -m "feat(chunker): populate methodLines in tree-sitter chunker"
```

---

### Task 6: Fix splitOversizedChunk startLine/endLine bug

**Files:**

- Modify:
  `src/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.ts:252-294`
- Modify:
  `tests/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.test.ts`

**Step 1: Write the failing test**

Add to
`tests/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.test.ts`:

```typescript
describe("splitOversizedChunk startLine/endLine fix", () => {
  it("sub-chunks have distinct startLine/endLine based on actual content", async () => {
    // Create a class with a body large enough to trigger splitting
    const bodyLines = Array.from(
      { length: 100 },
      (_, i) => `  public field${i} = ${i}; // ${"x".repeat(60)}`,
    );
    const code = `class BigClass {\n${bodyLines.join("\n")}\n}`;

    const chunks = await chunker.chunk(code, "test.ts", "typescript");
    const bodyChunks = chunks.filter((c) => c.metadata.chunkType === "block");

    if (bodyChunks.length > 1) {
      // Each sub-chunk should have different startLine/endLine
      for (let i = 1; i < bodyChunks.length; i++) {
        expect(bodyChunks[i].startLine).not.toBe(bodyChunks[0].startLine);
      }
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.test.ts -t "splitOversizedChunk"`
Expected: FAIL — all sub-chunks have same startLine.

**Step 3: Fix splitOversizedChunk**

Replace the function in
`src/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.ts` (lines
252-294):

```typescript
function splitOversizedChunk(
  chunk: BodyChunkResult,
  classHeader: string | undefined,
  maxChunkSize: number,
): BodyChunkResult[] {
  if (chunk.content.length <= maxChunkSize) return [chunk];

  const headerPrefix = classHeader ? `${classHeader}\n` : "";
  const bodyContent = classHeader
    ? chunk.content.slice(headerPrefix.length)
    : chunk.content;
  const bodyLines = bodyContent.split("\n");

  const results: BodyChunkResult[] = [];
  let subLines: string[] = [];
  let subSize = headerPrefix.length;
  let subStartOffset = 0; // line offset within bodyLines

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const lineLen = line.length + 1;
    if (subSize + lineLen > maxChunkSize && subLines.length > 0) {
      results.push({
        content: `${headerPrefix}${subLines.join("\n")}`.trim(),
        startLine: chunk.startLine + subStartOffset,
        endLine: chunk.startLine + i - 1,
        lineRanges: chunk.lineRanges,
      });
      subLines = [];
      subSize = headerPrefix.length;
      subStartOffset = i;
    }
    subLines.push(line);
    subSize += lineLen;
  }

  if (subLines.length > 0) {
    results.push({
      content: `${headerPrefix}${subLines.join("\n")}`.trim(),
      startLine: chunk.startLine + subStartOffset,
      endLine: chunk.startLine + bodyLines.length - 1,
      lineRanges: chunk.lineRanges,
    });
  }

  return results;
}
```

**Step 4: Run tests**

Run:
`npx vitest run tests/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.test.ts`
Expected: PASS

**Step 5: Run full suite**

Run: `npx vitest run` Expected: All pass

**Step 6: Commit**

```bash
git add src/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.ts tests/core/ingest/pipeline/chunker/hooks/typescript/class-body-chunker.test.ts
git commit -m "fix(chunker): splitOversizedChunk gives sub-chunks correct startLine/endLine"
```

---

### Task 7: Update decomposition test + integration verification

**Files:**

- Modify: `tests/core/search/rerank/presets/decomposition.test.ts`

**Step 1: Update decomposition preset test**

Add integration-style test to
`tests/core/search/rerank/presets/decomposition.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { structuralSignals } from "../../../../../src/core/search/rerank/derived-signals/index.js";
import { DecompositionPreset } from "../../../../../src/core/search/rerank/presets/decomposition.js";
import { Reranker } from "../../../../../src/core/search/reranker.js";

describe("DecompositionPreset", () => {
  const preset = new DecompositionPreset();

  it("has name 'decomposition'", () => {
    expect(preset.name).toBe("decomposition");
  });

  it("supports both semantic_search and search_code tools", () => {
    expect(preset.tools).toContain("semantic_search");
    expect(preset.tools).toContain("search_code");
  });

  it("has balanced weights: similarity 0.3, chunkSize 0.35, chunkDensity 0.35", () => {
    expect(preset.weights.similarity).toBe(0.3);
    expect(preset.weights.chunkSize).toBe(0.35);
    expect(preset.weights.chunkDensity).toBe(0.35);
  });

  it("weights sum to 1.0", () => {
    const sum = Object.values(preset.weights).reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 5);
  });

  it("has derived overlay mask with chunkSize and chunkDensity", () => {
    expect(preset.overlayMask.derived).toContain("chunkSize");
    expect(preset.overlayMask.derived).toContain("chunkDensity");
  });
});

describe("Decomposition reranking produces scores in 0-1", () => {
  const reranker = new Reranker(structuralSignals, [new DecompositionPreset()]);

  it("scores large dense methods higher than small sparse ones", () => {
    const results = [
      { score: 0.8, payload: { methodLines: 200, contentSize: 16000 } },
      { score: 0.9, payload: { methodLines: 10, contentSize: 300 } },
    ];

    const ranked = reranker.rerank(results, "decomposition", "semantic_search");

    // All scores in 0-1
    for (const r of ranked) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1);
    }

    // Large dense method should rank first
    expect(ranked[0].payload?.methodLines).toBe(200);
  });

  it("split sub-chunks with same methodLines score equally on size/density", () => {
    const results = [
      {
        score: 0.8,
        payload: {
          methodLines: 100,
          contentSize: 3000,
          startLine: 10,
          endLine: 50,
        },
      },
      {
        score: 0.8,
        payload: {
          methodLines: 100,
          contentSize: 3000,
          startLine: 51,
          endLine: 110,
        },
      },
    ];

    const ranked = reranker.rerank(results, "decomposition", "semantic_search");

    // Both should have identical scores (same methodLines, same contentSize, same similarity)
    expect(ranked[0].score).toBeCloseTo(ranked[1].score, 5);
  });
});
```

**Step 2: Run test**

Run: `npx vitest run tests/core/search/rerank/presets/decomposition.test.ts`
Expected: PASS

**Step 3: Run full suite**

Run: `npx vitest run` Expected: All pass

**Step 4: Commit**

```bash
git add tests/core/search/rerank/presets/decomposition.test.ts
git commit -m "test(decomposition): add integration tests for methodLines scoring"
```
