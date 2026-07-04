# Domain Boundaries + Terminology Alignment

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Establish clean domain boundaries (api/contracts/adapters separation)
and align all naming to Signal terminology.

**Architecture:** Create `core/contracts/` for shared interfaces (DIP), move
Qdrant types to `core/adapters/`, rename fields→signals terminology throughout,
delete duplicate code in `ingest/pipeline/enrichment/trajectory/git/`.

**Tech Stack:** TypeScript, Vitest

**Prerequisites:** None. This is a mechanical refactoring plan.

**Dependency:** Plan B (Reranker Decomposition) depends on this plan being
complete.

---

## Phase 1: Create contracts/ layer and move types

### Task 1: Create contracts directory structure

**Files:**

- Create: `src/core/contracts/types/provider.ts`
- Create: `src/core/contracts/types/reranker.ts`
- Create: `src/core/contracts/index.ts`

**Step 1: Create `contracts/types/provider.ts`**

Move from `src/core/trajectory/types.ts` — all provider-domain interfaces:

```typescript
/**
 * Shared provider contracts — domain interfaces for trajectory system.
 * Lives in contracts/ for DIP: trajectory, ingest, search all import from here.
 */

import type { QdrantFilterCondition } from "../../adapters/qdrant/types.js";

// --- Overlay base types ---

export interface FileSignalOverlay {
  [key: string]: unknown;
}

export interface ChunkSignalOverlay {
  [key: string]: unknown;
}

// --- Scoring weights ---

export interface ScoringWeights {
  [signal: string]: number | undefined;
}

// --- Signal (raw payload field, no normalization) ---

export interface Signal {
  /** Qdrant payload path (e.g. "git.file.commitCount") */
  key: string;
  /** Signal name for reranker reference (e.g. "commitCount") */
  name: string;
  /** Data type */
  type: "string" | "number" | "boolean" | "string[]" | "timestamp";
  /** Human-readable description for MCP schema */
  description: string;
  /** Hint for Reranker: default normalization upper bound */
  defaultBound?: number;
}

// --- Filter level ---

/** Payload level for level-aware filters ("file" or "chunk"). */
export type FilterLevel = "file" | "chunk";

// --- Filter descriptor ---

export interface FilterDescriptor {
  /** Parameter name exposed to users (e.g. "author", "minAgeDays") */
  param: string;
  /** Human-readable description */
  description: string;
  /** Parameter type for schema generation */
  type: "string" | "number" | "boolean" | "string[]";
  /** Convert user param value to Qdrant filter condition(s) */
  toCondition: (value: unknown, level?: FilterLevel) => QdrantFilterCondition[];
}

// --- File signal transform ---

export type FileSignalTransform = (
  data: Record<string, unknown>,
  maxEndLine: number,
) => Record<string, unknown>;

// --- Enrichment provider ---

export interface EnrichmentProvider {
  /** Namespace key for Qdrant payload: { [key].file: ..., [key].chunk: ... } */
  readonly key: string;
  /** Resolve the effective root for this provider (e.g. git repo root). */
  resolveRoot: (absolutePath: string) => string;
  /** Optional per-file transform applied at write time. */
  readonly fileSignalTransform?: FileSignalTransform;
  /** File-level signal enrichment (prefetch at T=0, or backfill for specific paths) */
  buildFileSignals: (
    root: string,
    options?: { paths?: string[] },
  ) => Promise<Map<string, Record<string, unknown>>>;
  /** Chunk-level signal enrichment (post-flush) */
  buildChunkSignals: (
    root: string,
    chunkMap: Map<string, ChunkLookupEntry[]>,
  ) => Promise<Map<string, Map<string, Record<string, unknown>>>>;
}

// --- Trajectory query contract ---

export interface TrajectoryQueryContract {
  /** Signal definitions (raw payload fields) */
  readonly signals: Signal[];
  /** Typed filter parameters → Qdrant conditions */
  readonly filters: FilterDescriptor[];
  /** Trajectory-owned presets (weight configurations) */
  readonly presets: Record<string, ScoringWeights>;
}

// Re-export ChunkLookupEntry dependency
export type { ChunkLookupEntry } from "../../types.js";
```

**Step 2: Create `contracts/types/reranker.ts`**

Move reranker types from `src/core/search/reranker.ts`:

