# Per-Language Signal Statistics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compute signal statistics per language so labels and thresholds
reflect each language's own distribution, not a global mix.

**Architecture:** `computeCollectionStats()` groups values by language, stores
per-language `Map<string, SignalStats>` alongside global. `Reranker` uses
per-language stats for label resolution with global fallback. API returns
`signals: { global: {...}, typescript: {...} }`.

**Tech Stack:** TypeScript, Vitest

**Spec:**
`docs/superpowers/specs/2026-03-26-per-language-signal-stats-design.md`

---

### Task 1: Add `perLanguage` to `CollectionSignalStats` type

**Files:**

- Modify: `src/core/contracts/types/trajectory.ts:82-86`

- [ ] **Step 1: Add perLanguage field to CollectionSignalStats**

```typescript
// In CollectionSignalStats interface, add after perSignal:
export interface CollectionSignalStats {
  perSignal: Map<string, SignalStats>;
  /** Per-language signal stats. Key = language name, value = signal stats map. */
  perLanguage: Map<string, Map<string, SignalStats>>;
  distributions: Distributions;
  computedAt: number;
}
```

- [ ] **Step 2: Run type check to see what breaks**

Run: `npx tsc --noEmit 2>&1 | head -30` Expected: Compilation errors in
`collection-stats.ts`, `stats-cache.ts`, `explore-facade.ts` and tests — all
places that construct `CollectionSignalStats` without `perLanguage`.

- [ ] **Step 3: Commit**

```bash
git add src/core/contracts/types/trajectory.ts
git commit -m "feat(contracts): add perLanguage to CollectionSignalStats type"
```

---

### Task 2: Per-language stats computation in `collection-stats.ts`

**Files:**

- Modify: `src/core/domains/ingest/collection-stats.ts`
- Test: `tests/core/domains/ingest/collection-stats.test.ts`

- [ ] **Step 1: Write failing tests for per-language stats**

Add to `tests/core/domains/ingest/collection-stats.test.ts`:

