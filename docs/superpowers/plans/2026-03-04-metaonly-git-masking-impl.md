# metaOnly git masking — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Mask git payload in metaOnly results using overlay mask (when
reranking) or essential signals (when not), removing rankingOverlay duplication.

**Architecture:** Add `essential?: boolean` flag to `PayloadSignalDescriptor`.
Git trajectory marks ageDays/commitCount as essential. Formatter uses overlay
data or essential fields to build compact git. Pure presentation change —
reranker untouched.

**Tech Stack:** TypeScript, Vitest, Qdrant payload signals

---

### Task 1: Add `essential` flag to PayloadSignalDescriptor

**Files:**

- Modify: `src/core/contracts/types/trajectory.ts:19-28`
- Test: `tests/mcp/tools/formatters/search-pipeline.test.ts` (tested via Task 4)

**Step 1: Add the optional field**

In `src/core/contracts/types/trajectory.ts`, add `essential` to
`PayloadSignalDescriptor`:

```typescript
export interface PayloadSignalDescriptor {
  key: string;
  type: "string" | "number" | "boolean" | "string[]" | "timestamp";
  description: string;
  stats?: SignalStatsRequest;
  /** Include in metaOnly results even without overlay mask. Default: false. */
  essential?: boolean;
}
```

**Step 2: Run type check**

Run: `npx tsc --noEmit` Expected: PASS (optional field, no breakage)

**Step 3: Commit**

```
feat(contracts): add essential flag to PayloadSignalDescriptor
```

---

### Task 2: Mark essential git signals

**Files:**

- Modify: `src/core/trajectory/git/payload-signals.ts:16-26` (file-level) and
  `:86-103` (chunk-level)

**Step 1: Add `essential: true` to 4 signals**

In `src/core/trajectory/git/payload-signals.ts`:

```typescript
// git.file.commitCount (line ~16)
{
  key: "git.file.commitCount",
  type: "number",
  description: "Total commits modifying this file",
  stats: { percentiles: [25, 50, 75, 95] },
  essential: true,
},
// git.file.ageDays (line ~22)
{
  key: "git.file.ageDays",
  type: "number",
  description: "Days since last modification",
  stats: { percentiles: [95] },
  essential: true,
},
// git.chunk.commitCount (line ~92)
{
  key: "git.chunk.commitCount",
  type: "number",
  description: "Commits touching this specific chunk",
  stats: { percentiles: [95] },
  essential: true,
},
// git.chunk.ageDays (line ~99)
{
  key: "git.chunk.ageDays",
  type: "number",
  description: "Days since last modification to this chunk",
  stats: { percentiles: [95] },
  essential: true,
},
```

**Step 2: Run type check**

Run: `npx tsc --noEmit` Expected: PASS

**Step 3: Commit**

```
feat(trajectory/git): mark ageDays and commitCount as essential signals
```

---

### Task 3: Add registry helper + wire through deps

**Files:**

- Modify: `src/core/trajectory/index.ts:57-64` (after
  getAllPayloadSignalDescriptors)
- Modify: `src/mcp/tools/search.ts:21-26` (SearchToolDependencies)
- Modify: `src/mcp/tools/index.ts:18-25,41-46` (ToolDependencies + wiring)
- Modify: `src/bootstrap/factory.ts:31-38,70-77` (AppContext + wiring)

**Step 1: Add `getEssentialPayloadKeys()` to TrajectoryRegistry**

In `src/core/trajectory/index.ts`, after `getAllPayloadSignalDescriptors()`:

```typescript
/** Payload signal keys marked as essential (always shown in metaOnly). */
getEssentialPayloadKeys(): string[] {
  return this.getAllPayloadSignalDescriptors()
    .filter((s) => s.essential)
    .map((s) => s.key);
}
```

**Step 2: Add to SearchToolDependencies**

In `src/mcp/tools/search.ts`:

```typescript
export interface SearchToolDependencies {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  reranker: Reranker;
  schemaBuilder: SchemaBuilder;
  essentialTrajectoryFields: string[];
}
```

**Step 3: Add to ToolDependencies and wire**

In `src/mcp/tools/index.ts`:

```typescript
export interface ToolDependencies {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  ingest: IngestFacade;
  search: SearchFacade;
  reranker: Reranker;
  schemaBuilder: SchemaBuilder;
  essentialTrajectoryFields: string[];
}
```

And in `registerAllTools`, pass it through:

```typescript
registerSearchTools(server, {
  qdrant: deps.qdrant,
  embeddings: deps.embeddings,
  reranker: deps.reranker,
  schemaBuilder: deps.schemaBuilder,
  essentialTrajectoryFields: deps.essentialTrajectoryFields,
});
```

**Step 4: Wire in AppContext**

In `src/bootstrap/factory.ts`:

Add to `AppContext`:

```typescript
essentialTrajectoryFields: string[];
```

In `createAppContext`, after
`const { registry, reranker, allPayloadSignalDescriptors } = createComposition();`:

```typescript
const essentialTrajectoryFields = registry.getEssentialPayloadKeys();
```

Add to return object and to `registerAllTools` call.

**Step 5: Run type check**

Run: `npx tsc --noEmit` Expected: PASS

**Step 6: Commit**

```
feat(search): wire essentialTrajectoryFields through deps chain
```

---

### Task 4: Implement git masking in formatter (TDD)

**Files:**

- Modify: `src/mcp/tools/formatters/search-pipeline.ts:57-76`
- Modify: `src/mcp/tools/search.ts:58,110` (pass essentialTrajectoryFields)
- Test: `tests/mcp/tools/formatters/search-pipeline.test.ts`

**Step 1: Write failing tests**

Add to `tests/mcp/tools/formatters/search-pipeline.test.ts`:

```typescript
it("should mask git by overlay when metaOnly + rankingOverlay has data", () => {
  const results = [
    {
      id: "1",
      score: 0.9,
      payload: {
        relativePath: "src/a.ts",
        git: {
          file: {
            ageDays: 42,
            commitCount: 18,
            bugFixRate: 33,
            churnVolatility: 0.65,
          },
          chunk: { commitCount: 7, churnRatio: 0.39, ageDays: 5 },
        },
      },
      rankingOverlay: {
        preset: "hotspots",
        file: { bugFixRate: 33, churnVolatility: 0.65 },
        chunk: { commitCount: 7, churnRatio: 0.39 },
      },
    },
  ] as any[];
  const output = formatSearchResults(results, true, [
    "git.file.ageDays",
    "git.file.commitCount",
    "git.chunk.ageDays",
    "git.chunk.commitCount",
  ]);
  const parsed = JSON.parse(output.content[0].text);
  const meta = parsed[0];

  // git masked to overlay data only
  expect(meta.git).toEqual({
    file: { bugFixRate: 33, churnVolatility: 0.65 },
    chunk: { commitCount: 7, churnRatio: 0.39 },
  });
  // preset promoted to top-level
  expect(meta.preset).toBe("hotspots");
  // rankingOverlay removed
  expect(meta).not.toHaveProperty("rankingOverlay");
});

it("should use essential fields when metaOnly + no rankingOverlay", () => {
  const results = [
    {
      id: "1",
      score: 0.9,
      payload: {
        relativePath: "src/a.ts",
        git: {
          file: {
            ageDays: 42,
            commitCount: 18,
            bugFixRate: 33,
            churnVolatility: 0.65,
          },
          chunk: { commitCount: 7, churnRatio: 0.39, ageDays: 5 },
        },
      },
    },
  ] as any[];
  const output = formatSearchResults(results, true, [
    "git.file.ageDays",
    "git.file.commitCount",
    "git.chunk.ageDays",
    "git.chunk.commitCount",
  ]);
  const parsed = JSON.parse(output.content[0].text);
  const meta = parsed[0];

  // git filtered to essential fields only
  expect(meta.git).toEqual({
    file: { ageDays: 42, commitCount: 18 },
    chunk: { ageDays: 5, commitCount: 7 },
  });
  expect(meta).not.toHaveProperty("preset");
  expect(meta).not.toHaveProperty("rankingOverlay");
});

it("should use essential fields when metaOnly + empty overlay (relevance)", () => {
  const results = [
    {
      id: "1",
      score: 0.9,
      payload: {
        relativePath: "src/a.ts",
        git: {
          chunk: { commitCount: 7, churnRatio: 0.39, ageDays: 5 },
        },
      },
      rankingOverlay: { preset: "relevance" },
    },
  ] as any[];
  const output = formatSearchResults(results, true, [
    "git.file.ageDays",
    "git.file.commitCount",
    "git.chunk.ageDays",
    "git.chunk.commitCount",
  ]);
  const parsed = JSON.parse(output.content[0].text);
  const meta = parsed[0];

  // git filtered to essential fields
  expect(meta.git).toEqual({ chunk: { ageDays: 5, commitCount: 7 } });
  expect(meta.preset).toBe("relevance");
  expect(meta).not.toHaveProperty("rankingOverlay");
});

it("should not mask git when metaOnly=false", () => {
  const results = [
    {
      id: "1",
      score: 0.9,
      payload: {
        relativePath: "src/a.ts",
        git: { chunk: { commitCount: 7, churnRatio: 0.39 } },
      },
      rankingOverlay: { preset: "hotspots", chunk: { commitCount: 7 } },
    },
  ] as any[];
  const output = formatSearchResults(results, false, [
    "git.file.ageDays",
    "git.file.commitCount",
    "git.chunk.ageDays",
    "git.chunk.commitCount",
  ]);
  const parsed = JSON.parse(output.content[0].text);

  // Full results unchanged
  expect(parsed[0].payload.git.chunk.churnRatio).toBe(0.39);
  expect(parsed[0].rankingOverlay).toBeDefined();
});
```

