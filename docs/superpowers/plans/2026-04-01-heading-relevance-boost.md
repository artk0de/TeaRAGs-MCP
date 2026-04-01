# Heading Relevance Boost Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Boost markdown search results based on heading-query token overlap
weighted by heading depth (h1 > h2 > h3).

**Architecture:** Store heading breadcrumb path (`headingPath`) in Qdrant
payload at chunking time. Add `HeadingRelevanceSignal` as a structural derived
signal in static trajectory. Auto-apply `documentationRelevance` preset when
searching documentation. Backfill existing chunks via schema migration v10.

**Tech Stack:** TypeScript, Qdrant, remark AST (existing), Vitest

**Spec:** `docs/superpowers/specs/2026-04-01-heading-relevance-boost-design.md`

---

### Task 1: HeadingRelevanceSignal — derived signal

**Files:**

- Create:
  `src/core/domains/trajectory/static/rerank/derived-signals/heading-relevance.ts`
- Modify: `src/core/domains/trajectory/static/rerank/derived-signals/index.ts`
- Create:
  `tests/core/domains/trajectory/static/rerank/derived-signals/heading-relevance.test.ts`

- [ ] **Step 1: Write tests for HeadingRelevanceSignal**

```typescript
import { describe, expect, it } from "vitest";

import { HeadingRelevanceSignal } from "../../../../../../../src/core/domains/trajectory/static/rerank/derived-signals/heading-relevance.js";

describe("HeadingRelevanceSignal", () => {
  const signal = new HeadingRelevanceSignal();

  it("returns 0 when no headingPath", () => {
    expect(signal.extract({}, { query: "test" })).toBe(0);
  });

  it("returns 0 when headingPath is empty", () => {
    expect(signal.extract({ headingPath: [] }, { query: "test" })).toBe(0);
  });

  it("returns 0 when no query in context", () => {
    expect(signal.extract({ headingPath: [{ depth: 1, text: "Auth" }] })).toBe(
      0,
    );
  });

  it("returns 0 when query is all stop-words", () => {
    expect(
      signal.extract(
        { headingPath: [{ depth: 1, text: "Auth" }] },
        { query: "the a an" },
      ),
    ).toBe(0);
  });

  it("returns 1.0 for exact h1 match", () => {
    expect(
      signal.extract(
        { headingPath: [{ depth: 1, text: "Authentication" }] },
        { query: "authentication" },
      ),
    ).toBe(1.0);
  });

  it("returns 0.67 for exact h2 match", () => {
    const score = signal.extract(
      { headingPath: [{ depth: 2, text: "Authentication" }] },
      { query: "authentication" },
    );
    expect(score).toBeCloseTo(0.667, 2);
  });

  it("returns 0.33 for exact h3 match", () => {
    const score = signal.extract(
      { headingPath: [{ depth: 3, text: "Authentication" }] },
      { query: "authentication" },
    );
    expect(score).toBeCloseTo(0.333, 2);
  });

  it("selects max score from breadcrumb path", () => {
    // h1 matches query → weight 1.0, h3 doesn't → overall 1.0
    const score = signal.extract(
      {
        headingPath: [
          { depth: 1, text: "Authentication" },
          { depth: 2, text: "Endpoints" },
          { depth: 3, text: "Rate Limits" },
        ],
      },
      { query: "authentication" },
    );
    expect(score).toBe(1.0);
  });

  it("computes partial token overlap", () => {
    // query "auth service" → heading "Authentication" has 1/2 overlap
    const score = signal.extract(
      { headingPath: [{ depth: 1, text: "Authentication" }] },
      { query: "auth service" },
    );
    // "auth" != "authentication", "service" not in heading → 0/2 = 0
    expect(score).toBe(0);
  });

  it("handles multi-word heading overlap", () => {
    // query "rate limits" → heading "Rate Limits" has 2/2 overlap
    const score = signal.extract(
      { headingPath: [{ depth: 2, text: "Rate Limits" }] },
      { query: "rate limits" },
    );
    expect(score).toBeCloseTo(0.667, 2);
  });

  it("is case-insensitive", () => {
    const score = signal.extract(
      { headingPath: [{ depth: 1, text: "API Reference" }] },
      { query: "api reference" },
    );
    expect(score).toBe(1.0);
  });

  it("has correct metadata", () => {
    expect(signal.name).toBe("headingRelevance");
    expect(signal.sources).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/trajectory/static/rerank/derived-signals/heading-relevance.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement HeadingRelevanceSignal**

```typescript
// src/core/domains/trajectory/static/rerank/derived-signals/heading-relevance.ts
import type { DerivedSignalDescriptor } from "../../../../../contracts/types/reranker.js";
import type { ExtractContext } from "../../../../../contracts/types/trajectory.js";