```typescript
describe("per-language stats", () => {
  it("should compute per-language signal stats grouped by chunk language", () => {
    // 10 typescript chunks with commitCount 1-10, 10 python chunks with commitCount 11-20
    const points = [
      ...Array.from({ length: 10 }, (_, i) => ({
        payload: {
          "git.file.commitCount": i + 1,
          language: "typescript",
          chunkType: "function",
          isDocumentation: false,
          relativePath: `ts${i}.ts`,
        },
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        payload: {
          "git.file.commitCount": i + 11,
          language: "python",
          chunkType: "function",
          isDocumentation: false,
          relativePath: `py${i}.py`,
        },
      })),
    ];
    const result = computeCollectionStats(points, testSignals);

    // Global: all 20 values 1-20
    const global = result.perSignal.get("git.file.commitCount")!;
    expect(global.count).toBe(20);
    expect(global.min).toBe(1);
    expect(global.max).toBe(20);

    // TypeScript: 10 values 1-10
    const tsStats = result.perLanguage
      .get("typescript")
      ?.get("git.file.commitCount");
    expect(tsStats).toBeDefined();
    expect(tsStats!.count).toBe(10);
    expect(tsStats!.min).toBe(1);
    expect(tsStats!.max).toBe(10);

    // Python: 10 values 11-20
    const pyStats = result.perLanguage
      .get("python")
      ?.get("git.file.commitCount");
    expect(pyStats).toBeDefined();
    expect(pyStats!.count).toBe(10);
    expect(pyStats!.min).toBe(11);
    expect(pyStats!.max).toBe(20);
  });

  it("should exclude languages with fewer than 10 chunks from perLanguage", () => {
    // 15 typescript + 5 python (below threshold)
    const points = [
      ...Array.from({ length: 15 }, (_, i) => ({
        payload: {
          "git.file.commitCount": i + 1,
          language: "typescript",
          chunkType: "function",
          isDocumentation: false,
          relativePath: `ts${i}.ts`,
        },
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        payload: {
          "git.file.commitCount": i + 1,
          language: "python",
          chunkType: "function",
          isDocumentation: false,
          relativePath: `py${i}.py`,
        },
      })),
    ];
    const result = computeCollectionStats(points, testSignals);

    expect(result.perLanguage.has("typescript")).toBe(true);
    expect(result.perLanguage.has("python")).toBe(false);
  });

  it("should exclude config languages below 10% threshold", () => {
    // 90 typescript + 10 json (10/110 = 9.1% < 10%) + 10 markdown (10/110 = 9.1% < 10%)
    // Both config languages are below threshold → excluded
    const points = [
      ...Array.from({ length: 90 }, (_, i) => ({
        payload: {
          "git.file.commitCount": i + 1,
          language: "typescript",
          chunkType: "function",
          isDocumentation: false,
          relativePath: `ts${i}.ts`,
        },
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        payload: {
          "git.file.commitCount": i + 1,
          language: "json",
          chunkType: "block",
          isDocumentation: false,
          relativePath: `f${i}.json`,
        },
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        payload: {
          "git.file.commitCount": i + 1,
          language: "markdown",
          chunkType: "block",
          isDocumentation: true,
          relativePath: `doc${i}.md`,
        },
      })),
    ];
    const result = computeCollectionStats(points, testSignals);

    expect(result.perLanguage.has("typescript")).toBe(true);
    // json: 10/110 = 9.1% < 10% → excluded (config language below threshold)
    expect(result.perLanguage.has("json")).toBe(false);
    // markdown: 10/110 = 9.1% < 10% → excluded (config language below threshold)
    expect(result.perLanguage.has("markdown")).toBe(false);
  });

  it("should include config language at exactly 10% threshold", () => {
    // 90 typescript + 10 json (10/100 = 10%)
    const points = [
      ...Array.from({ length: 90 }, (_, i) => ({
        payload: {
          "git.file.commitCount": i + 1,
          language: "typescript",
          chunkType: "function",
          isDocumentation: false,
          relativePath: `ts${i}.ts`,
        },
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        payload: {
          "git.file.commitCount": i + 1,
          language: "json",
          chunkType: "block",
          isDocumentation: false,
          relativePath: `f${i}.json`,
        },
      })),
    ];
    const result = computeCollectionStats(points, testSignals);

    expect(result.perLanguage.has("json")).toBe(true);
  });

  it("should not include chunks without language in any per-language bucket", () => {
    const points = [
      ...Array.from({ length: 10 }, (_, i) => ({
        payload: {
          "git.file.commitCount": i + 1,
          language: "typescript",
          chunkType: "function",
          isDocumentation: false,
          relativePath: `ts${i}.ts`,
        },
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        payload: {
          "git.file.commitCount": 100 + i,
          chunkType: "block",
          isDocumentation: false,
          relativePath: `unknown${i}.txt`,
        },
      })),
    ];
    const result = computeCollectionStats(points, testSignals);

    // Global includes all 15
    expect(result.perSignal.get("git.file.commitCount")!.count).toBe(15);
    // TypeScript only has its 10
    expect(
      result.perLanguage.get("typescript")?.get("git.file.commitCount")?.count,
    ).toBe(10);
    // No bucket for undefined language
    expect(result.perLanguage.size).toBe(1);
  });

  it("should respect chunkTypeFilter in per-language stats", () => {
    const points = [
      ...Array.from({ length: 10 }, (_, i) => ({
        payload: {
          "git.file.commitCount": i + 1,
          methodLines: (i + 1) * 5,
          chunkType: "function",
          language: "typescript",
          isDocumentation: false,
          relativePath: `ts${i}.ts`,
        },
      })),
      ...Array.from({ length: 10 }, (_, i) => ({
        payload: {
          "git.file.commitCount": i + 1,
          methodLines: (i + 1) * 10,
          chunkType: "class", // not "function" — excluded by chunkTypeFilter
          language: "typescript",
          isDocumentation: false,
          relativePath: `ts${i}.ts`,
        },
      })),
    ];
    const result = computeCollectionStats(points, signalsWithChunkFilter);

    // methodLines has chunkTypeFilter: "function", so only 10 function chunks
    const tsMethodLines = result.perLanguage
      .get("typescript")
      ?.get("methodLines");
    expect(tsMethodLines).toBeDefined();
    expect(tsMethodLines!.count).toBe(10);
    expect(tsMethodLines!.min).toBe(5);
    expect(tsMethodLines!.max).toBe(50);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/domains/ingest/collection-stats.test.ts`