```typescript
/**
 * Reranker contract types — shared by search layer and consumers.
 */

import type { ScoringWeights } from "./provider.js";

export interface RerankableResult {
  score: number;
  payload?: {
    relativePath?: string;
    startLine?: number;
    endLine?: number;
    language?: string;
    isDocumentation?: boolean;
    chunkType?: string;
    imports?: string[];
    exports?: string[];
    git?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

export interface NormalizationBounds {
  maxAgeDays: number;
  maxCommitCount: number;
  maxChunkSize: number;
  maxImports: number;
  maxBugFixRate: number;
  maxVolatility: number;
  maxChangeDensity: number;
  maxChunkCommitCount: number;
  maxRelativeChurn: number;
  maxBurstActivity: number;
  maxChunkChurnRatio: number;
}

export type SemanticSearchRerankPreset =
  | "relevance"
  | "techDebt"
  | "hotspots"
  | "codeReview"
  | "onboarding"
  | "securityAudit"
  | "refactoring"
  | "ownership"
  | "impactAnalysis";

export type SearchCodeRerankPreset = "relevance" | "recent" | "stable";

export type RerankMode<T extends string> = T | { custom: ScoringWeights };
```

**Step 3: Create `contracts/index.ts`**

```typescript
export * from "./types/provider.js";
export * from "./types/reranker.js";
```

**Step 4: Run type-check**

