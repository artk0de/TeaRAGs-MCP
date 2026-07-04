# Trajectory Contracts: Reranker Signals, Filters, Dynamic Schema — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Extend EnrichmentProvider so each trajectory owns its reranker
signals, filters, presets, and payload docs — making the query layer
provider-agnostic.

**Architecture:** Trajectory = Provider + Signals + Filters + Presets.
TrajectoryRegistry in core/api collects contracts from active providers.
Reranker and search-module become generic consumers. MCP schema assembles
dynamically.

**Tech Stack:** TypeScript, Vitest, Qdrant filter types, existing
EnrichmentProvider interface

---

## Status

Approved

## Context

The enrichment provider interface (`EnrichmentProvider`) cleanly abstracts
ingest: coordinator and applier are fully provider-agnostic. However, the
**query layer** (reranker, filters, MCP schema) is hardcoded to git fields:

- **Reranker** — 20+ signals directly reference `git.file.*`, `git.chunk.*`
  fields. `NormalizationBounds`, presets,
  `resolveFileMeta()`/`resolveChunkMeta()` are all git-specific.
- **Filters** — `search-module.ts` hardcodes `git.dominantAuthor`,
  `git.ageDays`, etc. New providers cannot expose filterable fields without
  modifying this central file.
- **MCP schema** — tool descriptions in `schemas.ts` manually list `git.*`
  fields. Adding a provider requires editing schema docs by hand.
- **Business logic violation** — `semantic_search`/`hybrid_search` and reranking
  live in MCP handlers, not in `core/`. The MCP layer should be a thin
  transport.

This design extends `EnrichmentProvider` so each trajectory owns its full query
contract: signal extractors, filters, presets, and payload field documentation.

## Goals

1. Each trajectory declares reranker signals (extractors + bounds)
2. Each trajectory declares typed filters (params → Qdrant conditions)
3. Each trajectory declares its own presets (weight configurations)
4. Cross-trajectory (composite) presets at reranker level can override
   trajectory presets
5. MCP tool schema assembles dynamically from active trajectories
6. Move search/reranking business logic from MCP to `core/api/`
7. Maintain backward compatibility with existing git payload format

## Non-Goals

- Implementing code-graph trajectory (separate epic)
- Changing Qdrant payload structure
- Changing the ingest side of `EnrichmentProvider`

## Architecture

### Extended Provider Interface

```typescript
// core/trajectory/types.ts

interface FileMetadataOverlay {
  [key: string]: unknown;
}

interface ChunkMetadataOverlay {
  [key: string]: unknown;
}

interface SignalDescriptor {
  /** Signal name used in presets and custom weights (e.g. "recency", "churn") */
  name: string;
  /** Human-readable description for docs */
  description: string;
  /** Extract signal value (0-1) from a search result payload */
  extract: (payload: Record<string, unknown>) => number;
  /** Default normalization bounds (max value for 0-1 mapping) */
  defaultBound?: number;
  /** Whether signal needs statistical confidence dampening */
  needsConfidence?: boolean;
  /** Field path used to determine confidence (e.g. "git.file.commitCount") */
  confidenceField?: string;
}

interface FilterDescriptor {
  /** Parameter name exposed to users (e.g. "author", "minAgeDays") */
  param: string;
  /** Human-readable description */
  description: string;
  /** Parameter type for schema generation */
  type: "string" | "number" | "boolean" | "string[]";
  /** Convert user param value to Qdrant filter condition(s) */
  toCondition: (value: unknown) => QdrantFilterCondition[];
}

interface FieldDoc {
  /** Qdrant payload path (e.g. "git.file.commitCount") */
  key: string;
  /** Data type */
  type: "string" | "number" | "boolean" | "string[]" | "timestamp";
  /** Human-readable description for MCP schema */
  description: string;
}

interface EnrichmentProvider {
  // === INGEST (existing, unchanged) ===
  readonly key: string;
  resolveRoot: (absolutePath: string) => string;
  readonly fileTransform?: FileTransform;
  buildFileMetadata: (
    root: string,
    options?: { paths?: string[] },
  ) => Promise<Map<string, FileMetadataOverlay>>;
  buildChunkMetadata: (
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ) => Promise<Map<string, Map<string, ChunkMetadataOverlay>>>;

  // === QUERY CONTRACTS (new) ===
  /** Reranker signal extractors with normalization bounds */
  readonly signals: SignalDescriptor[];
  /** Typed filter parameters → Qdrant conditions */
  readonly filters: FilterDescriptor[];
  /** Trajectory-owned presets (weight configurations) */
  readonly presets: Record<string, ScoringWeights>;
  /** Payload field documentation for dynamic MCP schema */
  readonly payloadFields: FieldDoc[];
}
```

### File Structure

```
src/
  core/
    trajectory/
      types.ts                    — shared interfaces above
      git/
        provider.ts               — GitEnrichmentProvider (ingest + query contracts)
        signals.ts                — SignalDescriptor[] for git signals
        filters.ts                — FilterDescriptor[] for git filters
        types.ts                  — GitFileMetadata, ChunkChurnOverlay
        infra/
          file-reader.ts          — git log parsing
          git-log-reader.ts       — raw git log I/O
          chunk-reader.ts         — chunk-level churn computation
          metrics.ts              — computeFileMetadata, isBugFixCommit
          cache.ts                — GitEnrichmentCache
    api/
      trajectory-registry.ts      — facade: collect signals/filters/presets from providers
    search/
      reranker.ts                 — generic: receives signals from registry, no git knowledge
      search-module.ts            — receives filters from registry, no git knowledge

  mcp/
    tools/
      schemas.ts                  — dynamic: queries registry for fields/filters/presets

tests/
  core/
    trajectory/
      git/
        provider.test.ts
        signals.test.ts
        filters.test.ts
        infra/
          git-log-reader.test.ts
    api/
      trajectory-registry.test.ts
    search/
      reranker.test.ts            — tests generic signal dispatch
      search-module.test.ts       — tests generic filter dispatch
```