interface HeadingPathEntry {
  depth: number;
  text: string;
}

const MAX_DEPTH = 3;

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "and",
  "or",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "with",
  "from",
  "by",
  "as",
  "it",
  "this",
  "that",
]);

/**
 * Heading-query token overlap weighted by heading depth.
 *
 * Purpose: boost markdown chunks when query matches heading text.
 * Higher headings (h1) give more boost than lower (h3).
 * Scoring: max(tokenOverlap × depthWeight) across heading path.
 * Range: 0..1. Internal signal — not shown in overlay.
 */
export class HeadingRelevanceSignal implements DerivedSignalDescriptor {
  readonly name = "headingRelevance";
  readonly description =
    "Heading-query token overlap weighted by heading depth";
  readonly sources: string[] = [];

  extract(rawSignals: Record<string, unknown>, ctx?: ExtractContext): number {
    const path = rawSignals.headingPath as HeadingPathEntry[] | undefined;
    if (!path?.length || !ctx?.query) return 0;

    const queryTokens = tokenize(ctx.query);
    if (queryTokens.length === 0) return 0;

    let maxScore = 0;
    for (const entry of path) {
      const headingTokens = tokenize(entry.text);
      const headingSet = new Set(headingTokens);
      const matches = queryTokens.filter((t) => headingSet.has(t)).length;
      const overlap = matches / queryTokens.length;
      const depthWeight = (MAX_DEPTH - entry.depth + 1) / MAX_DEPTH;
      maxScore = Math.max(maxScore, overlap * depthWeight);
    }
    return maxScore;
  }
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_/]+/)
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}
```

- [ ] **Step 4: Register in barrel**

Add to `src/core/domains/trajectory/static/rerank/derived-signals/index.ts`:

```typescript
import { HeadingRelevanceSignal } from "./heading-relevance.js";

export { HeadingRelevanceSignal } from "./heading-relevance.js";

// In staticDerivedSignals array, add:
new HeadingRelevanceSignal(),
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
`npx vitest run tests/core/domains/trajectory/static/rerank/derived-signals/heading-relevance.test.ts`
Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/trajectory/static/rerank/derived-signals/heading-relevance.ts \
  src/core/domains/trajectory/static/rerank/derived-signals/index.ts \
  tests/core/domains/trajectory/static/rerank/derived-signals/heading-relevance.test.ts
git commit -m "feat(signals): add HeadingRelevanceSignal for markdown heading boost"
```

---

### Task 2: ExtractContext.query + Reranker wiring

**Files:**

- Modify: `src/core/contracts/types/trajectory.ts:97-106`
- Modify: `src/core/domains/explore/reranker.ts:77-152` (rerank method)
- Modify: `src/core/domains/explore/reranker.ts:260-293` (extractAllDerived)
- Create: `tests/core/domains/explore/reranker-query-passthrough.test.ts`

- [ ] **Step 1: Write test for query passthrough**

```typescript
import { describe, expect, it, vi } from "vitest";

import type { DerivedSignalDescriptor } from "../../../../src/core/contracts/types/reranker.js";
import type { ExtractContext } from "../../../../src/core/contracts/types/trajectory.js";
import { Reranker } from "../../../../src/core/domains/explore/reranker.js";

vi.mock("tree-sitter", () => ({
  default: class MockParser {
    parse() {
      return { rootNode: { type: "program", children: [], text: "" } };
    }
  },
}));
vi.mock("tree-sitter-typescript", () => ({
  default: { typescript: {}, tsx: {} },
}));

