# Scoped Signal Statistics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate signal statistics into `source` and `test` scopes so label
thresholds are computed independently for production code and test code.

**Architecture:** Add `detectScope()` utility that classifies chunks by
chunkType priority (AST-detected `test`/`test_setup`) with path-pattern
fallback. `CollectionSignalStats.perLanguage` stores `ScopedSignalStats` (source

- optional test) instead of flat `SignalStats`. Reranker resolves labels using
  scope-appropriate thresholds. Cache bumps to v5 with backward-compatible
  migration.

**Tech Stack:** TypeScript, Vitest, picomatch (already a dependency)

**Spec:** `docs/superpowers/specs/2026-03-26-scoped-signal-stats-design.md`

---

### Task 1: Scope Detection Utility

**Files:**

- Create: `src/core/infra/scope-detection.ts`
- Test: `tests/core/infra/scope-detection.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/core/infra/scope-detection.test.ts
import { describe, expect, it } from "vitest";

import {
  detectScope,
  getDefaultTestPaths,
} from "../../../src/core/infra/scope-detection.js";

describe("detectScope", () => {
  const noTestChunks = new Map<string, number>();
  const rubyHasTests = new Map([["ruby", 50]]);

  it("returns 'test' for chunkType=test regardless of path", () => {
    expect(
      detectScope("test", "src/app/service.rb", "ruby", {
        languageTestChunkCounts: rubyHasTests,
      }),
    ).toBe("test");
  });

  it("returns null for chunkType=test_setup (excluded from both scopes)", () => {
    expect(
      detectScope("test_setup", "spec/models/user_spec.rb", "ruby", {
        languageTestChunkCounts: rubyHasTests,
      }),
    ).toBeNull();
  });

  it("returns 'source' for chunkType=function in source path", () => {
    expect(
      detectScope("function", "src/app/service.rb", "ruby", {
        languageTestChunkCounts: rubyHasTests,
      }),
    ).toBe("source");
  });

  it("returns 'test' via path fallback when language has 0 test chunks", () => {
    expect(
      detectScope("function", "spec/models/user_spec.rb", "ruby", {
        languageTestChunkCounts: noTestChunks,
      }),
    ).toBe("test");
  });

  it("excludes default test paths from source even when language has test chunks", () => {
    expect(
      detectScope("function", "spec/models/user_spec.rb", "ruby", {
        languageTestChunkCounts: rubyHasTests,
      }),
    ).toBe("source");
  });

  it("uses CODE_TEST_PATHS override when provided", () => {
    expect(
      detectScope("function", "custom_tests/foo.rb", "ruby", {
        testPaths: ["custom_tests/**"],
        languageTestChunkCounts: noTestChunks,
      }),
    ).toBe("test");
  });

  it("uses fallback test paths for unknown languages", () => {
    expect(
      detectScope("function", "test/foo.ex", "elixir", {
        languageTestChunkCounts: noTestChunks,
      }),
    ).toBe("test");
  });

  it("returns 'source' for non-test path when language has 0 test chunks", () => {
    expect(
      detectScope("function", "src/app/service.rb", "ruby", {
        languageTestChunkCounts: noTestChunks,
      }),
    ).toBe("source");
  });
});

describe("getDefaultTestPaths", () => {
  it("returns ruby-specific paths for ruby", () => {
    const paths = getDefaultTestPaths("ruby");
    expect(paths).toContain("spec/**");
    expect(paths).toContain("test/**");
  });

  it("returns typescript-specific paths for typescript", () => {
    const paths = getDefaultTestPaths("typescript");
    expect(paths).toContain("__tests__/**");
  });

  it("returns fallback paths for unknown language", () => {
    const paths = getDefaultTestPaths("brainfuck");
    expect(paths.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/infra/scope-detection.test.ts` Expected: FAIL —
module not found

- [ ] **Step 3: Implement `detectScope()`**