**Step 2: Run tests to verify RED**

Run: `npx vitest run tests/mcp/tools/formatters/search-pipeline.test.ts`
Expected: FAIL — new tests fail

**Step 3: Implement masking logic**

In `src/mcp/tools/formatters/search-pipeline.ts`, update `formatSearchResults`:

```typescript
export function formatSearchResults(
  results: SearchResult[],
  metaOnly?: boolean,
  essentialTrajectoryFields?: string[],
): ToolResult {
  if (metaOnly) {
    const metaResults = results.map((r) => {
      const meta: Record<string, unknown> = { score: r.score };
      for (const signal of BASE_PAYLOAD_SIGNALS) {
        if (r.payload?.[signal.key] !== undefined) {
          meta[signal.key] = r.payload[signal.key];
        }
      }

      const overlay = (r as SearchResult & { rankingOverlay?: RankingOverlay })
        .rankingOverlay;
      const fullGit = r.payload?.git as
        | Record<string, Record<string, unknown>>
        | undefined;

      if (overlay && hasOverlayData(overlay)) {
        // Rerank with mask: use overlay data as git
        meta.git = buildGitFromOverlay(overlay);
        meta.preset = overlay.preset;
      } else if (fullGit) {
        // No overlay or empty overlay: filter to essential fields
        meta.git = filterGitByEssential(
          fullGit,
          essentialTrajectoryFields ?? [],
        );
        if (overlay?.preset) meta.preset = overlay.preset;
      }
      // rankingOverlay intentionally excluded

      return meta;
    });
    return {
      content: [{ type: "text", text: JSON.stringify(metaResults, null, 2) }],
    };
  }

  return {
    content: [{ type: "text", text: JSON.stringify(results, null, 2) }],
  };
}
```

Add helper functions:

```typescript
interface RankingOverlay {
  preset: string;
  file?: Record<string, unknown>;
  chunk?: Record<string, unknown>;
}

function hasOverlayData(overlay: RankingOverlay): boolean {
  return Boolean(
    (overlay.file && Object.keys(overlay.file).length > 0) ||
    (overlay.chunk && Object.keys(overlay.chunk).length > 0),
  );
}

function buildGitFromOverlay(overlay: RankingOverlay): Record<string, unknown> {
  const git: Record<string, unknown> = {};
  if (overlay.file && Object.keys(overlay.file).length > 0)
    git.file = overlay.file;
  if (overlay.chunk && Object.keys(overlay.chunk).length > 0)
    git.chunk = overlay.chunk;
  return git;
}

function filterGitByEssential(
  fullGit: Record<string, Record<string, unknown>>,
  essentialKeys: string[],
): Record<string, unknown> {
  const git: Record<string, unknown> = {};
  for (const level of ["file", "chunk"] as const) {
    const levelData = fullGit[level];
    if (!levelData) continue;
    const filtered: Record<string, unknown> = {};
    for (const key of essentialKeys) {
      // key format: "git.file.ageDays" → extract level + field
      const parts = key.split(".");
      if (parts.length === 3 && parts[0] === "git" && parts[1] === level) {
        const field = parts[2];
        if (levelData[field] !== undefined) {
          filtered[field] = levelData[field];
        }
      }
    }
    if (Object.keys(filtered).length > 0) git[level] = filtered;
  }
  return git;
}
```

**Step 4: Update callers to pass essentialTrajectoryFields**

In `src/mcp/tools/search.ts`, update both calls:

```typescript
// Line 58
return formatSearchResults(processed, metaOnly, deps.essentialTrajectoryFields);

// Line 110
return formatSearchResults(processed, metaOnly, deps.essentialTrajectoryFields);
```

**Step 5: Run tests to verify GREEN**

Run: `npx vitest run tests/mcp/tools/formatters/search-pipeline.test.ts`
Expected: ALL PASS

**Step 6: Commit**

```
feat(search): mask git payload in metaOnly by overlay or essential fields
```

---

### Task 5: Full verification

**Step 1: Type check**

Run: `npx tsc --noEmit` Expected: PASS

**Step 2: All tests**

Run: `npx vitest run` Expected: ALL PASS

**Step 3: Commit all**

If any formatting was applied by pre-commit hooks, commit fixups.

---

### Task 6: Manual verification (optional)

Reindex project, then run 3 queries:

1. `semantic_search` with `metaOnly=true, rerank="hotspots"` → git should
   contain only overlay fields
2. `semantic_search` with `metaOnly=true` (no rerank) → git should contain only
   ageDays + commitCount
3. `semantic_search` with `metaOnly=false` → full git + rankingOverlay unchanged