### Trajectory Registry (API Facade)

```typescript
// core/api/trajectory-registry.ts

class TrajectoryRegistry {
  private providers: EnrichmentProvider[] = [];

  register(provider: EnrichmentProvider): void;

  /** All signals from all active trajectories */
  getAllSignals(): SignalDescriptor[];

  /** All filters from all active trajectories */
  getAllFilters(): FilterDescriptor[];

  /**
   * Merged presets: trajectory presets + composite overrides.
   * Composite presets (cross-trajectory) take priority over
   * same-named trajectory presets.
   */
  getAllPresets(): Record<string, ScoringWeights>;

  /** All payload field docs for dynamic MCP schema */
  getAllPayloadFields(): FieldDoc[];

  /** Build Qdrant filter from typed params using registered FilterDescriptors */
  buildFilter(params: Record<string, unknown>): QdrantFilter | undefined;

  /** Get providers for ingest (existing coordinator usage) */
  getProviders(): EnrichmentProvider[];
}
```

Different layers interact only through this registry:

- **Ingest** → `registry.getProviders()` for enrichment
- **Search** → `registry.buildFilter(params)`, `registry.getAllSignals()`
- **Reranker** → `registry.getAllSignals()`, `registry.getAllPresets()`
- **MCP schema** → `registry.getAllPayloadFields()`, `registry.getAllFilters()`

### Generic Reranker

Current `calculateSignals()` hardcodes 20+ git-specific extractions. After
refactor:

```typescript
// core/search/reranker.ts

function calculateSignals(
  result: RerankableResult,
  signals: SignalDescriptor[],
): Record<string, number> {
  const values: Record<string, number> = {
    similarity: result.score,
  };

  for (const signal of signals) {
    const raw = signal.extract(result.payload ?? {});
    values[signal.name] = raw;
    // Confidence dampening applied by extract() if needed
  }

  return values;
}
```

Each trajectory's `signals.ts` exports extractors that know their own payload
structure. The reranker doesn't know about `git.file.ageDays` — it just calls
`extract()`.

Built-in signals (`similarity`, `chunkSize`, `documentation`, `pathRisk`,
`imports`) remain in the reranker as they come from base chunk payload, not
trajectories.

### Cross-Trajectory Presets

Composite presets reference signals from multiple trajectories:

```typescript
// core/search/reranker.ts (or separate composite-presets.ts)

const COMPOSITE_PRESETS: Record<string, ScoringWeights> = {
  // Uses git signals + future code-graph signals
  changeRisk: {
    similarity: 0.2,
    churn: 0.15, // git
    importedBy: 0.15, // code-graph (future)
    complexity: 0.15, // code-graph (future)
    bugFix: 0.1, // git
    volatility: 0.1, // git
    knowledgeSilo: 0.05, // git
  },
};
```

Override rule: if composite preset name matches a trajectory preset name,
composite wins. This lets the system evolve — git trajectory declares
`hotspots`, later a composite `hotspots` can incorporate code-graph signals too.

### Generic Filters in Search

Current `search-module.ts` hardcodes
`if (options?.author) → git.dominantAuthor`. After refactor:

```typescript
// search-module.ts

async searchCode(path: string, query: string, options?: SearchOptions) {
  // ...

  // Build filter from typed params via registry
  const trajectoryFilter = this.registry.buildFilter(options ?? {});

  // Merge with basic filters (fileTypes, documentationOnly)
  const filter = mergeFilters(basicFilter, trajectoryFilter);

  // ...
}
```

`registry.buildFilter()` iterates all registered `FilterDescriptor`s, checks if
the corresponding param exists in options, calls `toCondition()`.

Raw Qdrant filters (from `semantic_search`) remain a separate pass-through
mechanism — they bypass the registry entirely.

### Dynamic MCP Schema

```typescript
// mcp/tools/schemas.ts

function buildFilterDescription(registry: TrajectoryRegistry): string {
  const fields = registry.getAllPayloadFields();
  const filters = registry.getAllFilters();

  let desc = "Available filter fields:\n";
  for (const f of fields) {
    desc += `- ${f.key} (${f.type}): ${f.description}\n`;
  }

  desc += "\nTyped filter parameters:\n";
  for (const f of filters) {
    desc += `- ${f.param} (${f.type}): ${f.description}\n`;
  }

  return desc;
}
```

Tool descriptions regenerate when providers change. No manual maintenance.

### Business Logic Migration (MCP → Core)

Currently `semantic_search` / `hybrid_search` handlers in MCP do:

- Qdrant search call
- Glob filtering
- Reranking
- Result formatting

This moves to `core/api/` or `core/search/`:

- `SearchModule` gains `semanticSearch()` and `hybridSearch()` methods
- MCP handlers become thin: parse params → call core → format response
- Reranking and filtering use registry, not hardcoded git paths

## Migration Map

### Source Files