```typescript
// src/core/infra/scope-detection.ts
import picomatch from "picomatch";

export type ChunkScope = "source" | "test" | null;

export interface ScopeDetectionConfig {
  testPaths?: string[];
  languageTestChunkCounts: Map<string, number>;
}

const DEFAULT_TEST_PATHS: Record<string, string[]> = {
  ruby: ["spec/**", "test/**"],
  typescript: [
    "tests/**",
    "test/**",
    "__tests__/**",
    "**/*.test.ts",
    "**/*.test.tsx",
    "**/*.spec.ts",
    "**/*.spec.tsx",
  ],
  javascript: [
    "tests/**",
    "test/**",
    "__tests__/**",
    "**/*.test.js",
    "**/*.test.jsx",
    "**/*.spec.js",
    "**/*.spec.jsx",
  ],
  python: ["tests/**", "test/**", "**/test_*.py", "**/*_test.py"],
  go: ["**/*_test.go"],
  java: ["src/test/**", "**/test/**"],
  kotlin: ["src/test/**", "**/test/**"],
  csharp: ["**/*.Tests/**", "**/Tests/**", "**/*Test.cs", "**/*Tests.cs"],
  swift: ["**/Tests/**", "**/*Tests.swift"],
  php: ["tests/**", "test/**", "**/*Test.php"],
  elixir: ["test/**", "**/*_test.exs"],
  scala: ["src/test/**", "**/test/**"],
};

const FALLBACK_TEST_PATHS = ["test/**", "tests/**", "spec/**", "__tests__/**"];

export function getDefaultTestPaths(language: string): string[] {
  return DEFAULT_TEST_PATHS[language] ?? FALLBACK_TEST_PATHS;
}

export function detectScope(
  chunkType: string | undefined,
  relativePath: string,
  language: string,
  config: ScopeDetectionConfig,
): ChunkScope {
  // Priority 1: AST-detected test chunks
  if (chunkType === "test") return "test";

  // Priority 2: test_setup excluded from both scopes
  if (chunkType === "test_setup") return null;

  // Priority 3: path-based detection
  const testPaths = config.testPaths ?? getDefaultTestPaths(language);
  const isTestPath = testPaths.some((pattern) =>
    picomatch.isMatch(relativePath, pattern),
  );

  // Always exclude test paths from source
  if (isTestPath) {
    // If language has AST test chunks, path-matched non-test chunkTypes
    // in test dirs are still test scope (e.g. helper functions in spec/)
    const langTestCount = config.languageTestChunkCounts.get(language) ?? 0;
    if (langTestCount > 0) {
      // Language has AST test detection — trust chunkType for chunks IN test dirs
      // but exclude from source stats
      return "source";
    }
    // Language has no AST test detection — path is the only signal
    return "test";
  }

  return "source";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/infra/scope-detection.test.ts` Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/infra/scope-detection.ts tests/core/infra/scope-detection.test.ts
git commit -m "feat(infra): add detectScope() utility for test/source classification"
```

---

### Task 2: `ScopedSignalStats` Type + Config

**Files:**

- Modify: `src/core/contracts/types/trajectory.ts`
- Modify: `src/bootstrap/config.ts` (or `parse.ts`)

- [ ] **Step 1: Add `ScopedSignalStats` type**

In `src/core/contracts/types/trajectory.ts`, add after `SignalStats`:

```typescript
/** Signal stats split by scope (source code vs test code). */
export interface ScopedSignalStats {
  source: SignalStats;
  test?: SignalStats;
}
```

Update `CollectionSignalStats.perLanguage`:

```typescript
export interface CollectionSignalStats {
  perSignal: Map<string, SignalStats>;
  /** Per-language signal stats, split by scope. */
  perLanguage: Map<string, Map<string, ScopedSignalStats>>;
  distributions: Distributions;
  computedAt: number;
}
```

- [ ] **Step 2: Add `CODE_TEST_PATHS` env var parsing**

In `src/bootstrap/parse.ts`, add to `buildEnvInputs()` inside the `ingest`
section:

```typescript
const ingest = {
  // ... existing fields
  testPaths: env("CODE_TEST_PATHS"),
};
```

Expose in config as `ingestCode.testPaths?: string[]` (split by comma in
resolver).

- [ ] **Step 3: Fix type errors from `ScopedSignalStats` change**

This will cause compile errors in:

- `collection-stats.ts` (returns `Map<string, SignalStats>`, needs
  `Map<string, ScopedSignalStats>`)
- `stats-cache.ts` (serializes `SignalStats`, needs `ScopedSignalStats`)
- `reranker.ts` (reads `langStats.get(key)` as `SignalStats`, now
  `ScopedSignalStats`)
- `explore-facade.ts` (`buildSignalMetrics` receives `Map<string, SignalStats>`)

These will be fixed in subsequent tasks. For now, temporarily wrap existing
perLanguage values as `{ source: existingStats }` in `collection-stats.ts` to
keep compilation passing.

- [ ] **Step 4: Verify compilation**

Run: `npx tsc --noEmit` Expected: PASS (no type errors)

- [ ] **Step 5: Commit**

```bash
git add src/core/contracts/types/trajectory.ts src/bootstrap/parse.ts
git commit -m "feat(contracts): add ScopedSignalStats type and CODE_TEST_PATHS config"
```

---

### Task 3: Scope-Aware `computeCollectionStats()`

**Files:**

- Modify: `src/core/domains/ingest/collection-stats.ts`
- Test: `tests/core/domains/ingest/collection-stats.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to existing test file:

```typescript
describe("computeCollectionStats — scoped stats", () => {
  const signals: PayloadSignalDescriptor[] = [
    {
      key: "methodLines",
      type: "number",
      stats: {
        labels: { p50: "small", p75: "large", p95: "decomposition_candidate" },
        chunkTypeFilter: "function",
        mean: true,
      },
    },
    {
      key: "git.file.commitCount",
      type: "number",
      stats: {
        labels: { p25: "low", p50: "typical", p75: "high", p95: "extreme" },
        mean: true,
      },
    },
  ];

  function makePoint(overrides: Record<string, unknown>) {
    return {
      payload: {
        language: "ruby",
        chunkType: "function",
        relativePath: "app/models/user.rb",
        methodLines: 30,
        git: { file: { commitCount: 5 } },
        ...overrides,
      },
    };
  }

  it("separates source and test stats in perLanguage", () => {
    const points = [
      makePoint({ methodLines: 20, relativePath: "app/models/user.rb" }),
      makePoint({ methodLines: 25, relativePath: "app/models/post.rb" }),
      makePoint({
        methodLines: 80,
        chunkType: "test",
        relativePath: "spec/models/user_spec.rb",
      }),
      makePoint({
        methodLines: 120,
        chunkType: "test",
        relativePath: "spec/models/post_spec.rb",
      }),
    ];

    const result = computeCollectionStats(points, signals);
    const rubyStats = result.perLanguage.get("ruby");
    expect(rubyStats).toBeDefined();

    const mlStats = rubyStats!.get("methodLines");
    expect(mlStats).toBeDefined();
    expect(mlStats!.source.count).toBe(2);
    expect(mlStats!.test).toBeDefined();
    expect(mlStats!.test!.count).toBe(2);
    // Source p50 should be ~22.5, test p50 should be ~100
    expect(mlStats!.source.percentiles[50]).toBeLessThan(
      mlStats!.test!.percentiles[50]!,
    );
  });

  it("excludes test_setup from both scopes", () => {
    const points = [
      makePoint({ methodLines: 20, relativePath: "app/models/user.rb" }),
      makePoint({
        methodLines: 10,
        chunkType: "test_setup",
        relativePath: "spec/support/setup.rb",
      }),
      makePoint({
        methodLines: 80,
        chunkType: "test",
        relativePath: "spec/models/user_spec.rb",
      }),
    ];

    const result = computeCollectionStats(points, signals);
    const rubyStats = result.perLanguage.get("ruby");
    const mlStats = rubyStats!.get("methodLines");
    expect(mlStats!.source.count).toBe(1); // only source
    expect(mlStats!.test!.count).toBe(1); // only test, not test_setup
  });

  it("uses path fallback when language has 0 test chunks", () => {
    const points = [
      makePoint({
        language: "python",
        methodLines: 20,
        relativePath: "src/app.py",
      }),
      makePoint({
        language: "python",
        methodLines: 90,
        relativePath: "tests/test_app.py",
      }),
    ];

    const result = computeCollectionStats(points, signals);
    const pyStats = result.perLanguage.get("python");
    expect(pyStats).toBeDefined();
    const mlStats = pyStats!.get("methodLines");
    expect(mlStats!.source.count).toBe(1);
    expect(mlStats!.test).toBeDefined();
    expect(mlStats!.test!.count).toBe(1);
  });

  it("global perSignal excludes test chunks", () => {
    const points = [
      makePoint({ methodLines: 20 }),
      makePoint({ methodLines: 25 }),
      makePoint({
        methodLines: 200,
        chunkType: "test",
        relativePath: "spec/big_spec.rb",
      }),
    ];

    const result = computeCollectionStats(points, signals);
    const globalML = result.perSignal.get("methodLines");
    expect(globalML).toBeDefined();
    // Global should only have source values
    expect(globalML!.count).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/domains/ingest/collection-stats.test.ts`