Expected: FAIL — `perLanguage` does not exist on result.

- [ ] **Step 3: Implement per-language extraction in `extractSignalValues()`**

In `src/core/domains/ingest/collection-stats.ts`, add config language set and
update `ExtractedValues` + `extractSignalValues()`:

```typescript
// Add after imports:
const CONFIG_LANGUAGES = new Set([
  "json",
  "yaml",
  "markdown",
  "text",
  "gitignore",
  "toml",
  "xml",
  "ini",
  "env",
  "csv",
  "dockerfile",
]);

const MIN_SAMPLE_SIZE = 10;
```

Add to `ExtractedValues` interface:

```typescript
/** Per-language signal value arrays. Key = language, inner key = signal key. */
perLanguageValues: Map<string, Map<string, number[]>>;
```

Refactor `extractSignalValues()` to avoid duplicating the signal extraction
loop. Extract a helper and call it for both global and per-language arrays:

```typescript
/** Push a valid signal value from point into target array. */
function tryPushSignalValue(
  point: { payload: Record<string, unknown> },
  signal: PayloadSignalDescriptor,
  pointChunkType: unknown,
  target: number[],
): void {
  const filter = signal.stats?.chunkTypeFilter;
  if (filter && pointChunkType !== filter) return;
  const val = readPayloadPath(point.payload, signal.key);
  if (typeof val === "number" && val > 0) {
    target.push(val);
  }
}
```

Then in the main loop over points, replace the existing signal extraction block
(lines 86-94) with:

```typescript
const perLanguageValues = new Map<string, Map<string, number[]>>();

for (const point of points) {
  const pointChunkType = point.payload["chunkType"];
  const lang = point.payload["language"];

  for (const signal of statsSignals) {
    // Push to global
    tryPushSignalValue(
      point,
      signal,
      pointChunkType,
      valueArrays.get(signal.key)!,
    );

    // Push to per-language (if language present)
    if (typeof lang === "string") {
      let langMap = perLanguageValues.get(lang);
      if (!langMap) {
        langMap = new Map();
        for (const s of statsSignals) langMap.set(s.key, []);
        perLanguageValues.set(lang, langMap);
      }
      tryPushSignalValue(
        point,
        signal,
        pointChunkType,
        langMap.get(signal.key)!,
      );
    }
  }

  // ... rest of distribution extraction (language counts, chunkType, etc.)
}
```

This ensures each signal value is extracted once per target (global + language),
with identical filter logic, and no O(signals^2) duplication.

- [ ] **Step 4: Implement `computeCollectionStats()` per-language assembly**

After `computePerSignalStats()` call, add per-language computation:

```typescript
// Filter languages: code languages always, config languages only if >= 10%
const totalChunks = points.length;
const perLanguage = new Map<string, Map<string, SignalStats>>();

for (const [lang, langValueArrays] of extracted.perLanguageValues) {
  // Config language check: must be >= 10% of total
  if (CONFIG_LANGUAGES.has(lang)) {
    const langCount = extracted.languageCounts[lang] ?? 0;
    if (langCount / totalChunks < 0.1) continue;
  }

  // Check minimum sample size: at least one signal must have >= MIN_SAMPLE_SIZE values
  const hasEnoughSamples = [...langValueArrays.values()].some(
    (arr) => arr.length >= MIN_SAMPLE_SIZE,
  );
  if (!hasEnoughSamples) continue;

  const langStats = computePerSignalStats(langValueArrays, statsSignals);
  if (langStats.size > 0) {
    perLanguage.set(lang, langStats);
  }
}

return {
  perSignal,
  perLanguage,
  distributions,
  computedAt: Date.now(),
};
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/core/domains/ingest/collection-stats.test.ts`
Expected: All tests PASS including new per-language tests.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/ingest/collection-stats.ts tests/core/domains/ingest/collection-stats.test.ts
git commit -m "feat(ingest): compute per-language signal statistics"
```

---

### Task 3: StatsCache v4 with `perLanguage` serialization

**Files:**

- Modify: `src/core/infra/stats-cache.ts`
- Test: `tests/core/infra/stats-cache.test.ts` (find or create)

- [ ] **Step 1: Write failing test**

Find existing stats-cache tests or create new file. Test that save+load
round-trips `perLanguage`:

```typescript
it("should round-trip perLanguage through save/load", () => {
  const perLanguage = new Map([
    [
      "typescript",
      new Map([
        [
          "git.file.commitCount",
          { count: 100, min: 1, max: 30, percentiles: { 25: 3, 75: 15 } },
        ],
      ]),
    ],
  ]);
  const stats: CollectionSignalStats = {
    perSignal: new Map(),
    perLanguage,
    distributions: {
      totalFiles: 0,
      language: {},
      chunkType: {},
      documentation: { docs: 0, code: 0 },
      topAuthors: [],
      othersCount: 0,
    },
    computedAt: Date.now(),
  };
  cache.save("test_col", stats);
  const loaded = cache.load("test_col");
  expect(loaded).not.toBeNull();
  expect(loaded!.perLanguage).toBeDefined();
  const tsStats = loaded!.perLanguage!.get("typescript");
  expect(tsStats).toBeDefined();
  expect(tsStats!.get("git.file.commitCount")?.count).toBe(100);
});