| Current Path                                                           | New Path                                             | Notes                                                    |
| ---------------------------------------------------------------------- | ---------------------------------------------------- | -------------------------------------------------------- |
| `src/core/ingest/pipeline/enrichment/types.ts`                         | `src/core/trajectory/types.ts`                       | Extend with SignalDescriptor, FilterDescriptor, FieldDoc |
| `src/core/ingest/pipeline/enrichment/trajectory/registry.ts`           | `src/core/api/trajectory-registry.ts`                | Expand to facade with signals/filters/presets/fields     |
| `src/core/ingest/pipeline/enrichment/trajectory/git/provider.ts`       | `src/core/trajectory/git/provider.ts`                | Add signals, filters, presets, payloadFields             |
| `src/core/ingest/pipeline/enrichment/trajectory/git/types.ts`          | `src/core/trajectory/git/types.ts`                   | Extend overlay interfaces                                |
| _(new)_                                                                | `src/core/trajectory/git/signals.ts`                 | Extract signal descriptors from reranker.ts              |
| _(new)_                                                                | `src/core/trajectory/git/filters.ts`                 | Extract filter descriptors from search-module.ts         |
| `src/core/ingest/pipeline/enrichment/trajectory/git/file-reader.ts`    | `src/core/trajectory/git/infra/file-reader.ts`       | No changes                                               |
| `src/core/ingest/pipeline/enrichment/trajectory/git/git-log-reader.ts` | `src/core/trajectory/git/infra/git-log-reader.ts`    | No changes                                               |
| `src/core/ingest/pipeline/enrichment/trajectory/git/chunk-reader.ts`   | `src/core/trajectory/git/infra/chunk-reader.ts`      | No changes                                               |
| `src/core/ingest/pipeline/enrichment/trajectory/git/metrics.ts`        | `src/core/trajectory/git/infra/metrics.ts`           | No changes                                               |
| `src/core/ingest/pipeline/enrichment/trajectory/git/cache.ts`          | `src/core/trajectory/git/infra/cache.ts`             | No changes                                               |
| `src/core/ingest/pipeline/enrichment/applier.ts`                       | `src/core/ingest/pipeline/enrichment/applier.ts`     | Stays — ingest infrastructure                            |
| `src/core/ingest/pipeline/enrichment/coordinator.ts`                   | `src/core/ingest/pipeline/enrichment/coordinator.ts` | Stays — uses registry.getProviders()                     |
| `src/core/ingest/pipeline/enrichment/utils.ts`                         | `src/core/trajectory/git/infra/utils.ts`             | extractTaskIds — git-specific util                       |
| `src/core/search/reranker.ts`                                          | `src/core/search/reranker.ts`                        | Refactor: remove git types, use SignalDescriptor[]       |
| `src/core/search/search-module.ts`                                     | `src/core/search/search-module.ts`                   | Refactor: remove git filters, use registry.buildFilter() |

### Test Files

| Current Path                                                                  | New Path                                                 |
| ----------------------------------------------------------------------------- | -------------------------------------------------------- |
| `tests/core/ingest/pipeline/enrichment/trajectory/git/provider.test.ts`       | `tests/core/trajectory/git/provider.test.ts`             |
| `tests/core/ingest/pipeline/enrichment/trajectory/git/git-log-reader.test.ts` | `tests/core/trajectory/git/infra/git-log-reader.test.ts` |
| `tests/core/ingest/pipeline/enrichment/trajectory/registry.test.ts`           | `tests/core/api/trajectory-registry.test.ts`             |
| `tests/core/ingest/pipeline/enrichment/applier.test.ts`                       | _(stays)_                                                |
| `tests/core/ingest/pipeline/enrichment/coordinator.test.ts`                   | _(stays)_                                                |
| `tests/core/ingest/pipeline/enrichment/utils.test.ts`                         | `tests/core/trajectory/git/infra/utils.test.ts`          |
| `tests/core/search/reranker.test.ts`                                          | _(stays, update tests for generic dispatch)_             |
| `tests/core/search/search-module.test.ts`                                     | _(stays, update tests for generic filters)_              |
| _(new)_                                                                       | `tests/core/trajectory/git/signals.test.ts`              |
| _(new)_                                                                       | `tests/core/trajectory/git/filters.test.ts`              |

## Git Trajectory: Concrete Signal Descriptors

For reference, the git trajectory will declare these signals (extracted from
current reranker):

| Signal             | Payload Path                           | Bound | Invert | Confidence |
| ------------------ | -------------------------------------- | ----- | ------ | ---------- |
| recency            | git.file.ageDays                       | 365   | yes    | no         |
| stability          | git.file.commitCount                   | 50    | yes    | no         |
| churn              | git.file.commitCount                   | 50    | no     | no         |
| age                | git.file.ageDays                       | 365   | no     | no         |
| ownership          | git.file.dominantAuthorPct / authors   | —     | no     | yes        |
| bugFix             | git.file.bugFixRate / chunk.bugFixRate | 100   | no     | yes        |
| volatility         | git.file.churnVolatility               | 60    | no     | yes        |
| density            | git.file.changeDensity                 | 20    | no     | yes        |
| chunkChurn         | git.chunk.commitCount                  | 30    | no     | no         |
| relativeChurnNorm  | git.file.relativeChurn                 | 5.0   | no     | yes        |
| burstActivity      | git.file.recencyWeightedFreq           | 10.0  | no     | no         |
| knowledgeSilo      | git.file.contributorCount              | —     | no     | yes        |
| chunkRelativeChurn | git.chunk.churnRatio                   | 1.0   | no     | no         |
| blockPenalty       | chunkType + git.chunk presence         | —     | no     | no         |

Built-in signals (not trajectory-owned): `similarity`, `chunkSize`,
`documentation`, `pathRisk`, `imports`.

## Git Trajectory: Concrete Filter Descriptors

| Param          | Qdrant Key         | Condition Type        |
| -------------- | ------------------ | --------------------- |
| author         | git.dominantAuthor | match.value           |
| modifiedAfter  | git.lastModifiedAt | range.gte (timestamp) |
| modifiedBefore | git.lastModifiedAt | range.lte (timestamp) |
| minAgeDays     | git.ageDays        | range.gte             |
| maxAgeDays     | git.ageDays        | range.lte             |
| minCommitCount | git.commitCount    | range.gte             |
| taskId         | git.taskIds        | match.any             |