Run: `npx tsc --noEmit` Expected: errors about missing imports in existing files
(expected — we haven't updated consumers yet)

**Step 5: Commit**

```bash
git add src/core/contracts/
git commit -m "feat(contracts): create contracts layer with provider and reranker types"
```

---

### Task 2: Move Qdrant filter types to adapters

**Files:**

- Modify: `src/core/adapters/qdrant/types.ts` (or create if doesn't exist)
- Modify: `src/core/trajectory/types.ts` (remove Qdrant types)
- Modify: `src/core/search/search-module.ts` (remove local Qdrant type
  duplicates)

**Step 1: Check if `adapters/qdrant/types.ts` exists**

Run: `ls src/core/adapters/qdrant/`

**Step 2: Add Qdrant filter types to `adapters/qdrant/types.ts`**

Append these types (they may already have other Qdrant types there):

```typescript
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
```

**Step 3: Remove Qdrant types from `trajectory/types.ts`**

Remove lines 22-38 (QdrantMatchCondition, QdrantRangeCondition,
QdrantFilterCondition, QdrantFilter). Update imports in `trajectory/types.ts` if
it uses these types internally.

**Step 4: Remove local Qdrant type duplicates from `search/search-module.ts`**

Remove lines 16-31 (locally defined QdrantMatchFilter, QdrantRangeFilter,
QdrantFilterCondition, QdrantFilter). Add import:
`import type { QdrantFilter, QdrantFilterCondition } from "../adapters/qdrant/types.js";`

**Step 5: Update `api/trajectory-registry.ts`**

Change import of QdrantFilter/QdrantFilterCondition from
`../trajectory/types.js` to `../adapters/qdrant/types.js`.

**Step 6: Run type-check and tests**

Run: `npx tsc --noEmit && npx vitest run` Expected: PASS

**Step 7: Commit**

```bash
git add src/core/adapters/qdrant/ src/core/trajectory/types.ts src/core/search/search-module.ts src/core/api/trajectory-registry.ts
git commit -m "refactor: move Qdrant filter types to adapters layer"
```

---

### Task 3: Move signal-utils.ts to contracts/

**Files:**

- Move: `src/core/trajectory/git/infra/signal-utils.ts` →
  `src/core/contracts/signal-utils.ts`
- Modify: any files importing signal-utils (currently none, file is new and
  uncommitted)

**Step 1: Move file**

```bash
mv src/core/trajectory/git/infra/signal-utils.ts src/core/contracts/signal-utils.ts
```

**Step 2: Update barrel**

Add to `contracts/index.ts`:

```typescript
export * from "./signal-utils.js";
```

**Step 3: Run type-check**

Run: `npx tsc --noEmit` Expected: PASS (no consumers yet)

**Step 4: Commit**

```bash
git add src/core/contracts/signal-utils.ts src/core/contracts/index.ts
git commit -m "refactor: move signal-utils to contracts layer"
```

---

## Phase 2: Terminology rename — types

### Task 4: Rename FieldDoc → Signal, remove SignalDescriptor

**Files:**

- Modify: `src/core/trajectory/types.ts` — remove FieldDoc, SignalDescriptor;
  re-export from contracts
- Modify: `src/core/api/trajectory-registry.ts` — import Signal from contracts
- Modify: `tests/core/api/trajectory-registry.test.ts` — update type references
- Modify: `tests/core/trajectory/git/signals.test.ts` — update type references

**Step 1: Update `trajectory/types.ts` to re-export from contracts**

Replace the entire file with re-exports (temporary bridge — consumers will
migrate to contracts imports later):

```typescript
/**
 * Trajectory types — re-exports from contracts for backward compatibility.
 * New code should import directly from core/contracts.
 */
export type {
  Signal,
  FilterDescriptor,
  FilterLevel,
  ScoringWeights,
  TrajectoryQueryContract,
  EnrichmentProvider,
  FileSignalTransform,
  FileSignalOverlay,
  ChunkSignalOverlay,
} from "../contracts/index.js";

export type {
  QdrantFilterCondition,
  QdrantFilter,
} from "../adapters/qdrant/types.js";

// Backward compat alias — remove after full migration
/** @deprecated Use Signal instead */
export type { Signal as FieldDoc } from "../contracts/index.js";
```

**Step 2: Update `api/trajectory-registry.ts`**

Change all imports from `../trajectory/types.js` to `../contracts/index.js`.
Replace `FieldDoc` with `Signal`, `SignalDescriptor` with nothing (not used in
registry for extraction).

Rename method: `getAllPayloadFields()` → method stays but internally uses
`Signal[]`. Actually merge with `getAllSignals()` since they now serve same
purpose.

**Step 3: Update test files**

- `tests/core/api/trajectory-registry.test.ts` — replace `payloadFields` with
  `signals` in mock contracts
- `tests/core/trajectory/git/signals.test.ts` — remove `SignalDescriptor`
  reference

**Step 4: Run tests**

Run: `npx vitest run` Expected: PASS

**Step 5: Commit**

```bash
git add src/core/trajectory/types.ts src/core/api/trajectory-registry.ts tests/
git commit -m "refactor: rename FieldDoc to Signal, remove SignalDescriptor"
```

---

### Task 5: Rename fields.ts → signals.ts, remove gitPayloadFields from filters.ts

**Files:**

- Delete: `src/core/trajectory/git/fields.ts`
- Modify: `src/core/trajectory/git/filters.ts` — remove gitPayloadFields export
- Modify: `src/core/trajectory/git/signals.ts` — replace SignalDescriptor[] with
  Signal[]
- Modify: any files importing from `fields.ts` or `gitPayloadFields` from
  `filters.ts`

**Step 1: Check who imports from fields.ts**

Run: `rg "from.*fields" src/core/trajectory/`

**Step 2: Delete `fields.ts`**

It's a duplicate — gitPayloadFields already exists in filters.ts.

```bash
rm src/core/trajectory/git/fields.ts
```

**Step 3: Remove gitPayloadFields from filters.ts (SRP)**

Remove the `gitPayloadFields` export and its FieldDoc import. filters.ts should
only contain `gitFilters`.

**Step 4: Rewrite `signals.ts`**

Replace the current 14 SignalDescriptor objects (with extract() lambdas) with
Signal[] definitions (raw field descriptions, no extract):

```typescript
/**
 * Git signal definitions — raw payload fields stored in Qdrant.
 *
 * Signal = field description without normalization.
 * Normalization is the Reranker's responsibility.
 */

import type { Signal } from "../../contracts/index.js";

export const gitSignals: Signal[] = [
  // ── File-level signals ──
  {
    key: "git.file.commitCount",
    name: "commitCount",
    type: "number",
    description: "Total commits modifying this file",
    defaultBound: 50,
  },
  {
    key: "git.file.ageDays",
    name: "ageDays",
    type: "number",
    description: "Days since last modification",
    defaultBound: 365,
  },
  {
    key: "git.file.dominantAuthor",
    name: "dominantAuthor",
    type: "string",
    description: "Author with most commits to this file",
  },
  {
    key: "git.file.authors",
    name: "authors",
    type: "string[]",
    description: "All contributing authors",
  },
  {
    key: "git.file.dominantAuthorPct",
    name: "dominantAuthorPct",
    type: "number",
    description: "Percentage of commits by dominant author",
  },
  {
    key: "git.file.relativeChurn",
    name: "relativeChurn",
    type: "number",
    description: "Churn relative to file size",
    defaultBound: 5.0,
  },
  {
    key: "git.file.recencyWeightedFreq",
    name: "recencyWeightedFreq",
    type: "number",
    description: "Recency-weighted commit frequency",
    defaultBound: 10.0,
  },
  {
    key: "git.file.changeDensity",
    name: "changeDensity",
    type: "number",
    description: "Commits per month",
    defaultBound: 20,
  },
  {
    key: "git.file.churnVolatility",
    name: "churnVolatility",
    type: "number",
    description: "Standard deviation of commit intervals in days",
    defaultBound: 60,
  },
  {
    key: "git.file.bugFixRate",
    name: "bugFixRate",
    type: "number",
    description: "Percentage of bug-fix commits (0-100)",
    defaultBound: 100,
  },
  {
    key: "git.file.contributorCount",
    name: "contributorCount",
    type: "number",
    description: "Number of distinct contributors",
  },
  {
    key: "git.file.taskIds",
    name: "taskIds",
    type: "string[]",
    description: "Task/ticket IDs extracted from commit messages",
  },

  // ── Chunk-level signals ──
  {
    key: "git.chunk.commitCount",
    name: "chunkCommitCount",
    type: "number",
    description: "Commits touching this specific chunk",
    defaultBound: 30,
  },
  {
    key: "git.chunk.churnRatio",
    name: "chunkChurnRatio",
    type: "number",
    description: "Chunk's share of file churn (0-1)",
    defaultBound: 1.0,
  },
  {
    key: "git.chunk.contributorCount",
    name: "chunkContributorCount",
    type: "number",
    description: "Distinct contributors to this chunk",
  },
  {
    key: "git.chunk.bugFixRate",
    name: "chunkBugFixRate",
    type: "number",
    description: "Bug-fix rate for this chunk (0-100)",
  },
  {
    key: "git.chunk.ageDays",
    name: "chunkAgeDays",
    type: "number",
    description: "Days since last modification to this chunk",
  },
  {
    key: "git.chunk.relativeChurn",
    name: "chunkRelativeChurn",
    type: "number",
    description: "Churn relative to chunk size",
  },
  {
    key: "git.chunk.recencyWeightedFreq",
    name: "chunkRecencyWeightedFreq",
    type: "number",
    description: "Chunk-level recency-weighted commit frequency",
  },
  {
    key: "git.chunk.changeDensity",
    name: "chunkChangeDensity",
    type: "number",
    description: "Chunk-level change density (commits per month)",
  },
];
```

**Step 5: Update signals.test.ts**

```typescript
import { gitSignals } from "../../../../src/core/trajectory/git/signals.js";

describe("gitSignals", () => {
  it("exports array of Signal definitions", () => {
    expect(Array.isArray(gitSignals)).toBe(true);
    expect(gitSignals.length).toBeGreaterThan(0);
  });

  it("each signal has required fields", () => {
    for (const signal of gitSignals) {
      expect(signal.key).toBeDefined();
      expect(signal.name).toBeDefined();
      expect(signal.type).toBeDefined();
      expect(signal.description).toBeDefined();
    }
  });

  it("file signals have git.file. prefix", () => {
    const fileSignals = gitSignals.filter((s) => s.key.startsWith("git.file."));
    expect(fileSignals.length).toBe(12);
  });

  it("chunk signals have git.chunk. prefix", () => {
    const chunkSignals = gitSignals.filter((s) =>
      s.key.startsWith("git.chunk."),
    );
    expect(chunkSignals.length).toBe(8);
  });
});
```

**Step 6: Run tests**

Run: `npx vitest run` Expected: PASS

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: rename fields to signals, remove SignalDescriptor extract lambdas"
```

---

## Phase 3: Terminology rename — functions and types

### Task 6: Rename buildFileMetadata → buildFileSignals in EnrichmentProvider interface

**Files:**

- Modify: `src/core/contracts/types/provider.ts` — already has new names
- Modify: `src/core/ingest/pipeline/enrichment/types.ts` — update interface (or
  delete, replace with re-export from contracts)
- Modify: `src/core/ingest/pipeline/enrichment/applier.ts` — rename
  FileTransform → FileSignalTransform
- Modify: `src/core/trajectory/git/provider.ts` — rename methods
- Modify: `src/core/ingest/pipeline/enrichment/coordinator.ts` — rename method
  calls

**Step 1: Replace `ingest/pipeline/enrichment/types.ts` with re-export**

```typescript
/**
 * Re-export from contracts for backward compatibility.
 * New code should import directly from core/contracts.
 */
export type {
  EnrichmentProvider,
  FileSignalTransform,
  ChunkLookupEntry,
} from "../../../contracts/index.js";

/** @deprecated Use FileSignalTransform */
export type { FileSignalTransform as FileTransform } from "../../../contracts/index.js";
```

**Step 2: Rename in `trajectory/git/provider.ts`**

- `buildFileMetadata` → `buildFileSignals`
- `buildChunkMetadata` → `buildChunkSignals`
- `fileTransform` → `fileSignalTransform`
- `lastFileResult` → `lastFileSignalResult`
- Update imports to come from `../../contracts/index.js` instead of
  `../../ingest/...`

**Step 3: Rename in `ingest/pipeline/enrichment/coordinator.ts`**

- All calls to `provider.buildFileMetadata(...)` →
  `provider.buildFileSignals(...)`
- All calls to `provider.buildChunkMetadata(...)` →
  `provider.buildChunkSignals(...)`
- `state.provider.fileTransform` → `state.provider.fileSignalTransform`

**Step 4: Rename in `ingest/pipeline/enrichment/applier.ts`**

- `FileTransform` → `FileSignalTransform` (import from contracts)
- `applyFileMetadata` → `applyFileSignals` (if exported/used elsewhere)

**Step 5: Run tests**

Run: `npx vitest run` Expected: failures in test files that use old names

**Step 6: Fix test files**

Update all test files that reference old method names:

- `tests/core/trajectory/git/provider.test.ts`
- `tests/core/ingest/pipeline/enrichment/coordinator.test.ts`

**Step 7: Run tests again**

Run: `npx vitest run` Expected: PASS

**Step 8: Commit**

```bash
git add -A
git commit -m "refactor: rename buildFileMetadata/buildChunkMetadata to buildFileSignals/buildChunkSignals"
```

---

### Task 7: Rename internal git types and functions

**Files:**

- Modify: `src/core/trajectory/git/types.ts` — GitFileMetadata → GitFileSignals,
  ChunkChurnOverlay → GitChunkSignals
- Modify: `src/core/trajectory/git/infra/metrics.ts` — computeFileMetadata →
  computeFileSignals, computeChunkOverlay → computeChunkSignals
- Modify: `src/core/trajectory/git/infra/metrics/file-assembler.ts` —
  assembleFileMetadata → assembleFileSignals
- Modify: `src/core/trajectory/git/infra/metrics/chunk-assembler.ts` —
  assembleChunkOverlay → assembleChunkSignals
- Modify: `src/core/trajectory/git/infra/metrics/types.ts` — type imports
- Modify: `src/core/trajectory/git/infra/file-reader.ts` — buildFileMetadataMap
  → buildFileSignalMap, buildFileMetadataForPaths → buildFileSignalsForPaths
- Modify: `src/core/trajectory/git/infra/git-log-reader.ts` — method renames
- Modify: all corresponding test files

**Step 1: Rename types in `git/types.ts`**

- `GitFileMetadata` → `GitFileSignals`
- `ChunkChurnOverlay` → `GitChunkSignals`

**Step 2: Rename in `git/infra/metrics.ts`**

- `computeFileMetadata` → `computeFileSignals`
- `computeChunkOverlay` → `computeChunkSignals`

**Step 3: Rename in `git/infra/metrics/file-assembler.ts`**

- `assembleFileMetadata` → `assembleFileSignals`
- Return type `GitFileMetadata` → `GitFileSignals`

**Step 4: Rename in `git/infra/metrics/chunk-assembler.ts`**

- `assembleChunkOverlay` → `assembleChunkSignals`
- Return type `ChunkChurnOverlay` → `GitChunkSignals`

**Step 5: Rename in `git/infra/file-reader.ts`**

- `buildFileMetadataMap` → `buildFileSignalMap`
- `buildFileMetadataForPaths` → `buildFileSignalsForPaths`

**Step 6: Rename in `git/infra/git-log-reader.ts`**

- `buildFileMetadataMap` → `buildFileSignalMap`
- `buildFileMetadataForPaths` → `buildFileSignalsForPaths`

**Step 7: Update all test files**

Mass rename in test files (same pattern):

- `tests/core/trajectory/git/infra/git-log-reader.test.ts`
- `tests/core/trajectory/git/infra/metrics/extractors.test.ts`
- `tests/core/trajectory/git/infra/metrics/file-assembler.test.ts`
- `tests/core/trajectory/git/infra/metrics/chunk-assembler.test.ts`

**Step 8: Run tests**

Run: `npx vitest run` Expected: PASS

**Step 9: Commit**

```bash
git add -A
git commit -m "refactor: align git trajectory naming to Signal terminology"
```

---

## Phase 4: Fix dependency violations

### Task 8: Update trajectory/git/provider.ts imports (trajectory -x-> ingest)

**Files:**

- Modify: `src/core/trajectory/git/provider.ts` — imports from contracts, not
  ingest

**Step 1: Replace ingest imports**

Change:

```typescript
import type { FileTransform } from "../../ingest/pipeline/enrichment/applier.js";
import type { EnrichmentProvider } from "../../ingest/pipeline/enrichment/types.js";
```

To:

```typescript
import type {
  EnrichmentProvider,
  FileSignalTransform,
} from "../../contracts/index.js";
```

**Step 2: Run type-check**

Run: `npx tsc --noEmit` Expected: PASS

**Step 3: Commit**

```bash
git add src/core/trajectory/git/provider.ts
git commit -m "fix: remove trajectory->ingest dependency violation"
```

---

### Task 9: Update search/search-module.ts imports (search -x-> api shared)

**Files:**

- Modify: `src/core/search/search-module.ts` — import from contracts, not
  api/shared
- Modify: `src/core/api/shared.ts` — keep as is (api can use contracts)
- Move: `resolveCollectionName`, `validatePath` to `contracts/` or keep in api
  (api → contracts is allowed)

**Step 1: Assess `api/shared.ts`**

Check if `resolveCollectionName` and `validatePath` are truly shared utilities
or api-specific. If shared: move to `contracts/shared.ts`. If api-specific:
search-module should not use them (search should not depend on api).

**Step 2: Move shared utilities to contracts if needed**

Or refactor search-module to not need them (it may have its own collection
resolution).

**Step 3: Run tests**

Run: `npx vitest run` Expected: PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "fix: remove search->api dependency violation"
```

---

### Task 10: Delete duplicate code in ingest/pipeline/enrichment/trajectory/git/

**Files:**

- Delete: entire `src/core/ingest/pipeline/enrichment/trajectory/git/` directory
- Modify: `src/core/ingest/pipeline/enrichment/trajectory/registry.ts` — import
  from core/trajectory/git/
- Delete: duplicate test files in
  `tests/core/ingest/pipeline/enrichment/trajectory/git/`

**Step 1: Update registry.ts**

Change:

```typescript
import { GitEnrichmentProvider } from "./git/provider.js";
```

To:

```typescript
import { GitEnrichmentProvider } from "../../../../trajectory/git/provider.js";
```

Wait — this creates ingest → trajectory dependency. Instead, the registry should
import through contracts.

Better approach: make registry accept providers via injection (already done in
multi-provider architecture):

```typescript
import type { EnrichmentProvider } from "../../../../contracts/index.js";
```

The actual `GitEnrichmentProvider` instantiation should happen in
`api/ingest-facade.ts` (the composition root), not in ingest layer.

**Step 2: Move provider instantiation to api/ingest-facade.ts**

```typescript
import { GitEnrichmentProvider } from "../trajectory/git/provider.js";

// api CAN import from trajectory via contracts? Actually api -> trajectory is not in allowed list.
```

Hmm — api also shouldn't import from trajectory directly. The composition root
needs access to implementations. Options:

1. Allow api → trajectory (api is the composition root, this is standard DI
   pattern)
2. Move registry to api/ (it's a composition concern, not ingest concern)

Option 2 is cleaner: `api/enrichment-registry.ts` imports concrete providers,
returns `EnrichmentProvider[]`.

**Step 3: Delete duplicates**

```bash
rm -rf src/core/ingest/pipeline/enrichment/trajectory/git/
rm -rf tests/core/ingest/pipeline/enrichment/trajectory/git/
```

Keep `src/core/ingest/pipeline/enrichment/trajectory/registry.ts` if it moves to
api/, or delete it too.

**Step 4: Run tests**

Run: `npx vitest run` Expected: some tests fail (deleted test files). Verify
remaining tests PASS.

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: delete duplicate git trajectory code from ingest layer"
```

---

### Task 11: Update api/trajectory-registry.ts to use contracts

**Files:**

- Modify: `src/core/api/trajectory-registry.ts` — all imports from contracts

**Step 1: Update imports**

Change:

```typescript
import type { FieldDoc, FilterDescriptor, ... } from "../trajectory/types.js";
```

To:

```typescript
import type { Signal, FilterDescriptor, ... } from "../contracts/index.js";
import type { QdrantFilter, QdrantFilterCondition } from "../adapters/qdrant/types.js";
```

**Step 2: Rename methods**

- `getAllPayloadFields()` → merge into `getAllSignals()` returning `Signal[]`
- Remove old `getAllSignals()` that returned `SignalDescriptor[]`

**Step 3: Update tests**

`tests/core/api/trajectory-registry.test.ts` — update mock contracts to use
`signals: Signal[]` instead of `payloadFields`.

**Step 4: Run tests**

Run: `npx vitest run` Expected: PASS

**Step 5: Commit**

```bash
git add src/core/api/trajectory-registry.ts tests/core/api/
git commit -m "refactor: trajectory-registry uses contracts layer"
```

---

## Phase 5: Final cleanup

### Task 12: Remove deprecated trajectory/types.ts re-exports

**Files:**

- Modify: `src/core/trajectory/types.ts` — minimize to only what trajectory/
  files need internally
- Modify: all trajectory/ files to import from contracts directly

**Step 1: Update all trajectory/ internal imports**

Find all files in `src/core/trajectory/` that import from `../types.js` or
`./types.js`. Change them to import from `../../contracts/index.js` (or
appropriate relative path).

**Step 2: Simplify trajectory/types.ts**

Keep only trajectory-specific types that don't belong in contracts (if any). If
empty, delete the file.

**Step 3: Run full test suite + type-check**

Run: `npx tsc --noEmit && npx vitest run` Expected: PASS

**Step 4: Commit**

```bash
git add -A
git commit -m "refactor: trajectory files import directly from contracts"
```

---

### Task 13: Verify no dependency violations remain

**Step 1: Grep for prohibited imports**

```bash
# trajectory -> ingest (MUST be 0)
rg "from.*ingest" src/core/trajectory/ --type ts

# search -> trajectory (MUST be 0)
rg "from.*trajectory" src/core/search/ --type ts

# search -> ingest (MUST be 0)
rg "from.*ingest" src/core/search/ --type ts

# ingest -> trajectory (MUST be 0, except registry if kept)
rg "from.*trajectory" src/core/ingest/ --type ts

# ingest -> search (MUST be 0)
rg "from.*search" src/core/ingest/ --type ts
```

**Step 2: Fix any remaining violations**

**Step 3: Run full test suite**

Run: `npx tsc --noEmit && npx vitest run` Expected: ALL PASS

**Step 4: Final commit**

```bash
git add -A
git commit -m "refactor: verify clean domain boundaries, no cross-layer violations"
```

---

## Summary

| Phase | Tasks | Description                                                                  |
| ----- | ----- | ---------------------------------------------------------------------------- |
| 1     | 1-3   | Create contracts/ layer, move Qdrant types to adapters, move signal-utils    |
| 2     | 4-5   | Rename types: FieldDoc→Signal, delete SignalDescriptor, fields.ts→signals.ts |
| 3     | 6-7   | Rename functions: buildFileMetadata→buildFileSignals, git type names         |
| 4     | 8-11  | Fix dependency violations, delete duplicate code, update registry            |
| 5     | 12-13 | Final cleanup, verify no violations                                          |

**Total commits:** ~13 **Estimated scope:** ~30-40 files modified, ~10 files
deleted