describe("Reranker query passthrough", () => {
  it("passes query to ExtractContext in derived signal extract()", () => {
    const capturedCtx: ExtractContext[] = [];
    const spySignal: DerivedSignalDescriptor = {
      name: "spy",
      description: "test spy",
      sources: [],
      extract(_raw: Record<string, unknown>, ctx?: ExtractContext) {
        if (ctx) capturedCtx.push(ctx);
        return 0.5;
      },
    };

    const reranker = new Reranker([spySignal], [], []);
    const results = [
      { id: "1", score: 0.9, payload: { relativePath: "test.md" } },
    ];

    reranker.rerank(results, { custom: { spy: 1.0 } }, "semantic_search", {
      query: "authentication",
    });

    expect(capturedCtx.length).toBeGreaterThan(0);
    expect(capturedCtx[0].query).toBe("authentication");
  });

  it("works without query (backward compatible)", () => {
    const spySignal: DerivedSignalDescriptor = {
      name: "spy",
      description: "test spy",
      sources: [],
      extract() {
        return 0.5;
      },
    };

    const reranker = new Reranker([spySignal], [], []);
    const results = [
      { id: "1", score: 0.9, payload: { relativePath: "test.md" } },
    ];

    // No options at all — backward compatible
    const ranked = reranker.rerank(
      results,
      { custom: { spy: 1.0 } },
      "semantic_search",
    );
    expect(ranked).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/explore/reranker-query-passthrough.test.ts`
Expected: FAIL — `RerankOptions` not found or `query` not passed

- [ ] **Step 3: Add `query` to ExtractContext**

In `src/core/contracts/types/trajectory.ts`, add to `ExtractContext`:

```typescript
  /** Search query text for query-dependent signals (e.g. heading relevance). */
  query?: string;
```

- [ ] **Step 4: Refactor Reranker.rerank() signature**

In `src/core/domains/explore/reranker.ts`:

1. Add `RerankOptions` interface (export it):

```typescript
export interface RerankOptions {
  signalLevel?: SignalLevel;
  query?: string;
}
```

2. Change `rerank()` signature from:

```typescript
rerank<T>(results: T[], mode: RerankMode<string>, presetSet: string, overrideSignalLevel?: SignalLevel)
```

to:

```typescript
rerank<T>(results: T[], mode: RerankMode<string>, presetSet: string, options?: RerankOptions)
```

3. Inside `rerank()`, replace `overrideSignalLevel` references:

```typescript
if (options?.signalLevel) signalLevel = options.signalLevel;
```

4. Pass `options?.query` to `extractAllDerived()`.

- [ ] **Step 5: Add `query` parameter to extractAllDerived()**

In `src/core/domains/explore/reranker.ts`, change `extractAllDerived()`:

```typescript
private extractAllDerived(
  payload: Record<string, unknown>,
  sourceBounds: Map<string, number>,
  signalLevel?: SignalLevel,
  query?: string,
): Record<string, number> {
  // ...existing code...
  signals[d.name] = d.extract(payload, {
    bounds,
    dampeningThreshold,
    collectionStats: this.collectionStats,
    signalLevel,
    query,
  });
}
```

- [ ] **Step 6: Update all callers of rerank() to use RerankOptions**

Search for all `.rerank(` calls in facades/app. Replace the 4th positional
`signalLevel` arg with `{ signalLevel }` object. Key files:

- `src/core/api/internal/facades/explore-facade.ts` — find calls in strategy
  `execute()` methods or wherever `reranker.rerank()` is called
- Any other files that call `reranker.rerank()` directly

For each call site, change from:

```typescript
this.reranker.rerank(results, mode, presetSet, level);
```

to:

```typescript
this.reranker.rerank(results, mode, presetSet, { signalLevel: level, query });
```

Where `query` comes from the `ExploreContext.query` field (already available).

- [ ] **Step 7: Run tests**

Run:
`npx vitest run tests/core/domains/explore/reranker-query-passthrough.test.ts`
Expected: ALL PASS

Run: `npx vitest run` (full suite to check no regressions) Expected: ALL PASS

- [ ] **Step 8: Commit**

```bash
git add src/core/contracts/types/trajectory.ts \
  src/core/domains/explore/reranker.ts \
  src/core/api/internal/facades/explore-facade.ts \
  tests/core/domains/explore/reranker-query-passthrough.test.ts
git commit -m "feat(rerank): add query to ExtractContext and RerankOptions"
```

---

### Task 3: DocumentationRelevance preset + auto-activation

**Files:**

- Create: `src/core/domains/explore/rerank/presets/documentation-relevance.ts`
- Modify: `src/core/domains/explore/rerank/presets/index.ts`
- Modify: `src/core/api/internal/facades/explore-facade.ts` (auto-activation)
- Create:
  `tests/core/domains/explore/rerank/presets/documentation-relevance.test.ts`

- [ ] **Step 1: Write test for preset**

```typescript
import { describe, expect, it } from "vitest";

import { DocumentationRelevancePreset } from "../../../../../../src/core/domains/explore/rerank/presets/documentation-relevance.js";

describe("DocumentationRelevancePreset", () => {
  const preset = new DocumentationRelevancePreset();

  it("has correct name", () => {
    expect(preset.name).toBe("documentationRelevance");
  });

  it("targets semantic_search and hybrid_search", () => {
    expect(preset.tools).toContain("semantic_search");
    expect(preset.tools).toContain("hybrid_search");
  });

  it("has headingRelevance weight", () => {
    expect(preset.weights.headingRelevance).toBe(0.3);
  });

  it("excludes headingRelevance from overlay", () => {
    expect(preset.overlayMask?.derived).not.toContain("headingRelevance");
  });

  it("includes similarity and documentation in overlay", () => {
    expect(preset.overlayMask?.derived).toContain("similarity");
    expect(preset.overlayMask?.derived).toContain("documentation");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run:
`npx vitest run tests/core/domains/explore/rerank/presets/documentation-relevance.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement preset**

```typescript
// src/core/domains/explore/rerank/presets/documentation-relevance.ts
import type { ScoringWeights } from "../../../../../contracts/types/provider.js";
import type {
  OverlayMask,
  RerankPreset,
} from "../../../../../contracts/types/reranker.js";

/**
 * Heading-aware documentation ranking.
 *
 * Use when: searching documentation with language:"markdown" or documentation:"only".
 * Auto-activated by ExploreFacade when no explicit rerank is specified.
 * Key signals: similarity (0.5), headingRelevance (0.3), documentation (0.2).
 * headingRelevance is internal — excluded from overlay.
 */
export class DocumentationRelevancePreset implements RerankPreset {
  readonly name = "documentationRelevance";
  readonly description = "Boost documentation by heading relevance and depth";
  readonly tools = ["semantic_search", "hybrid_search"];
  readonly weights: ScoringWeights = {
    similarity: 0.5,
    headingRelevance: 0.3,
    documentation: 0.2,
  };
  readonly overlayMask: OverlayMask = {
    derived: ["similarity", "documentation"],
  };
}
```

- [ ] **Step 4: Register in explore presets barrel**

This preset goes into the **explore composite layer** (not static trajectory),
because it's an explore-specific preset that combines signals from static
trajectory. Check how other explore presets are registered. If explore presets
barrel just re-exports `resolvePresets`/`getPresetNames`, then the preset should
be registered in `STATIC_PRESETS` in
`src/core/domains/trajectory/static/rerank/presets/index.ts` instead (since
that's where presets are collected).

Add to the appropriate barrel:

```typescript
import { DocumentationRelevancePreset } from "./documentation-relevance.js";
export { DocumentationRelevancePreset } from "./documentation-relevance.js";

// In the presets array, add:
new DocumentationRelevancePreset(),
```

- [ ] **Step 5: Add auto-activation in ExploreFacade**

In `src/core/api/internal/facades/explore-facade.ts`, find where
`semanticSearch()` and `hybridSearch()` call `executeExplore()`. Before the
call, add auto-activation logic:

```typescript
// Auto-apply documentation relevance preset for doc searches without explicit rerank
const effectiveRerank =
  request.rerank ??
  (request.documentation === "only" || request.language === "markdown"
    ? "documentationRelevance"
    : undefined);
```

Use `effectiveRerank` instead of `request.rerank` in the `executeExplore()`
call.

Apply this to both `semanticSearch()` and `hybridSearch()` methods.

- [ ] **Step 6: Run tests**

Run:
`npx vitest run tests/core/domains/explore/rerank/presets/documentation-relevance.test.ts`
Expected: PASS

Run: `npx vitest run` (full suite) Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/explore/rerank/presets/documentation-relevance.ts \
  src/core/domains/trajectory/static/rerank/presets/index.ts \
  src/core/api/internal/facades/explore-facade.ts \
  tests/core/domains/explore/rerank/presets/documentation-relevance.test.ts
git commit -m "feat(presets): add documentationRelevance preset with auto-activation"
```

---

### Task 4: MarkdownChunker — write headingPath to metadata

**Files:**

- Modify: `src/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.ts`
- Modify:
  `tests/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts`
  (or create if not exists)

- [ ] **Step 1: Write tests for headingPath in chunker output**

Add to existing markdown chunker tests (or create new test file):

````typescript
import { describe, expect, it } from "vitest";

import { MarkdownChunker } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.js";

describe("MarkdownChunker headingPath", () => {
  const chunker = new MarkdownChunker({ maxChunkSize: 4000 });

  it("writes headingPath for h1 section chunk", async () => {
    const md =
      "# Getting Started\n\nSome content that is long enough to make a chunk here.";
    const chunks = await chunker.chunk(md, "test.md", "markdown");
    const section = chunks.find((c) => c.metadata.name === "Getting Started");
    expect(section?.metadata.headingPath).toEqual([
      { depth: 1, text: "Getting Started" },
    ]);
  });

  it("writes breadcrumb path for h3 section chunk", async () => {
    const md = [
      "# Guide",
      "",
      "Introduction text that is long enough for a chunk here definitely.",
      "",
      "## Setup",
      "",
      "Setup text that is long enough for a chunk here definitely enough.",
      "",
      "### Prerequisites",
      "",
      "Prerequisites text that is long enough for a chunk here definitely.",
    ].join("\n");
    const chunks = await chunker.chunk(md, "test.md", "markdown");
    const h3Chunk = chunks.find((c) => c.metadata.name === "Prerequisites");
    expect(h3Chunk?.metadata.headingPath).toEqual([
      { depth: 1, text: "Guide" },
      { depth: 2, text: "Setup" },
      { depth: 3, text: "Prerequisites" },
    ]);
  });

  it("writes empty headingPath for preamble", async () => {
    const md = [
      "Some preamble content that is long enough for a chunk here definitely.",
      "",
      "## First Section",
      "",
      "Section content that is long enough for a chunk here definitely enough.",
    ].join("\n");
    const chunks = await chunker.chunk(md, "test.md", "markdown");
    const preamble = chunks.find((c) => c.metadata.name === "Preamble");
    expect(preamble?.metadata.headingPath).toEqual([]);
  });

  it("writes headingPath for code block chunk", async () => {
    const md = [
      "## API Reference",
      "",
      "Some text here that is long enough for a chunk here definitely enough.",
      "",
      "```typescript",
      "const x = 1;",
      "const y = 2;",
      "const z = x + y;",
      "// more code to reach minimum size",
      "console.log(z);",
      "```",
    ].join("\n");
    const chunks = await chunker.chunk(md, "test.md", "markdown");
    const codeBlock = chunks.find((c) => c.metadata.name?.startsWith("Code:"));
    expect(codeBlock?.metadata.headingPath).toEqual([
      { depth: 2, text: "API Reference" },
    ]);
  });
});
````

- [ ] **Step 2: Run to verify fail**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts`
Expected: FAIL — `headingPath` not in metadata

- [ ] **Step 3: Implement headingPath in MarkdownChunker**

In `src/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.ts`:

1. Add helper method to build headingPath from breadcrumb ancestors + current
   heading:

```typescript
/** Build structured heading path from ancestors + current heading */
private buildHeadingPath(allHeadings: HeadingInfo[], heading: HeadingInfo): { depth: number; text: string }[] {
  const path: { depth: number; text: string }[] = [];
  // Collect ancestors (same logic as buildBreadcrumb)
  const ancestors: HeadingInfo[] = [];
  for (const h of allHeadings) {
    if (h.startLine >= heading.startLine) break;
    if (h.depth < heading.depth) {
      while (ancestors.length > 0 && ancestors[ancestors.length - 1].depth >= h.depth) {
        ancestors.pop();
      }
      ancestors.push(h);
    }
  }
  for (const a of ancestors) {
    path.push({ depth: a.depth, text: a.text });
  }
  path.push({ depth: heading.depth, text: heading.text });
  return path;
}
```

2. In the section chunk creation loop, add `headingPath` to metadata:

```typescript
metadata: {
  // ...existing fields...
  headingPath: this.buildHeadingPath(headings, heading),
},
```

3. For oversized section sub-chunks, same `headingPath`.

4. For code block chunks, build `headingPath` from parentHeading:

```typescript
headingPath: parentHeading
  ? this.buildHeadingPath(headings, parentHeading)
  : [],
```

5. For preamble chunk: `headingPath: []`.

6. For whole-document fallback: `headingPath: []`.

- [ ] **Step 4: Run tests**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts`
Expected: ALL PASS

Run: `npx vitest run` (full suite) Expected: ALL PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.ts \
  tests/core/domains/ingest/pipeline/chunker/hooks/markdown/chunker.test.ts
git commit -m "feat(chunker): write headingPath to markdown chunk metadata"
```

---

### Task 5: stripInternalFields + DTO filtering

**Files:**

- Create: `src/core/api/public/dto/sanitize.ts`
- Modify: `src/core/api/public/dto/index.ts`
- Modify: `src/core/api/public/app.ts` (response mapping)
- Create: `tests/core/api/public/dto/sanitize.test.ts`

- [ ] **Step 1: Write tests for stripInternalFields**

```typescript
import { describe, expect, it } from "vitest";

import { stripInternalFields } from "../../../../../src/core/api/public/dto/sanitize.js";

describe("stripInternalFields", () => {
  it("removes headingPath from payload", () => {
    const payload = {
      relativePath: "test.md",
      headingPath: [{ depth: 1, text: "Title" }],
      content: "some content",
    };
    const result = stripInternalFields(payload);
    expect(result).not.toHaveProperty("headingPath");
    expect(result.relativePath).toBe("test.md");
    expect(result.content).toBe("some content");
  });

  it("returns payload unchanged when no internal fields", () => {
    const payload = { relativePath: "test.ts", content: "code" };
    const result = stripInternalFields(payload);
    expect(result).toEqual(payload);
  });

  it("does not mutate original payload", () => {
    const payload = {
      relativePath: "test.md",
      headingPath: [{ depth: 1, text: "Title" }],
    };
    stripInternalFields(payload);
    expect(payload).toHaveProperty("headingPath");
  });
});
```

- [ ] **Step 2: Run to verify fail**

Run: `npx vitest run tests/core/api/public/dto/sanitize.test.ts` Expected: FAIL
— module not found

- [ ] **Step 3: Implement stripInternalFields**

```typescript
// src/core/api/public/dto/sanitize.ts

const INTERNAL_PAYLOAD_FIELDS = ["headingPath"] as const;

/** Remove internal payload fields that should not appear in MCP responses. */
export function stripInternalFields(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...payload };
  for (const field of INTERNAL_PAYLOAD_FIELDS) {
    delete result[field];
  }
  return result;
}
```

- [ ] **Step 4: Export from DTO barrel**

Add to `src/core/api/public/dto/index.ts`:

```typescript
export { stripInternalFields } from "./sanitize.js";
```

- [ ] **Step 5: Apply stripInternalFields in response mapping**

In `src/core/api/public/app.ts`, find where search results are mapped to
responses (look for `payload` being passed through in result objects). Apply
`stripInternalFields()` to the payload before returning.

Also check `ExploreFacade.executeExplore()` at
`src/core/api/internal/facades/explore-facade.ts:477-500` — this is where
`r.payload` is passed through. Apply there:

```typescript
import { stripInternalFields } from "../../public/dto/sanitize.js";

// In executeExplore result mapping:
results: results.map((r) => ({
  id: r.id ?? "",
  score: r.score,
  payload: r.payload ? stripInternalFields(r.payload) : r.payload,
  rankingOverlay: r.rankingOverlay,
})),
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/core/api/public/dto/sanitize.test.ts` Expected: ALL
PASS

Run: `npx vitest run` (full suite) Expected: ALL PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/api/public/dto/sanitize.ts \
  src/core/api/public/dto/index.ts \
  src/core/api/internal/facades/explore-facade.ts \
  tests/core/api/public/dto/sanitize.test.ts
git commit -m "feat(dto): add stripInternalFields to hide headingPath from API responses"
```

---

### Task 6: Schema migration v10 — headingPath backfill

**Files:**

- Create:
  `src/core/infra/migration/schema_migrations/schema-v10-heading-path-backfill.ts`
- Modify: `src/core/infra/migration/schema-migrator.ts`
- Create: `tests/core/infra/migration/schema-v10-heading-path-backfill.test.ts`

- [ ] **Step 1: Write tests for migration**

```typescript
import { describe, expect, it } from "vitest";

import { SchemaV10HeadingPathBackfill } from "../../../../src/core/infra/migration/schema_migrations/schema-v10-heading-path-backfill.js";
import type { IndexStore } from "../../../../src/core/infra/migration/types.js";

function createMockStore(
  points: { id: string; payload: Record<string, unknown> }[],
): IndexStore {
  const payloadUpdates: { id: string; payload: Record<string, unknown> }[] = [];
  return {
    scrollAllPoints: async () => points,
    setPayload: async (
      collection: string,
      id: string | number,
      payload: Record<string, unknown>,
    ) => {
      payloadUpdates.push({ id: String(id), payload });
    },
    getPayloadUpdates: () => payloadUpdates,
    // ... other IndexStore methods as vi.fn()
  } as unknown as IndexStore & {
    getPayloadUpdates: () => typeof payloadUpdates;
  };
}

describe("SchemaV10HeadingPathBackfill", () => {
  it("sets headingPath from name for section chunks", async () => {
    const store = createMockStore([
      {
        id: "1",
        payload: {
          isDocumentation: true,
          name: "API Reference",
          parentType: "h1",
          parentName: "Guide",
        },
      },
    ]);
    const migration = new SchemaV10HeadingPathBackfill("test_col", store);
    const result = await migration.apply();
    expect(result.applied.length).toBeGreaterThan(0);
  });

  it("has version 10", () => {
    const store = createMockStore([]);
    const migration = new SchemaV10HeadingPathBackfill("test_col", store);
    expect(migration.version).toBe(10);
  });

  it("sets empty array for preamble chunks", async () => {
    const store = createMockStore([
      {
        id: "1",
        payload: { isDocumentation: true, name: "Preamble" },
      },
    ]);
    const migration = new SchemaV10HeadingPathBackfill("test_col", store);
    await migration.apply();
  });
});
```

Note: the exact mock shape depends on the `IndexStore` interface. Adapt mocks to
match the actual interface from `src/core/infra/migration/types.ts`. Check
`SchemaV9EnrichedAtBackfill` for the pattern — it uses `EnrichmentStore`.
Migration v10 may need `IndexStore` or a new store method. Follow the pattern
from existing migrations.

- [ ] **Step 2: Run to verify fail**

Run:
`npx vitest run tests/core/infra/migration/schema-v10-heading-path-backfill.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement migration**

```typescript
// src/core/infra/migration/schema_migrations/schema-v10-heading-path-backfill.ts
import type { IndexStore, Migration, StepResult } from "../types.js";

const BATCH_SIZE = 100;

export class SchemaV10HeadingPathBackfill implements Migration {
  readonly name = "schema-v10-heading-path-backfill";
  readonly version = 10;

  constructor(
    private readonly collection: string,
    private readonly store: IndexStore,
  ) {}

  async apply(): Promise<StepResult> {
    // Scroll all documentation chunks
    const points = await this.store.scrollFiltered(this.collection, {
      must: [{ key: "isDocumentation", match: { value: true } }],
    });

    if (points.length === 0) {
      return { applied: ["no documentation chunks to migrate"] };
    }

    let updated = 0;
    for (let i = 0; i < points.length; i += BATCH_SIZE) {
      const batch = points.slice(i, i + BATCH_SIZE);
      const operations = batch.map((point) => ({
        points: [point.id],
        payload: { headingPath: this.buildHeadingPath(point.payload ?? {}) },
      }));

      await this.store.batchSetPayload(this.collection, operations);
      updated += batch.length;
    }

    return {
      applied: [`headingPath backfill: ${updated} documentation chunks`],
    };
  }

  private buildHeadingPath(
    payload: Record<string, unknown>,
  ): { depth: number; text: string }[] {
    const name = payload.name as string | undefined;
    const parentName = payload.parentName as string | undefined;
    const parentType = payload.parentType as string | undefined;

    if (!name || name === "Preamble") return [];

    const path: { depth: number; text: string }[] = [];

    // Add parent if available
    if (parentName && parentType) {
      const parentDepth = this.parseDepth(parentType);
      if (parentDepth) {
        path.push({ depth: parentDepth, text: parentName });
      }
    }

    // Add current heading — infer depth from parentType or default to h2
    const currentDepth = this.inferCurrentDepth(payload);
    // Avoid duplicate if name === parentName
    if (path.length === 0 || path[path.length - 1].text !== name) {
      path.push({ depth: currentDepth, text: name });
    }

    return path;
  }

  private parseDepth(parentType: string): number | undefined {
    const match = parentType.match(/^h(\d)$/);
    return match ? parseInt(match[1], 10) : undefined;
  }

  private inferCurrentDepth(payload: Record<string, unknown>): number {
    const parentType = payload.parentType as string | undefined;
    if (parentType) {
      const parentDepth = this.parseDepth(parentType);
      if (parentDepth) return parentDepth;
    }
    // Code blocks or unknown — default to 2
    return 2;
  }
}
```

Note: the exact `IndexStore` methods (`scrollFiltered`, `batchSetPayload`) must
match the actual interface. Check `src/core/infra/migration/types.ts` and adapt.
If `scrollFiltered` doesn't exist, add it to the store interface + adapter
following existing patterns.

- [ ] **Step 4: Register migration in SchemaMigrator**

In `src/core/infra/migration/schema-migrator.ts`, add import and registration:

```typescript
import { SchemaV10HeadingPathBackfill } from "./schema_migrations/schema-v10-heading-path-backfill.js";

// In constructor, add to migrations array:
new SchemaV10HeadingPathBackfill(collection, indexStore),
```

- [ ] **Step 5: Run tests**

Run:
`npx vitest run tests/core/infra/migration/schema-v10-heading-path-backfill.test.ts`
Expected: ALL PASS

Run: `npx vitest run` (full suite) Expected: ALL PASS

- [ ] **Step 6: Commit**

```bash
git add src/core/infra/migration/schema_migrations/schema-v10-heading-path-backfill.ts \
  src/core/infra/migration/schema-migrator.ts \
  tests/core/infra/migration/schema-v10-heading-path-backfill.test.ts
git commit -m "feat(migration): add schema v10 headingPath backfill for documentation chunks"
```

---

### Task 7: Search-cascade update

**Files:**

- Modify: `.claude-plugin/tea-rags/rules/search-cascade.md`

- [ ] **Step 1: Add documentation rerank rule to search-cascade**

In `.claude-plugin/tea-rags/rules/search-cascade.md`, find the
`## Rerank Decision` section. Add a new rule at the top of the decision tree:

```markdown
## Rerank Decision

When the user asks an analytical question:
```

Documentation search? (language: "markdown" OR documentation: "only") ├─ Yes →
no explicit rerank needed │ → facade auto-applies "documentationRelevance"
preset │ → heading-weighted ranking is automatic │ └─ No → continue to preset
selection below

Existing preset fits? ├─ Yes → use it (consult tea-rags://schema/presets for
full list) ...

````

- [ ] **Step 2: Commit**

```bash
git add .claude-plugin/tea-rags/rules/search-cascade.md
git commit -m "docs(search-cascade): add documentation rerank auto-activation rule"
````

---

### Task 8: Integration test + type check

**Files:**

- No new files — run existing test suite + type check

- [ ] **Step 1: Run full test suite**

```bash
npx vitest run
```

Expected: ALL PASS

- [ ] **Step 2: Run type check**

```bash
npx tsc --noEmit
```

Expected: no errors

- [ ] **Step 3: Run build**

```bash
npm run build
```

Expected: success

- [ ] **Step 4: Final commit if any fixes needed**

If any fixes were needed, commit them:

```bash
git add -A
git commit -m "fix(heading-relevance): address integration issues"
```