it("should discard v3 cache and return null", () => {
  // Write a v3-format file manually
  const v3Content = JSON.stringify({
    version: 3,
    collectionName: "test_col",
    computedAt: Date.now(),
    perSignal: {},
    distributions: {
      totalFiles: 0,
      language: {},
      chunkType: {},
      documentation: { docs: 0, code: 0 },
      topAuthors: [],
      othersCount: 0,
    },
  });
  writeFileSync(join(tmpDir, "test_col.stats.json"), v3Content);
  const loaded = cache.load("test_col");
  expect(loaded).toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/infra/stats-cache.test.ts` Expected: FAIL.

- [ ] **Step 3: Update StatsCache to v4**

In `src/core/infra/stats-cache.ts`:

```typescript
interface StatsFileContent {
  version: 4; // was 3
  collectionName: string;
  computedAt: number;
  perSignal: Record<string, SignalStats>;
  perLanguage: Record<string, Record<string, SignalStats>>; // NEW
  distributions: Distributions;
  payloadFieldKeys?: string[];
}

const CURRENT_VERSION = 4; // was 3
```

Update `load()`:

```typescript
return {
  perSignal: new Map(Object.entries(data.perSignal)),
  perLanguage: new Map(
    Object.entries(data.perLanguage ?? {}).map(([lang, signals]) => [
      lang,
      new Map(Object.entries(signals)),
    ]),
  ),
  distributions: data.distributions,
  computedAt: data.computedAt,
  payloadFieldKeys: data.payloadFieldKeys,
};
```

Update `save()`:

```typescript
const perLanguageObj: Record<string, Record<string, SignalStats>> = {};
for (const [lang, signals] of stats.perLanguage) {
  perLanguageObj[lang] = Object.fromEntries(signals);
}

const content: StatsFileContent = {
  version: CURRENT_VERSION,
  collectionName,
  computedAt: stats.computedAt,
  perSignal: Object.fromEntries(stats.perSignal),
  perLanguage: perLanguageObj,
  distributions: stats.distributions,
  payloadFieldKeys,
};
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/core/infra/stats-cache.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/infra/stats-cache.ts tests/core/infra/stats-cache.test.ts
git commit -m "feat(infra): bump stats cache to v4 with perLanguage support"
```

---

### Task 4: Fix `Reranker.applyLabelResolution()` level context + per-language

**Files:**

- Modify: `src/core/domains/explore/reranker.ts:380-420`
- Test: `tests/core/domains/explore/reranker.test.ts`

- [ ] **Step 1: Write failing tests**

Add to `tests/core/domains/explore/reranker.test.ts` in the "label resolution"
describe block:

```typescript
it("resolves chunk overlay labels using chunk-level percentiles, not file-level", () => {
  // Setup: file.commitCount p75=12, chunk.commitCount p75=4
  // A chunk with commitCount=5 should be "high" at chunk level (5>=4)
  // but only "typical" at file level (5>=5 but <12)
  const collectionStats = {
    perSignal: new Map([
      [
        "git.file.commitCount",
        {
          count: 500,
          min: 1,
          max: 50,
          percentiles: { 25: 2, 50: 5, 75: 12, 95: 30 },
        },
      ],
      [
        "git.chunk.commitCount",
        {
          count: 500,
          min: 1,
          max: 20,
          percentiles: { 25: 1, 50: 2, 75: 4, 95: 10 },
        },
      ],
    ]),
    perLanguage: new Map(),
    distributions: {
      totalFiles: 100,
      language: {},
      chunkType: {},
      documentation: { docs: 0, code: 0 },
      topAuthors: [],
      othersCount: 0,
    },
    computedAt: Date.now(),
  };
  rerankerWithLabels.setCollectionStats(collectionStats);

  // NOTE: Before writing this test, verify which preset exposes chunk-level
  // signals in its overlayMask. Check existing presets with:
  //   rg "overlayMask" src/core/domains/trajectory/git/rerank/presets/
  // If no preset has chunk mask, either use custom weights (which auto-expose
  // raw sources for all active weights) or create a test-only preset with
  // overlayMask: { chunk: ["commitCount"] }.
  //
  // Use custom weights approach as fallback — it exposes raw sources for all
  // weight keys without needing a specific preset mask:
  const results = [
    makeResult({ file: { commitCount: 5 }, chunk: { commitCount: 5 } }),
  ];
  const ranked = rerankerWithLabels.rerank(
    results,
    { custom: { churn: 1.0 } }, // custom weights → overlay shows all raw sources
    "semantic_search",
  );
  const overlay = ranked[0].rankingOverlay!;

  // File overlay: commitCount=5 >= p50 threshold=5 → "typical"
  if (overlay.file?.commitCount) {
    const resolved = overlay.file.commitCount as {
      value: number;
      label: string;
    };
    expect(resolved.label).toBe("typical");
  }

  // Chunk overlay: commitCount=5 >= p75 threshold=4 → "high"
  if (overlay.chunk?.commitCount) {
    const resolved = overlay.chunk.commitCount as {
      value: number;
      label: string;
    };
    expect(resolved.label).toBe("high");
  }
});

it("uses per-language percentiles when available", () => {
  const collectionStats = {
    perSignal: new Map([
      [
        "git.file.commitCount",
        {
          count: 500,
          min: 1,
          max: 50,
          percentiles: { 25: 2, 50: 5, 75: 12, 95: 30 },
        },
      ],
    ]),
    perLanguage: new Map([
      [
        "ruby",
        new Map([
          [
            "git.file.commitCount",
            {
              count: 200,
              min: 1,
              max: 20,
              percentiles: { 25: 1, 50: 3, 75: 6, 95: 15 },
            },
          ],
        ]),
      ],
    ]),
    distributions: {
      totalFiles: 100,
      language: {},
      chunkType: {},
      documentation: { docs: 0, code: 0 },
      topAuthors: [],
      othersCount: 0,
    },
    computedAt: Date.now(),
  };
  rerankerWithLabels.setCollectionStats(collectionStats);

  // Ruby chunk: commitCount=7, ruby p75=6 → "high" (per-language)
  // Global p75=12 → would be "typical" (global)
  const results = [makeResult({ file: { commitCount: 7 } })];
  results[0].payload = { ...results[0].payload, language: "ruby" };
  const ranked = rerankerWithLabels.rerank(
    results,
    "techDebt",
    "semantic_search",
  );
  const overlay = ranked[0].rankingOverlay!;
  const resolved = overlay.file?.commitCount as {
    value: number;
    label: string;
  };
  expect(resolved.label).toBe("high"); // per-language, not "typical" from global
});

it("falls back to global when language not in perLanguage", () => {
  const collectionStats = {
    perSignal: new Map([
      [
        "git.file.commitCount",
        {
          count: 500,
          min: 1,
          max: 50,
          percentiles: { 25: 2, 50: 5, 75: 12, 95: 30 },
        },
      ],
    ]),
    perLanguage: new Map(), // empty — no per-language stats
    distributions: {
      totalFiles: 100,
      language: {},
      chunkType: {},
      documentation: { docs: 0, code: 0 },
      topAuthors: [],
      othersCount: 0,
    },
    computedAt: Date.now(),
  };
  rerankerWithLabels.setCollectionStats(collectionStats);

  const results = [makeResult({ file: { commitCount: 7 } })];
  results[0].payload = { ...results[0].payload, language: "go" };
  const ranked = rerankerWithLabels.rerank(
    results,
    "techDebt",
    "semantic_search",
  );
  const overlay = ranked[0].rankingOverlay!;
  const resolved = overlay.file?.commitCount as {
    value: number;
    label: string;
  };
  // Global p50=5, p75=12 → 7>=5 → "typical"
  expect(resolved.label).toBe("typical");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/explore/reranker.test.ts -t "label resolution"`
Expected: FAIL — level/per-language not implemented.

- [ ] **Step 3: Update `applyLabelResolution()` signature and implementation**

In `src/core/domains/explore/reranker.ts`, change `applyLabelResolution()`:

```typescript
private applyLabelResolution(
  overlay: Record<string, unknown>,
  level: "file" | "chunk",
  language?: string,
): void {
  if (!this.collectionStats) return;

  for (const field of Object.keys(overlay)) {
    const value = overlay[field];
    if (typeof value !== "number") continue;

    // Resolve full payload key: try level-prefixed first, then bare
    const fullKey =
      this.signalKeyMap.get(`${level}.${field}`) ??
      this.signalKeyMap.get(field) ??
      null;
    if (!fullKey) continue;

    const descriptor = this.payloadSignals.find((ps) => ps.key === fullKey);
    if (!descriptor?.stats?.labels) continue;

    // Per-language percentiles with global fallback
    const signalStats =
      (language && this.collectionStats.perLanguage?.get(language)?.get(fullKey)) ||
      this.collectionStats.perSignal.get(fullKey);
    if (!signalStats?.percentiles) continue;

    const label = resolveLabel(value, descriptor.stats.labels, signalStats.percentiles);
    overlay[field] = { value, label };
  }
}
```

- [ ] **Step 4: Update `buildOverlay()` call sites**

In `buildOverlay()`, change the two `applyLabelResolution` calls (around line
380-382):

```typescript
// Read language from result payload
const language =
  typeof result.payload?.["language"] === "string"
    ? (result.payload["language"] as string)
    : undefined;

// Post-process: resolve labels for numeric signals with stats.labels
this.applyLabelResolution(rawFile, "file", language);
this.applyLabelResolution(rawChunk, "chunk", language);
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/core/domains/explore/reranker.test.ts` Expected: All
tests PASS (existing + new).

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/explore/reranker.ts tests/core/domains/explore/reranker.test.ts
git commit -m "fix(rerank): per-language + level-aware label resolution in overlay"
```

---

### Task 5: Update `IndexMetrics` DTO and `ExploreFacade.getIndexMetrics()`

**Files:**

- Modify: `src/core/api/public/dto/metrics.ts`
- Modify: `src/core/api/internal/facades/explore-facade.ts:292-341`
- Test: `tests/core/api/dto/metrics.test.ts`
- Test: `tests/core/api/get-index-metrics.test.ts`

- [ ] **Step 1: Update DTO type**

In `src/core/api/public/dto/metrics.ts`:

```typescript
/** Collection-level metrics returned by get_index_metrics MCP tool. */
export interface IndexMetrics {
  collection: string;
  totalChunks: number;
  totalFiles: number;
  distributions: Distributions;
  /** Signal stats grouped by language. "global" = all languages combined. */
  signals: Record<string, Record<string, SignalMetrics>>;
}
```

- [ ] **Step 2: Update DTO test**

In `tests/core/api/dto/metrics.test.ts`, update shape to nested structure:

```typescript
it("should have correct shape", () => {
  const metrics: IndexMetrics = {
    collection: "code_abc123",
    totalChunks: 1709,
    totalFiles: 314,
    distributions: {
      totalFiles: 314,
      language: { typescript: 1200 },
      chunkType: { function: 800 },
      documentation: { docs: 150, code: 1559 },
      topAuthors: [{ name: "Alice", chunks: 1400 }],
      othersCount: 309,
    },
    signals: {
      global: {
        "git.file.commitCount": {
          min: 1,
          max: 47,
          count: 1709,
          labelMap: { low: 2, typical: 5, high: 12, extreme: 30 },
        },
      },
      typescript: {
        "git.file.commitCount": {
          min: 1,
          max: 47,
          count: 1200,
          labelMap: { low: 3, typical: 6, high: 14, extreme: 35 },
        },
      },
    },
  };
  expect(metrics.collection).toBe("code_abc123");
  expect(metrics.signals["global"]["git.file.commitCount"].labelMap.high).toBe(
    12,
  );
  expect(
    metrics.signals["typescript"]["git.file.commitCount"].labelMap.high,
  ).toBe(14);
});

it("should allow optional mean", () => {
  const metrics: IndexMetrics = {
    collection: "test",
    totalChunks: 0,
    totalFiles: 0,
    distributions: {
      totalFiles: 0,
      language: {},
      chunkType: {},
      documentation: { docs: 0, code: 0 },
      topAuthors: [],
      othersCount: 0,
    },
    signals: {
      global: {
        "test.signal": {
          min: 0,
          max: 0,
          mean: 5.2,
          count: 0,
          labelMap: {},
        },
      },
    },
  };
  expect(metrics.signals["global"]["test.signal"].mean).toBe(5.2);
});
```

- [ ] **Step 3: Update `get-index-metrics.test.ts`**

Update `makeExploreFacade()` mock to include `perLanguage` in statsCache, and
update assertions to access `signals.global`:

In the `statsCache.load` mock, add `perLanguage`:

```typescript
const perLanguage = new Map([
  [
    "typescript",
    new Map([
      [
        "git.file.commitCount",
        {
          count: 80,
          min: 1,
          max: 40,
          percentiles: { 25: 3, 50: 7, 75: 15, 95: 35 },
          mean: 10.1,
        },
      ],
    ]),
  ],
]);

const statsCache = {
  load: vi.fn().mockReturnValue({
    perSignal,
    perLanguage,
    distributions,
    computedAt: Date.now(),
  }),
} as any;
```

Update test assertions:

```typescript
it("returns signals with global and per-language labelMaps", async () => {
  const { facade } = makeExploreFacade();
  const result = await facade.getIndexMetrics("/project");

  // Global signals
  const globalSignal = result.signals["global"]["git.file.commitCount"];
  expect(globalSignal).toBeDefined();
  expect(globalSignal.min).toBe(1);
  expect(globalSignal.max).toBe(47);
  expect(globalSignal.mean).toBe(8.3);
  expect(globalSignal.count).toBe(100);
  expect(globalSignal.labelMap.low).toBe(2);
  expect(globalSignal.labelMap.typical).toBe(5);
  expect(globalSignal.labelMap.high).toBe(12);
  expect(globalSignal.labelMap.extreme).toBe(30);

  // Per-language signals
  const tsSignal = result.signals["typescript"]["git.file.commitCount"];
  expect(tsSignal).toBeDefined();
  expect(tsSignal.count).toBe(80);
  expect(tsSignal.labelMap.low).toBe(3);
  expect(tsSignal.labelMap.high).toBe(15);
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run:
`npx vitest run tests/core/api/dto/metrics.test.ts tests/core/api/get-index-metrics.test.ts`
Expected: FAIL.

- [ ] **Step 5: Update `ExploreFacade.getIndexMetrics()`**

Extract signal-building into a helper, call for global and each language:

```typescript
async getIndexMetrics(path: string): Promise<IndexMetrics> {
  const absolutePath = await validatePath(path);
  const collectionName = resolveCollectionName(absolutePath);

  if (!(await this.qdrant.collectionExists(collectionName))) {
    throw new DomainCollectionNotFoundError(collectionName);
  }

  await this.ensureStats(collectionName);

  const stats = this.statsCache?.load(collectionName);
  if (!stats) {
    throw new NotIndexedError(path);
  }

  const collectionInfo = await this.qdrant.getCollectionInfo(collectionName);
  const descriptors = this.payloadSignals;

  const buildSignalMetrics = (
    perSignal: Map<string, SignalStats>,
  ): Record<string, SignalMetrics> => {
    const result: Record<string, SignalMetrics> = {};
    for (const [key, signalStats] of perSignal) {
      const descriptor = descriptors.find((d) => d.key === key);
      if (!descriptor?.stats?.labels) continue;

      const labelMap: Record<string, number> = {};
      for (const [pKey, labelName] of Object.entries(descriptor.stats.labels)) {
        const p = Number(pKey.slice(1));
        const threshold = signalStats.percentiles[p];
        if (threshold !== undefined) {
          labelMap[labelName] = threshold;
        }
      }

      result[key] = {
        min: signalStats.min,
        max: signalStats.max,
        mean: signalStats.mean,
        count: signalStats.count,
        labelMap,
      };
    }
    return result;
  };

  const signals: Record<string, Record<string, SignalMetrics>> = {
    global: buildSignalMetrics(stats.perSignal),
  };

  if (stats.perLanguage) {
    for (const [lang, langStats] of stats.perLanguage) {
      signals[lang] = buildSignalMetrics(langStats);
    }
  }

  return {
    collection: collectionName,
    totalChunks: collectionInfo.pointsCount,
    totalFiles: stats.distributions.totalFiles,
    distributions: stats.distributions,
    signals,
  };
}
```

- [ ] **Step 6: Run tests**

Run:
`npx vitest run tests/core/api/dto/metrics.test.ts tests/core/api/get-index-metrics.test.ts`
Expected: All PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/api/public/dto/metrics.ts src/core/api/internal/facades/explore-facade.ts tests/core/api/dto/metrics.test.ts tests/core/api/get-index-metrics.test.ts
git commit -m "$(cat <<'EOF'
feat(api): per-language signals in get_index_metrics response

BREAKING CHANGE: get_index_metrics signals format changed from
Record<signalKey, SignalMetrics> to Record<language, Record<signalKey, SignalMetrics>>.
Global stats are now under signals["global"]. Per-language stats under signals["typescript"] etc.
Consumers must update to access signals.global instead of signals directly.
EOF
)"
```

---

### Task 6: Fix all remaining compile errors + full test suite

**Files:**

- Any files with `CollectionSignalStats` construction that lack `perLanguage`

- [ ] **Step 1: Run full type check**

Run: `npx tsc --noEmit 2>&1 | head -50` Expected: May show errors in test files
that construct `CollectionSignalStats` mocks without `perLanguage`.

- [ ] **Step 2: Fix all remaining type errors**

Add `perLanguage: new Map()` to all `CollectionSignalStats` mock objects in
tests. These are in:

- `tests/core/domains/explore/reranker.test.ts` (multiple `collectionStats`
  objects in dampening/adaptive bounds tests)
- Any other test constructing `CollectionSignalStats`

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run` Expected: All tests PASS.

- [ ] **Step 4: Commit**

```bash
# Stage only test files that were fixed (verify with git diff --name-only first)
git add tests/
git commit -m "fix(test): add perLanguage to all CollectionSignalStats mocks"
```

---

### Task 7: Update skills that parse `get_index_metrics`

**Files:**

- Modify: `plugin/skills/*/SKILL.md` files that reference `signals` from
  `get_index_metrics`

- [ ] **Step 1: Find all skill files referencing signals/labelMap**

Run: `rg -l "labelMap\|get_index_metrics\|signals\." plugin/skills/`

- [ ] **Step 2: Update each skill to use `signals.global` or language-specific**

Where skills parse `signals["git.file.commitCount"]`, update to
`signals["global"]["git.file.commitCount"]` or instruct to pick the appropriate
language key.

- [ ] **Step 3: Bump plugin version**

In `plugin/.claude-plugin/plugin.json`, bump minor version (skill behavior
change).

- [ ] **Step 4: Commit**

```bash
git add plugin/
git commit -m "improve(dx): update skills for per-language signals format"
```