## Backward Compatibility

- Existing indexed collections retain `git.file.*` and `git.chunk.*` payload
  structure — no re-indexing
- Old flat format (`git.ageDays` without nesting) supported via `extract()`
  fallback logic in git signals
- Current preset names preserved: `hotspots`, `techDebt`, etc. remain available
- `custom` weights still work — signal names are stable identifiers

## Related

- Epic: Code-Graph Enrichment (`tea-rags-mcp-6z2`) — this design is a
  prerequisite
- Design: `docs/plans/2026-02-24-code-graph-enrichment-design.md` — code-graph
  will be first consumer of new contracts

---

## Implementation Plan

### Task 1: Shared Trajectory Types

**Files:**

- Create: `src/core/trajectory/types.ts`
- Test: `tests/core/trajectory/types.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/trajectory/types.test.ts
import { describe, expect, it } from "vitest";

import type {
  ChunkMetadataOverlay,
  EnrichmentProvider,
  FieldDoc,
  FileMetadataOverlay,
  FilterDescriptor,
  QdrantFilterCondition,
  ScoringWeights,
  SignalDescriptor,
} from "../../../src/core/trajectory/types.js";

describe("trajectory types", () => {
  it("SignalDescriptor satisfies contract", () => {
    const signal: SignalDescriptor = {
      name: "testSignal",
      description: "Test signal",
      extract: (payload) => (payload?.value as number) ?? 0,
    };
    expect(signal.extract({ value: 0.5 })).toBe(0.5);
    expect(signal.extract({})).toBe(0);
  });

  it("FilterDescriptor satisfies contract", () => {
    const filter: FilterDescriptor = {
      param: "minAge",
      description: "Minimum age",
      type: "number",
      toCondition: (value) => [
        { key: "ageDays", range: { gte: value as number } },
      ],
    };
    const conditions = filter.toCondition(30);
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toEqual({ key: "ageDays", range: { gte: 30 } });
  });

  it("FieldDoc satisfies contract", () => {
    const field: FieldDoc = {
      key: "git.file.commitCount",
      type: "number",
      description: "Total commits",
    };
    expect(field.key).toBe("git.file.commitCount");
  });

  it("FileMetadataOverlay and ChunkMetadataOverlay are extensible", () => {
    const file: FileMetadataOverlay = { commitCount: 10, authors: ["a"] };
    const chunk: ChunkMetadataOverlay = { churnRatio: 0.5 };
    expect(file.commitCount).toBe(10);
    expect(chunk.churnRatio).toBe(0.5);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/trajectory/types.test.ts` Expected: FAIL —
module not found

**Step 3: Write the types**

```typescript
// src/core/trajectory/types.ts
import type { FileTransform } from "../ingest/pipeline/enrichment/applier.js";
import type { ChunkLookupEntry } from "../types.js";

// --- Overlay base types (LSP-compliant) ---

export interface FileMetadataOverlay {
  [key: string]: unknown;
}

export interface ChunkMetadataOverlay {
  [key: string]: unknown;
}

// --- Qdrant filter primitives ---

export interface QdrantMatchCondition {
  key: string;
  match: { value: unknown } | { any: unknown[] };
}

export interface QdrantRangeCondition {
  key: string;
  range: { gte?: number; lte?: number };
}

export type QdrantFilterCondition = QdrantMatchCondition | QdrantRangeCondition;

export interface QdrantFilter {
  must?: QdrantFilterCondition[];
  should?: QdrantFilterCondition[];
  must_not?: QdrantFilterCondition[];
}

// --- Scoring weights (moved from reranker.ts) ---

export interface ScoringWeights {
  [signal: string]: number | undefined;
}

// --- Signal descriptor ---

export interface SignalDescriptor {
  name: string;
  description: string;
  extract: (payload: Record<string, unknown>) => number;
  defaultBound?: number;
  needsConfidence?: boolean;
  confidenceField?: string;
}

// --- Filter descriptor ---

export interface FilterDescriptor {
  param: string;
  description: string;
  type: "string" | "number" | "boolean" | "string[]";
  toCondition: (value: unknown) => QdrantFilterCondition[];
}

// --- Payload field doc ---

export interface FieldDoc {
  key: string;
  type: "string" | "number" | "boolean" | "string[]" | "timestamp";
  description: string;
}

// --- Extended EnrichmentProvider ---

export interface EnrichmentProvider {
  readonly key: string;
  resolveRoot: (absolutePath: string) => string;
  readonly fileTransform?: FileTransform;
  buildFileMetadata: (
    root: string,
    options?: { paths?: string[] },
  ) => Promise<Map<string, FileMetadataOverlay>>;
  buildChunkMetadata: (
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ) => Promise<Map<string, Map<string, ChunkMetadataOverlay>>>;

  readonly signals: SignalDescriptor[];
  readonly filters: FilterDescriptor[];
  readonly presets: Record<string, ScoringWeights>;
  readonly payloadFields: FieldDoc[];
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/trajectory/types.test.ts` Expected: PASS

**Step 5: Commit**

```
feat(trajectory): add shared trajectory contract types

SignalDescriptor, FilterDescriptor, FieldDoc, extended EnrichmentProvider
with signals/filters/presets/payloadFields query contracts.
```

---

### Task 2: Git Signals — Extract from Reranker

**Files:**