Expected: FAIL — perLanguage returns `SignalStats` not `ScopedSignalStats`

- [ ] **Step 3: Implement scope-aware extraction**

Modify `extractSignalValues()` in `collection-stats.ts`:

1. Import `detectScope`, `getDefaultTestPaths` from
   `../../infra/scope-detection.js`
2. First pass: count test chunks per language (for `languageTestChunkCounts`)
3. Second pass: for each point, call `detectScope()` → route values to `source`
   or `test` arrays in `perLanguageScopeValues`
4. Exclude `test`/`test_setup` chunks and test-path chunks from global
   `valueArrays`

Modify `computeCollectionStats()`:

1. Build `perLanguage` as `Map<string, Map<string, ScopedSignalStats>>`
2. For each language, compute `source` and `test` stats separately via
   `computePerSignalStats()`
3. `test` stats are `undefined` if no test values for that language

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/domains/ingest/collection-stats.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/domains/ingest/collection-stats.ts tests/core/domains/ingest/collection-stats.test.ts
git commit -m "feat(ingest): scope-aware signal stats computation (source vs test)"
```

---

### Task 4: StatsCache v5

**Files:**

- Modify: `src/core/infra/stats-cache.ts`
- Modify: `tests/core/infra/stats-cache.test.ts` (or create if missing)

- [ ] **Step 1: Write the failing tests**

```typescript
describe("StatsCache v5 — scoped stats", () => {
  it("round-trips ScopedSignalStats through save/load", () => {
    // Save with ScopedSignalStats, load back, verify structure
  });

  it("migrates v4 cache to ScopedSignalStats (source only, test undefined)", () => {
    // Write a v4 JSON file manually, load via StatsCache, verify migration
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement v5 serialization**

1. Bump `CURRENT_VERSION` to 5
2. Update `StatsFileContent` type:
   ```typescript
   perLanguage: Record<
     string,
     Record<string, { source: SignalStats; test?: SignalStats }>
   >;
   ```
3. `save()`: serialize `ScopedSignalStats` directly
4. `load()`: if `version === 4`, wrap each `SignalStats` as
   `{ source: existingStats }`. If `version === 5`, deserialize as-is.

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add src/core/infra/stats-cache.ts tests/core/infra/stats-cache.test.ts
git commit -m "feat(infra): StatsCache v5 with ScopedSignalStats serialization"
```

---

### Task 5: Reranker Scope-Aware Label Resolution

**Files:**

- Modify: `src/core/domains/explore/reranker.ts`
- Modify: `tests/core/domains/explore/reranker.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to existing reranker label resolution tests:

```typescript
it("uses test scope thresholds for test chunks", () => {
  const stats: CollectionSignalStats = {
    perSignal: new Map(),
    perLanguage: new Map([
      [
        "ruby",
        new Map([
          [
            "git.file.commitCount",
            {
              source: {
                count: 100,
                min: 1,
                max: 30,
                percentiles: { 25: 2, 50: 5, 75: 10, 95: 25 },
              },
              test: {
                count: 50,
                min: 1,
                max: 80,
                percentiles: { 25: 5, 50: 12, 75: 25, 95: 60 },
              },
            },
          ],
        ]),
      ],
    ]),
    distributions: {
      /* ... */
    },
    computedAt: Date.now(),
  };
  reranker.setCollectionStats(stats);

  // Test chunk with commitCount: 10 should get "typical" (test p50=12)
  // not "high" (source p75=10)
  const testResult = reranker.rerank(
    [
      {
        score: 0.8,
        payload: {
          relativePath: "spec/models/user_spec.rb",
          language: "ruby",
          chunkType: "test",
          git: { file: { commitCount: 10 } },
          startLine: 1,
          endLine: 50,
        },
      },
    ],
    "techDebt",
    "semantic_search",
  );

  const overlay = testResult[0].rankingOverlay!;
  expect(overlay.file!.commitCount).toEqual({ value: 10, label: "typical" });
});

it("uses source scope thresholds for source chunks", () => {
  // Same stats, source chunk with commitCount: 10 should get "high" (source p75=10)
});
```

- [ ] **Step 2: Run tests to verify they fail**

- [ ] **Step 3: Implement scope-aware label resolution**

In `applyLabelResolution()`:

1. Import `detectScope` from `../../infra/scope-detection.js`
2. Extract `chunkType` and `relativePath` from the result payload (already
   available in `buildOverlay()` caller context — pass as parameter)
3. Call `detectScope()` → get `"source"` or `"test"`
4. Get `ScopedSignalStats` from `langStats.get(fullKey)`
5. Select `scopedStats.source` or `scopedStats.test` based on scope
6. Fallback: if test stats undefined → use source stats

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Run full test suite**

Run: `npx vitest run` Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/explore/reranker.ts tests/core/domains/explore/reranker.test.ts
git commit -m "feat(rerank): scope-aware label resolution (source vs test thresholds)"
```

---

### Task 6: `get_index_metrics` Scoped Output

**Files:**

- Modify: `src/core/api/public/dto/metrics.ts`
- Modify: `src/core/api/internal/facades/explore-facade.ts`
- Modify: `tests/core/api/get-index-metrics.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
it("returns scoped signal metrics per language", async () => {
  // Mock stats with ScopedSignalStats
  // Verify output has signals.ruby["git.file.commitCount"].source and .test
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Update `SignalMetrics` DTO**

In `metrics.ts`, change `signals` type:

```typescript
export interface IndexMetrics {
  collection: string;
  totalChunks: number;
  totalFiles: number;
  distributions: Distributions;
  /** Signal stats: language → signal → scope → metrics. */
  signals: Record<string, Record<string, Record<string, SignalMetrics>>>;
}
```

- [ ] **Step 4: Update `getIndexMetrics()` in explore-facade.ts**

Modify `buildSignalMetrics` to accept `Map<string, ScopedSignalStats>` and
produce `Record<string, Record<string, SignalMetrics>>` (signal → scope →
metrics).

```typescript
const buildScopedSignalMetrics = (
  langStats: Map<string, ScopedSignalStats>,
): Record<string, Record<string, SignalMetrics>> => {
  const result: Record<string, Record<string, SignalMetrics>> = {};
  for (const [key, scopedStats] of langStats) {
    const descriptor = descriptors.find((d) => d.key === key);
    if (!descriptor?.stats?.labels) continue;

    const scoped: Record<string, SignalMetrics> = {};
    scoped["source"] = buildSingleSignalMetrics(scopedStats.source, descriptor);
    if (scopedStats.test) {
      scoped["test"] = buildSingleSignalMetrics(scopedStats.test, descriptor);
    }
    result[key] = scoped;
  }
  return result;
};
```

- [ ] **Step 5: Run tests to verify they pass**

- [ ] **Step 6: Commit**

```bash
git add src/core/api/public/dto/metrics.ts src/core/api/internal/facades/explore-facade.ts tests/core/api/get-index-metrics.test.ts
git commit -m "feat(api): scoped signal metrics in get_index_metrics output"
```

---

### Task 7: Integration Verification

- [ ] **Step 1: Run full test suite**

Run: `npx vitest run` Expected: All tests pass

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit` Expected: No errors

- [ ] **Step 3: Build**

Run: `npm run build` Expected: Clean build

- [ ] **Step 4: Commit spec + plan**

```bash
git add docs/superpowers/specs/2026-03-26-scoped-signal-stats-design.md \
        docs/superpowers/plans/2026-03-26-scoped-signal-stats.md
git commit -m "docs(specs): scoped signal statistics design and plan"
```

---

## Verification

After all tasks complete:

1. **MCP reconnect** — rebuild + restart tea-rags server
2. **Reindex** — `/tea-rags:force-reindex` on a codebase with tests
3. **Check metrics** — `get_index_metrics` should show `source`/`test` splits
   per signal per language
4. **Check overlay** — `rank_chunks` with `hotspots` preset, compare labels for
   test vs source chunks — thresholds should differ
5. **Verify test_setup exclusion** — `test_setup` chunks should not contribute
   to either scope's stats