- Create: `src/core/trajectory/git/signals.ts`
- Test: `tests/core/trajectory/git/signals.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/trajectory/git/signals.test.ts
import { describe, expect, it } from "vitest";

import { gitSignals } from "../../../../src/core/trajectory/git/signals.js";

describe("git signal descriptors", () => {
  it("exports array of SignalDescriptors", () => {
    expect(Array.isArray(gitSignals)).toBe(true);
    expect(gitSignals.length).toBeGreaterThan(10);
  });

  it("each signal has required fields", () => {
    for (const s of gitSignals) {
      expect(s.name).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(typeof s.extract).toBe("function");
    }
  });

  it("recency extracts from nested git.file.ageDays", () => {
    const recency = gitSignals.find((s) => s.name === "recency")!;
    // ageDays=0 → recency=1.0 (very recent)
    const score = recency.extract({ git: { file: { ageDays: 0 } } });
    expect(score).toBe(1);
  });

  it("recency extracts from flat git.ageDays (backward compat)", () => {
    const recency = gitSignals.find((s) => s.name === "recency")!;
    const score = recency.extract({ git: { ageDays: 100 } });
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("churn extracts commitCount normalized", () => {
    const churn = gitSignals.find((s) => s.name === "churn")!;
    expect(churn.extract({ git: { file: { commitCount: 50 } } })).toBe(1);
    expect(churn.extract({ git: { file: { commitCount: 0 } } })).toBe(0);
    expect(churn.extract({})).toBe(0);
  });

  it("ownership uses dominantAuthorPct when available", () => {
    const ownership = gitSignals.find((s) => s.name === "ownership")!;
    const score = ownership.extract({
      git: { file: { dominantAuthorPct: 80 } },
    });
    expect(score).toBeCloseTo(0.8);
  });

  it("blockPenalty returns 1 for block chunks without chunk data", () => {
    const bp = gitSignals.find((s) => s.name === "blockPenalty")!;
    expect(bp.extract({ chunkType: "block" })).toBe(1);
    expect(
      bp.extract({ chunkType: "block", git: { chunk: { commitCount: 5 } } }),
    ).toBe(0);
    expect(bp.extract({ chunkType: "function" })).toBe(0);
  });

  it("chunkChurn extracts from git.chunk.commitCount", () => {
    const cc = gitSignals.find((s) => s.name === "chunkChurn")!;
    expect(cc.extract({ git: { chunk: { commitCount: 15 } } })).toBe(0.5);
  });

  it("knowledgeSilo returns 1 for single contributor", () => {
    const ks = gitSignals.find((s) => s.name === "knowledgeSilo")!;
    expect(ks.extract({ git: { file: { contributorCount: 1 } } })).toBe(1);
    expect(ks.extract({ git: { file: { contributorCount: 2 } } })).toBe(0.5);
    expect(ks.extract({ git: { file: { contributorCount: 3 } } })).toBe(0);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/trajectory/git/signals.test.ts` Expected: FAIL —
module not found

**Step 3: Implement git signals**

Create `src/core/trajectory/git/signals.ts` — extract all 14 git signals from
current `reranker.ts` (lines 257-411). Each signal's `extract()` function
encapsulates the `resolveFileMeta()`/`resolveChunkMeta()` logic +
normalization + backward compat.

Key: each `extract()` must handle both nested (`git.file.ageDays`) and flat
(`git.ageDays`) formats, same as current `resolveFileMeta()` fallback logic.

Use `normalize(value, bound)` helper inside each extractor (copy from
reranker.ts:291-294).

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/trajectory/git/signals.test.ts` Expected: PASS

**Step 5: Commit**

```
feat(trajectory): extract git signal descriptors from reranker

14 SignalDescriptor[] with extract(), defaultBound, confidence config.
Backward-compatible: supports both nested and flat git payload formats.
```

---

### Task 3: Git Filters — Extract from Search Module

**Files:**

- Create: `src/core/trajectory/git/filters.ts`
- Test: `tests/core/trajectory/git/filters.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/trajectory/git/filters.test.ts
import { describe, expect, it } from "vitest";

import {
  gitFilters,
  gitPayloadFields,
} from "../../../../src/core/trajectory/git/filters.js";

describe("git filter descriptors", () => {
  it("exports 7 filters", () => {
    expect(gitFilters).toHaveLength(7);
  });

  it("author filter produces match condition", () => {
    const author = gitFilters.find((f) => f.param === "author")!;
    const conditions = author.toCondition("John");
    expect(conditions).toEqual([
      { key: "git.dominantAuthor", match: { value: "John" } },
    ]);
  });

  it("minAgeDays filter produces range condition", () => {
    const f = gitFilters.find((f) => f.param === "minAgeDays")!;
    expect(f.toCondition(30)).toEqual([
      { key: "git.ageDays", range: { gte: 30 } },
    ]);
  });

  it("modifiedAfter converts ISO string to unix timestamp", () => {
    const f = gitFilters.find((f) => f.param === "modifiedAfter")!;
    const conditions = f.toCondition("2026-01-01T00:00:00Z");
    const range = (conditions[0] as { key: string; range: { gte: number } })
      .range;
    expect(range.gte).toBe(
      Math.floor(new Date("2026-01-01T00:00:00Z").getTime() / 1000),
    );
  });

  it("taskId filter produces match.any condition", () => {
    const f = gitFilters.find((f) => f.param === "taskId")!;
    expect(f.toCondition("TD-123")).toEqual([
      { key: "git.taskIds", match: { any: ["TD-123"] } },
    ]);
  });
});

describe("git payload field docs", () => {
  it("exports field documentation array", () => {
    expect(gitPayloadFields.length).toBeGreaterThan(10);
    for (const f of gitPayloadFields) {
      expect(f.key).toBeTruthy();
      expect(f.type).toBeTruthy();
      expect(f.description).toBeTruthy();
    }
  });

  it("includes key git fields", () => {
    const keys = gitPayloadFields.map((f) => f.key);
    expect(keys).toContain("git.file.commitCount");
    expect(keys).toContain("git.file.ageDays");
    expect(keys).toContain("git.file.dominantAuthor");
    expect(keys).toContain("git.file.taskIds");
    expect(keys).toContain("git.chunk.commitCount");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/trajectory/git/filters.test.ts` Expected: FAIL —
module not found

**Step 3: Implement git filters and payload field docs**

Create `src/core/trajectory/git/filters.ts` — extract the 7 filter conditions
from `search-module.ts` (lines 96-145) into `FilterDescriptor[]`. Also export
`gitPayloadFields: FieldDoc[]` with all git payload field documentation
(currently hardcoded in `schemas.ts`).

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/trajectory/git/filters.test.ts` Expected: PASS

**Step 5: Commit**

```
feat(trajectory): extract git filter descriptors and payload field docs

7 FilterDescriptor[] with toCondition(), FieldDoc[] for dynamic MCP schema.
```

---

### Task 4: Move Git Provider to `core/trajectory/git/`

**Files:**

- Move: `src/core/ingest/pipeline/enrichment/trajectory/git/*` →
  `src/core/trajectory/git/`
- Move:
  `src/core/ingest/pipeline/enrichment/trajectory/git/{file-reader,git-log-reader,chunk-reader,metrics,cache}.ts`
  → `src/core/trajectory/git/infra/`
- Move: `src/core/ingest/pipeline/enrichment/utils.ts` →
  `src/core/trajectory/git/infra/utils.ts`
- Update: `src/core/trajectory/git/provider.ts` — add signals, filters, presets,
  payloadFields
- Move tests to match new structure
- Delete: `src/core/ingest/pipeline/enrichment/trajectory/` (empty after move)

**Step 1: Move files and fix imports**

Move all git trajectory files to new locations. Update all import paths. Add
`signals`, `filters`, `presets`, `payloadFields` to `GitEnrichmentProvider`.

Provider becomes:

```typescript
import { gitFilters, gitPayloadFields } from "./filters.js";
import { gitPresets } from "./presets.js"; // extract from reranker SEMANTIC_SEARCH_PRESETS
import { gitSignals } from "./signals.js";

export class GitEnrichmentProvider implements EnrichmentProvider {
  readonly key = "git";
  readonly signals = gitSignals;
  readonly filters = gitFilters;
  readonly presets = gitPresets;
  readonly payloadFields = gitPayloadFields;
  // ... existing ingest methods unchanged
}
```

Create `src/core/trajectory/git/presets.ts` — move all git-owned presets from
`SEMANTIC_SEARCH_PRESETS` and `SEARCH_CODE_PRESETS` in reranker.ts.

**Step 2: Move tests**

```
tests/core/ingest/pipeline/enrichment/trajectory/git/provider.test.ts
  → tests/core/trajectory/git/provider.test.ts

tests/core/ingest/pipeline/enrichment/trajectory/git/git-log-reader.test.ts
  → tests/core/trajectory/git/infra/git-log-reader.test.ts

tests/core/ingest/pipeline/enrichment/trajectory/registry.test.ts
  → tests/core/api/trajectory-registry.test.ts (updated in Task 5)

tests/core/ingest/pipeline/enrichment/utils.test.ts
  → tests/core/trajectory/git/infra/utils.test.ts
```

**Step 3: Run all tests**

Run: `npx vitest run --reporter=verbose` Expected: ALL PASS — no behavior
changes, only file moves

**Step 4: Commit**

```
refactor(trajectory): move git trajectory to core/trajectory/git/

Public contracts (provider, signals, filters, types) in root.
Infrastructure (file-reader, git-log-reader, metrics, cache) in infra/.
Provider now declares signals, filters, presets, payloadFields.
```

---

### Task 5: Trajectory Registry

**Files:**

- Create: `src/core/api/trajectory-registry.ts`
- Test: `tests/core/api/trajectory-registry.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/core/api/trajectory-registry.test.ts
import { beforeEach, describe, expect, it } from "vitest";

import { TrajectoryRegistry } from "../../../src/core/api/trajectory-registry.js";
import type {
  EnrichmentProvider,
  ScoringWeights,
} from "../../../src/core/trajectory/types.js";

function mockProvider(
  key: string,
  overrides?: Partial<EnrichmentProvider>,
): EnrichmentProvider {
  return {
    key,
    resolveRoot: (p) => p,
    buildFileMetadata: async () => new Map(),
    buildChunkMetadata: async () => new Map(),
    signals: overrides?.signals ?? [],
    filters: overrides?.filters ?? [],
    presets: overrides?.presets ?? {},
    payloadFields: overrides?.payloadFields ?? [],
  };
}

describe("TrajectoryRegistry", () => {
  let registry: TrajectoryRegistry;

  beforeEach(() => {
    registry = new TrajectoryRegistry();
  });

  it("collects signals from all providers", () => {
    registry.register(
      mockProvider("a", {
        signals: [{ name: "s1", description: "d", extract: () => 0 }],
      }),
    );
    registry.register(
      mockProvider("b", {
        signals: [{ name: "s2", description: "d", extract: () => 1 }],
      }),
    );
    expect(registry.getAllSignals()).toHaveLength(2);
    expect(registry.getAllSignals().map((s) => s.name)).toEqual(["s1", "s2"]);
  });

  it("collects filters from all providers", () => {
    registry.register(
      mockProvider("a", {
        filters: [
          {
            param: "author",
            description: "d",
            type: "string",
            toCondition: () => [],
          },
        ],
      }),
    );
    expect(registry.getAllFilters()).toHaveLength(1);
  });

  it("merges presets from providers", () => {
    registry.register(
      mockProvider("a", { presets: { hotspots: { churn: 0.5 } } }),
    );
    registry.register(
      mockProvider("b", { presets: { blastRadius: { imports: 0.5 } } }),
    );
    const presets = registry.getAllPresets();
    expect(presets.hotspots).toBeDefined();
    expect(presets.blastRadius).toBeDefined();
  });

  it("composite presets override trajectory presets", () => {
    registry.register(
      mockProvider("a", { presets: { hotspots: { churn: 1.0 } } }),
    );
    registry.setCompositePresets({ hotspots: { churn: 0.5, imports: 0.5 } });
    const presets = registry.getAllPresets();
    expect(presets.hotspots).toEqual({ churn: 0.5, imports: 0.5 });
  });

  it("buildFilter returns undefined when no params match", () => {
    registry.register(
      mockProvider("a", {
        filters: [
          {
            param: "author",
            description: "d",
            type: "string",
            toCondition: (v) => [{ key: "git.author", match: { value: v } }],
          },
        ],
      }),
    );
    expect(registry.buildFilter({})).toBeUndefined();
  });

  it("buildFilter merges conditions from matching params", () => {
    registry.register(
      mockProvider("a", {
        filters: [
          {
            param: "author",
            description: "d",
            type: "string",
            toCondition: (v) => [{ key: "git.author", match: { value: v } }],
          },
          {
            param: "minAge",
            description: "d",
            type: "number",
            toCondition: (v) => [
              { key: "git.ageDays", range: { gte: v as number } },
            ],
          },
        ],
      }),
    );
    const filter = registry.buildFilter({ author: "John", minAge: 30 });
    expect(filter?.must).toHaveLength(2);
  });

  it("getAllPayloadFields collects from all providers", () => {
    registry.register(
      mockProvider("a", {
        payloadFields: [
          { key: "git.file.x", type: "number", description: "d" },
        ],
      }),
    );
    expect(registry.getAllPayloadFields()).toHaveLength(1);
  });

  it("getProviders returns registered providers", () => {
    const p = mockProvider("a");
    registry.register(p);
    expect(registry.getProviders()).toEqual([p]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/trajectory-registry.test.ts` Expected: FAIL
— module not found

**Step 3: Implement TrajectoryRegistry**

```typescript
// src/core/api/trajectory-registry.ts
import type {
  EnrichmentProvider,
  FieldDoc,
  FilterDescriptor,
  QdrantFilter,
  QdrantFilterCondition,
  ScoringWeights,
  SignalDescriptor,
} from "../trajectory/types.js";

export class TrajectoryRegistry {
  private providers: EnrichmentProvider[] = [];
  private compositePresets: Record<string, ScoringWeights> = {};

  register(provider: EnrichmentProvider): void {
    this.providers.push(provider);
  }

  setCompositePresets(presets: Record<string, ScoringWeights>): void {
    this.compositePresets = presets;
  }

  getProviders(): EnrichmentProvider[] {
    return this.providers;
  }

  getAllSignals(): SignalDescriptor[] {
    return this.providers.flatMap((p) => p.signals);
  }

  getAllFilters(): FilterDescriptor[] {
    return this.providers.flatMap((p) => p.filters);
  }

  getAllPresets(): Record<string, ScoringWeights> {
    const merged: Record<string, ScoringWeights> = {};
    for (const p of this.providers) {
      Object.assign(merged, p.presets);
    }
    // Composite overrides last
    Object.assign(merged, this.compositePresets);
    return merged;
  }

  getAllPayloadFields(): FieldDoc[] {
    return this.providers.flatMap((p) => p.payloadFields);
  }

  buildFilter(params: Record<string, unknown>): QdrantFilter | undefined {
    const conditions: QdrantFilterCondition[] = [];
    for (const desc of this.getAllFilters()) {
      const value = params[desc.param];
      if (value !== undefined && value !== null) {
        conditions.push(...desc.toCondition(value));
      }
    }
    return conditions.length > 0 ? { must: conditions } : undefined;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/core/api/trajectory-registry.test.ts` Expected: PASS

**Step 5: Commit**

```
feat(api): add TrajectoryRegistry facade

Collects signals/filters/presets/payloadFields from providers.
Supports composite presets that override trajectory-level presets.
buildFilter() converts typed params to Qdrant conditions via descriptors.
```

---

### Task 6: Refactor Reranker — Generic Signal Dispatch

**Files:**

- Modify: `src/core/search/reranker.ts`
- Modify: `tests/core/search/reranker.test.ts`

**Step 1: Refactor reranker to use SignalDescriptor[]**

Remove all git-specific types (`GitFileFields`, `GitChunkFields`, `GitMetadata`,
`NormalizationBounds`, `DEFAULT_BOUNDS`), `resolveFileMeta()`,
`resolveChunkMeta()`, and the hardcoded `calculateSignals()`.

Replace with generic:

```typescript
export function calculateSignals(
  result: RerankableResult,
  signals: SignalDescriptor[],
): Record<string, number> {
  const values: Record<string, number> = {
    similarity: result.score,
    // Built-in signals (not trajectory-owned)
    chunkSize: getChunkSize(result),
    documentation: result.payload?.isDocumentation ? 1 : 0,
    pathRisk: getPathRiskScore(result),
    imports: normalizeValue(result.payload?.imports?.length ?? 0, 20),
  };
  for (const signal of signals) {
    values[signal.name] = signal.extract(result.payload ?? {});
  }
  return values;
}
```

`rerankResults()` now takes `signals: SignalDescriptor[]` parameter.
`rerankSemanticSearchResults()` and `rerankSearchCodeResults()` take `signals` +
`presets` from registry.

Remove `SEMANTIC_SEARCH_PRESETS` and `SEARCH_CODE_PRESETS` constants — they come
from registry.

Keep `ScoringWeights` import from `trajectory/types.ts` (re-export for backward
compat).

**Step 2: Update reranker tests**

Update `tests/core/search/reranker.test.ts` — use `gitSignals` from trajectory
instead of relying on hardcoded internal state. Test that generic dispatch
works: pass mock signals, verify extraction.

**Step 3: Run all tests**

Run: `npx vitest run --reporter=verbose` Expected: ALL PASS

**Step 4: Commit**

```
refactor(search): make reranker generic — signal dispatch via descriptors

Remove git-specific types and hardcoded signal extraction.
calculateSignals() now iterates SignalDescriptor[] from trajectory registry.
Built-in signals (similarity, chunkSize, documentation, pathRisk, imports) remain.
```

---

### Task 7: Refactor Search Module — Generic Filters

**Files:**

- Modify: `src/core/search/search-module.ts`
- Modify: `tests/core/search/search-module.test.ts`

**Step 1: Inject TrajectoryRegistry into SearchModule**

SearchModule constructor receives `TrajectoryRegistry`. Replace hardcoded git
filter block (lines 62-146) with:

```typescript
// Basic filters (fileTypes, documentationOnly) stay inline
// Trajectory filters via registry
const trajectoryFilter = this.registry.buildFilter(options ?? {});
const filter = mergeFilters(basicFilter, trajectoryFilter);
```

Also inject registry signals into `rerankSearchCodeResults()` calls.

Remove `SearchOptions` git-specific fields from `core/types.ts` — they now come
dynamically from trajectory filters. Keep `SearchOptions` as
`Record<string, unknown>` pass-through for typed params.

**Step 2: Update SearchFacade**

`SearchFacade` constructor receives registry, passes to `SearchModule`.

**Step 3: Update tests**

Update `tests/core/search/search-module.test.ts` to inject mock registry with
test filter descriptors.

**Step 4: Run all tests**

Run: `npx vitest run --reporter=verbose` Expected: ALL PASS

**Step 5: Commit**

```
refactor(search): make search-module generic — filters via registry

Replace hardcoded git filter conditions with registry.buildFilter().
SearchModule receives TrajectoryRegistry for filter and reranker dispatch.
```

---

### Task 8: Wire Registry Into Application Bootstrap

**Files:**

- Modify: `src/core/api/ingest-facade.ts` — use registry.getProviders()
- Modify: `src/core/api/search-facade.ts` — pass registry to SearchModule
- Modify: `src/bootstrap/` or wherever application wiring happens
- Delete: `src/core/ingest/pipeline/enrichment/trajectory/registry.ts` (replaced
  by TrajectoryRegistry)
- Delete: `src/core/ingest/pipeline/enrichment/types.ts` (replaced by
  trajectory/types.ts)

**Step 1: Find and update bootstrap/wiring code**

Locate where `createEnrichmentProviders()` is called and
`SearchFacade`/`SearchModule` are constructed. Wire `TrajectoryRegistry`:

```typescript
const registry = new TrajectoryRegistry();
if (config.enableGitMetadata) {
  registry.register(new GitEnrichmentProvider());
}
// Future: registry.register(new CodeGraphProvider());
registry.setCompositePresets(COMPOSITE_PRESETS);
```

Pass registry to both ingest (coordinator) and search (search-module) paths.

**Step 2: Update coordinator import**

`EnrichmentCoordinator` now imports `EnrichmentProvider` from
`core/trajectory/types.ts` instead of the deleted `enrichment/types.ts`.

**Step 3: Delete old files**

- `src/core/ingest/pipeline/enrichment/trajectory/registry.ts`
- `src/core/ingest/pipeline/enrichment/types.ts`
- `src/core/ingest/pipeline/enrichment/trajectory/` directory (now empty)

**Step 4: Run all tests**

Run: `npx vitest run --reporter=verbose` Expected: ALL PASS

**Step 5: Commit**

```
refactor: wire TrajectoryRegistry into application bootstrap

Single registry provides providers to ingest, signals/filters/presets to search.
Delete old enrichment/trajectory/ registry and types (superseded).
```

---

### Task 9: Dynamic MCP Schema

**Files:**

- Modify: `src/mcp/tools/schemas.ts`
- Modify: `src/mcp/tools/formatters/search-pipeline.ts`

**Step 1: Make schema descriptions dynamic**

Replace hardcoded filter field list in `schemas.ts` with function that reads
from `TrajectoryRegistry.getAllPayloadFields()` and `getAllFilters()`.

Update `search-pipeline.ts` `applyPostProcessing()` to receive signals from
registry for reranking.

**Step 2: Run all tests**

Run: `npx vitest run --reporter=verbose` Expected: ALL PASS

**Step 3: Commit**

```
feat(mcp): dynamic tool schema from trajectory registry

Filter fields, typed params, and preset lists assembled from active providers.
No manual schema maintenance when adding new trajectories.
```

---

### Task 10: Final Cleanup and Full Test Suite

**Step 1: Remove dead code**

Search for any remaining imports of old paths. Remove unused backward-compat
code in reranker if all tests pass without it.

**Step 2: Run full test suite with coverage**

Run: `npm run test:coverage` Expected: ALL PASS, coverage thresholds met

**Step 3: Run provider verification tests**

Run: `npm run test:providers` Expected: PASS

**Step 4: Type check**

Run: `npm run type-check` Expected: no errors

**Step 5: Commit**

```
chore: cleanup dead imports and verify coverage after trajectory refactor
```
