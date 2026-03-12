# API Layer GRASP/SOLID Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development
> (if subagents available) or superpowers:executing-plans to implement this
> plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore GRASP/SOLID/DDD layer rules — eliminate all core/ → bootstrap/
imports, move collection utils to infra/, extract filter merge, clean up
ExploreFacade constructor.

**Architecture:** Foundation utilities move to `core/infra/`. Config types move
to `core/contracts/types/`. All resolved paths flow through `AppConfig.paths`
via DI. ExploreFacade uses named deps object and delegates filter merge to
TrajectoryRegistry.

**Tech Stack:** TypeScript, Vitest, Qdrant filter types

**Spec:** `docs/superpowers/specs/2026-03-13-api-grasp-cleanup-design.md`

---

## Chunk 1: Foundation Moves

### Task 1: Move collection utils to `infra/collection-name.ts` (`tea-rags-mcp-vqrq`)

**Files:**

- Create: `src/core/infra/collection-name.ts`
- Delete: `src/core/ingest/collection.ts`
- Test: `tests/core/infra/collection-name.test.ts` (create)
- Modify: all files importing from `ingest/collection.js` (8 files)

- [ ] **Step 1: Write tests for collection-name.ts**

Create `tests/core/infra/collection-name.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import {
  resolveCollection,
  resolveCollectionName,
  validatePath,
} from "../../../src/core/infra/collection-name.js";

describe("collection-name utilities", () => {
  describe("resolveCollectionName", () => {
    it("generates deterministic name from path", () => {
      const name = resolveCollectionName("/tmp/test-project");
      expect(name).toMatch(/^code_[a-f0-9]{8}$/);
    });

    it("returns same name for same path", () => {
      const a = resolveCollectionName("/tmp/test-project");
      const b = resolveCollectionName("/tmp/test-project");
      expect(a).toBe(b);
    });

    it("returns different names for different paths", () => {
      const a = resolveCollectionName("/tmp/project-a");
      const b = resolveCollectionName("/tmp/project-b");
      expect(a).not.toBe(b);
    });
  });

  describe("validatePath", () => {
    it("resolves existing path", async () => {
      const result = await validatePath("/tmp");
      expect(result).toBe("/private/tmp"); // macOS realpath
    });

    it("returns absolute path for non-existent path", async () => {
      const result = await validatePath("/nonexistent/path");
      expect(result).toBe("/nonexistent/path");
    });
  });

  describe("resolveCollection", () => {
    it("returns collection name when provided directly", () => {
      const result = resolveCollection("my_collection", undefined);
      expect(result.collectionName).toBe("my_collection");
      expect(result.path).toBeUndefined();
    });

    it("resolves collection name from path", () => {
      const result = resolveCollection(undefined, "/tmp/project");
      expect(result.collectionName).toMatch(/^code_[a-f0-9]{8}$/);
      expect(result.path).toBe("/tmp/project");
    });

    it("prefers collection over path", () => {
      const result = resolveCollection("explicit", "/tmp/project");
      expect(result.collectionName).toBe("explicit");
    });

    it("throws CollectionRefError when neither provided", () => {
      expect(() => resolveCollection(undefined, undefined)).toThrow(
        /collection.*path/i,
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/infra/collection-name.test.ts` Expected: FAIL —
module not found

- [ ] **Step 3: Create `src/core/infra/collection-name.ts`**

```typescript
/**
 * Collection name resolution and path validation utilities.
 *
 * Foundation layer — stateless pure functions used by all layers.
 * Moved from ingest/collection.ts to fix layer violations.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

export class CollectionRefError extends Error {
  constructor() {
    super("Either 'collection' or 'path' parameter is required.");
    this.name = "CollectionRefError";
  }
}

/**
 * Validate path — resolves to realpath if exists, absolute path otherwise.
 */
export async function validatePath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  try {
    return await fs.realpath(absolutePath);
  } catch {
    return absolutePath;
  }
}

/**
 * Generate deterministic collection name from codebase path.
 */
export function resolveCollectionName(path: string): string {
  const absolutePath = resolve(path);
  const hash = createHash("md5").update(absolutePath).digest("hex");
  return `code_${hash.substring(0, 8)}`;
}

/**
 * Resolve collection name from either explicit name or path.
 * @throws CollectionRefError if neither is provided.
 */
export function resolveCollection(
  collection?: string,
  path?: string,
): { collectionName: string; path?: string } {
  if (!collection && !path) throw new CollectionRefError();
  const collectionName = collection || resolveCollectionName(path as string);
  return { collectionName, path };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/infra/collection-name.test.ts` Expected: PASS

- [ ] **Step 5: Update all imports — replace `ingest/collection.js` with
      `infra/collection-name.js`**

Files to update (change import path only, no logic changes):

| File                                        | Old import                | New import                       |
| ------------------------------------------- | ------------------------- | -------------------------------- |
| `src/core/api/explore-facade.ts`            | `../ingest/collection.js` | `../infra/collection-name.js`    |
| `src/core/api/ingest-facade.ts`             | `../ingest/collection.js` | `../infra/collection-name.js`    |
| `src/core/infra/schema-drift-monitor.ts`    | `../ingest/collection.js` | `./collection-name.js`           |
| `src/core/ingest/pipeline/base.ts`          | `../collection.js`        | `../../infra/collection-name.js` |
| `src/core/ingest/pipeline/status-module.ts` | `../collection.js`        | `../../infra/collection-name.js` |

- [ ] **Step 6: Delete `src/core/ingest/collection.ts`**

- [ ] **Step 7: Run full test suite**

Run: `npx vitest run` Expected: PASS (all tests)

- [ ] **Step 8: Commit**

```bash
git add src/core/infra/collection-name.ts tests/core/infra/collection-name.test.ts
git add -u  # staged deletions + import changes
git commit -m "refactor(infra): move collection utils from ingest/ to infra/collection-name.ts"
```

---

### Task 2: Create `mergeQdrantFilters` + `TrajectoryRegistry.buildMergedFilter` (`tea-rags-mcp-zaj8`)

**Depends on:** Task 1

**Files:**

- Create: `src/core/adapters/qdrant/filter-utils.ts`
- Modify: `src/core/trajectory/index.ts`
- Test: `tests/core/adapters/qdrant/filter-utils.test.ts` (create)
- Test: `tests/core/trajectory/registry-filter.test.ts` (create)

- [ ] **Step 1: Write tests for `mergeQdrantFilters`**

Create `tests/core/adapters/qdrant/filter-utils.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { mergeQdrantFilters } from "../../../../src/core/adapters/qdrant/filter-utils.js";

describe("mergeQdrantFilters", () => {
  it("returns undefined when both are undefined", () => {
    expect(mergeQdrantFilters(undefined, undefined)).toBeUndefined();
  });

  it("returns a when b is undefined", () => {
    const a = { must: [{ key: "lang", match: { value: "ts" } }] };
    expect(mergeQdrantFilters(a, undefined)).toEqual(a);
  });

  it("returns b when a is undefined", () => {
    const b = { must: [{ key: "lang", match: { value: "ts" } }] };
    expect(mergeQdrantFilters(undefined, b)).toEqual(b);
  });

  it("merges must arrays", () => {
    const a = { must: [{ key: "lang", match: { value: "ts" } }] };
    const b = { must: [{ key: "path", match: { value: "src/" } }] };
    const result = mergeQdrantFilters(a, b);
    expect(result?.must).toHaveLength(2);
  });

  it("merges must_not arrays", () => {
    const a = { must_not: [{ key: "isDoc", match: { value: true } }] };
    const b = { must_not: [{ key: "lang", match: { value: "md" } }] };
    const result = mergeQdrantFilters(a, b);
    expect(result?.must_not).toHaveLength(2);
  });

  it("preserves should from raw filter (b) only", () => {
    const a = { should: [{ key: "type", match: { value: "fn" } }] };
    const b = {
      should: [{ key: "path", match: { value: "src/" } }],
      must: [{ key: "lang", match: { value: "ts" } }],
    };
    const result = mergeQdrantFilters(a, b);
    expect(result?.should).toHaveLength(1);
    expect(result?.should?.[0]).toEqual({
      key: "path",
      match: { value: "src/" },
    });
    expect(result?.must).toHaveLength(1);
  });

  it("handles empty arrays gracefully", () => {
    const a = { must: [] };
    const b = { must: [{ key: "lang", match: { value: "ts" } }] };
    const result = mergeQdrantFilters(a, b);
    expect(result?.must).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/core/adapters/qdrant/filter-utils.test.ts` Expected:
FAIL — module not found

- [ ] **Step 3: Implement `mergeQdrantFilters`**

Create `src/core/adapters/qdrant/filter-utils.ts`:

```typescript
/**
 * Qdrant filter merge utilities.
 *
 * Pure functions for combining Qdrant filter objects.
 * Used by TrajectoryRegistry.buildMergedFilter() to merge
 * typed filter output with raw user-provided filters.
 */

import type { QdrantFilter, QdrantFilterCondition } from "./types.js";

/**
 * Merge two Qdrant filters by concatenating must/must_not/should arrays.
 *
 * Returns undefined if both inputs are undefined or empty.
 */
export function mergeQdrantFilters(
  a: QdrantFilter | undefined,
  b: QdrantFilter | undefined,
): QdrantFilter | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;

  const must = concatArrays(a.must, b.must);
  const mustNot = concatArrays(a.must_not, b.must_not);
  // Preserve should from raw filter (b) only — typed filters never produce should
  const should = b.should;

  if (!must.length && !mustNot.length && !should.length) return undefined;

  const result: QdrantFilter = {};
  if (must.length > 0) result.must = must;
  if (mustNot.length > 0) result.must_not = mustNot;
  if (should.length > 0) result.should = should;
  return result;
}

function concatArrays(
  a?: QdrantFilterCondition[],
  b?: QdrantFilterCondition[],
): QdrantFilterCondition[] {
  return [...(a ?? []), ...(b ?? [])];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/core/adapters/qdrant/filter-utils.test.ts` Expected:
PASS

- [ ] **Step 5: Write test for `buildMergedFilter` in registry**

Create `tests/core/trajectory/registry-filter.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { TrajectoryRegistry } from "../../../src/core/trajectory/index.js";
import { StaticTrajectory } from "../../../src/core/trajectory/static/index.js";

describe("TrajectoryRegistry.buildMergedFilter", () => {
  it("merges typed filter with raw filter", () => {
    const registry = new TrajectoryRegistry();
    registry.register(new StaticTrajectory());

    const result = registry.buildMergedFilter(
      { language: "typescript" },
      { must: [{ key: "path", match: { text: "src/" } }] },
    );

    const must = (result as any)?.must as unknown[];
    expect(must).toHaveLength(2);
  });

  it("returns raw filter when no typed params match", () => {
    const registry = new TrajectoryRegistry();
    registry.register(new StaticTrajectory());

    const raw = { must: [{ key: "path", match: { text: "src/" } }] };
    const result = registry.buildMergedFilter({}, raw);
    expect(result).toEqual(raw);
  });

  it("returns undefined when both are empty", () => {
    const registry = new TrajectoryRegistry();
    const result = registry.buildMergedFilter({});
    expect(result).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run registry test to verify it fails**

Run: `npx vitest run tests/core/trajectory/registry-filter.test.ts` Expected:
FAIL — `buildMergedFilter` not defined

- [ ] **Step 7: Add `buildMergedFilter` to TrajectoryRegistry**

In `src/core/trajectory/index.ts`, add import and method:

Add import at top:

```typescript
import { mergeQdrantFilters } from "../adapters/qdrant/filter-utils.js";
```

Add method after `buildFilter()`:

```typescript
  /**
   * Build typed filter from params and merge with raw Qdrant filter.
   *
   * Combines registry's typed filter output with a user-provided raw filter.
   * Used by ExploreFacade to avoid owning merge logic.
   */
  buildMergedFilter(
    typedParams: Record<string, unknown>,
    rawFilter?: Record<string, unknown>,
    level: FilterLevel = "chunk",
  ): Record<string, unknown> | undefined {
    const typed = this.buildFilter(typedParams, level);
    return mergeQdrantFilters(
      typed,
      rawFilter as QdrantFilter | undefined,
    ) as Record<string, unknown> | undefined;
  }
```

- [ ] **Step 8: Run both test files**

Run:
`npx vitest run tests/core/adapters/qdrant/filter-utils.test.ts tests/core/trajectory/registry-filter.test.ts`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/core/adapters/qdrant/filter-utils.ts tests/core/adapters/qdrant/filter-utils.test.ts
git add src/core/trajectory/index.ts tests/core/trajectory/registry-filter.test.ts
git commit -m "refactor(adapters): extract mergeQdrantFilters, add TrajectoryRegistry.buildMergedFilter"
```

---

### Task 3: Move config types to `core/contracts/` (`tea-rags-mcp-fam6`)

**Files:**

- Create: `src/core/contracts/types/config.ts`
- Modify: `src/core/contracts/index.ts` (add re-export)
- Modify: `src/bootstrap/config/schemas.ts` (re-export from contracts)
- Modify: `src/core/trajectory/git/provider.ts` (change import)
- Modify: `src/core/adapters/qdrant/accumulator.ts` (change import)
- Modify: `src/core/adapters/embeddings/factory.ts` (change import)

- [ ] **Step 1: Read current type definitions**

Read the Zod-inferred types from `src/bootstrap/config/schemas.ts` (lines 85-92)
to extract the exact shape.

- [ ] **Step 2: Create `src/core/contracts/types/config.ts`**

Extract the type interfaces (not Zod schemas — just the plain TS types) that
core/ needs. Derive them from the Zod schemas or define equivalent interfaces
manually. The key types:

- `EmbeddingConfig` — provider, model, dimensions, API keys, tune settings
- `TrajectoryGitConfig` — git log settings, chunk settings, enabled flag
- `QdrantTuneConfig` — batch sizes, concurrency settings

Since these are `z.infer<>` types, the simplest approach is to keep the Zod
schemas in bootstrap/ and re-export the inferred types from contracts/:

```typescript
/**
 * Config types consumed by core/ layers.
 *
 * These types are inferred from Zod schemas in bootstrap/config/schemas.ts
 * but re-exported here so core/ doesn't import from bootstrap/.
 */

// Types defined here in contracts/ — bootstrap/config/schemas.ts re-exports
// them so existing bootstrap consumers keep working.
// core/ imports from here, not from bootstrap/.

// NOTE: These are manually-defined interfaces matching the Zod inference.
// If the Zod schema changes, these must be updated in sync.

export interface EmbeddingTuneConfig {
  batchSize: number;
  maxRequestsPerMinute: number;
  retryAttempts: number;
  retryDelayMs: number;
}

export interface EmbeddingConfig {
  provider: string;
  model?: string;
  dimensions?: number;
  baseUrl?: string;
  device?: string;
  openaiApiKey?: string;
  cohereApiKey?: string;
  voyageApiKey?: string;
  ollamaLegacyApi?: boolean;
  ollamaNumGpu?: number;
  tune: EmbeddingTuneConfig;
}

export interface TrajectoryGitConfig {
  enabled: boolean;
  squashAwareSessions: boolean;
  sessionGapMinutes: number;
  logMaxAgeMonths: number;
  logTimeoutMs: number;
  chunkConcurrency: number;
  chunkMaxAgeMonths: number;
  chunkTimeoutMs: number;
  chunkMaxFileLines: number;
}

export interface QdrantTuneConfig {
  upsertBatchSize: number;
  upsertConcurrency: number;
  deleteBatchSize: number;
  deleteConcurrency: number;
}
```

- [ ] **Step 3: Add re-export from `src/core/contracts/index.ts`**

Add line:

```typescript
export type {
  EmbeddingConfig,
  TrajectoryGitConfig,
  QdrantTuneConfig,
} from "./types/config.js";
```

- [ ] **Step 4: Update bootstrap to re-export from contracts**

In `src/bootstrap/config/schemas.ts`, replace the 3 type exports with re-exports
from contracts:

```typescript
// Before:
export type EmbeddingConfig = z.infer<typeof embeddingSchema>;
export type TrajectoryGitConfig = z.infer<typeof trajectoryGitSchema>;
export type QdrantTuneConfig = z.infer<typeof qdrantTuneSchema>;

// After:
export type {
  EmbeddingConfig,
  TrajectoryGitConfig,
  QdrantTuneConfig,
} from "../../core/contracts/types/config.js";
```

This keeps backward compatibility for any bootstrap/ consumers.

- [ ] **Step 5: Update core/ imports**

| File                             | Old import from                      | New import from                   |
| -------------------------------- | ------------------------------------ | --------------------------------- |
| `trajectory/git/provider.ts`     | `../../../bootstrap/config/index.js` | `../../contracts/types/config.js` |
| `adapters/qdrant/accumulator.ts` | `../../../bootstrap/config/index.js` | `../../contracts/types/config.js` |
| `adapters/embeddings/factory.ts` | `../../../bootstrap/config/index.js` | `../../contracts/types/config.js` |

- [ ] **Step 6: Run type-check and tests**

Run: `npx tsc --noEmit && npx vitest run` Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/core/contracts/types/config.ts src/core/contracts/index.ts
git add src/bootstrap/config/schemas.ts
git add src/core/trajectory/git/provider.ts src/core/adapters/qdrant/accumulator.ts src/core/adapters/embeddings/factory.ts
git commit -m "refactor(contracts): move EmbeddingConfig, TrajectoryGitConfig, QdrantTuneConfig to core/contracts"
```

---

## Chunk 2: Paths DI

### Task 4: Add `ResolvedPaths` to AppConfig, DI all path consumers (`tea-rags-mcp-c1sx`)

**Files:**

- Modify: `src/bootstrap/config/index.ts` (add paths to AppConfig)
- Modify: `src/bootstrap/factory.ts` (wire paths through DI)
- Modify: `src/core/api/ingest-facade.ts` (receive snapshotDir via param)
- Modify: `src/core/ingest/pipeline/base.ts` (receive via deps)
- Modify: `src/core/ingest/pipeline/status-module.ts` (add constructor param)
- Modify: `src/core/ingest/sync/synchronizer.ts` (add constructor param)
- Modify: `src/core/ingest/pipeline/infra/debug-logger.ts` (add init method)
- Modify: `src/core/adapters/embeddings/factory.ts` (accept paths in create)
- Modify: `src/core/adapters/qdrant/embedded/daemon.ts` (accept storagePath)
- Modify: `src/core/adapters/qdrant/embedded/download.ts` (accept binaryDir)
- Test: update tests that construct these classes

This task is large and atomic — all path consumers must be updated together
because removing path imports without providing DI alternatives breaks
compilation. Execute in this order:

- [ ] **Step 1: Add `ResolvedPaths` to AppConfig**

In `src/bootstrap/config/index.ts`:

```typescript
export interface ResolvedPaths {
  appData: string;
  snapshots: string;
  logs: string;
  models: string;
  daemonSocket: string;
  daemonPid: string;
}

export interface AppConfig {
  // ... existing fields ...
  paths: ResolvedPaths;
}
```

In `parseAppConfig()` return, add:

```typescript
paths: {
  appData: appDataDir(),
  snapshots: snapshotsDir(),
  logs: logsDir(),
  models: modelsDir(),
  daemonSocket: daemonSocketPath(),
  daemonPid: daemonPidFile(),
},
```

- [ ] **Step 2: Update `EmbeddingProviderFactory.create()` to accept paths**

In `src/core/adapters/embeddings/factory.ts`, change `create()` signature:

```typescript
static create(
  config: EmbeddingConfig,
  paths?: { models: string; daemonSocket: string; daemonPid: string },
): EmbeddingProvider {
```

Replace `modelsDir()`, `daemonSocketPath()`, `daemonPidFile()` calls with
`paths?.models`, `paths?.daemonSocket`, `paths?.daemonPid`. Remove the
bootstrap/config/paths import.

For the onnx case:

```typescript
case "onnx":
  return new OnnxEmbeddings(
    model || DEFAULT_ONNX_MODEL,
    dimensions,
    paths?.models,
    config.device,
    paths?.daemonSocket,
    paths?.daemonPid,
  );
```

- [ ] **Step 3: Update `daemon.ts` — accept storagePath param**

In `src/core/adapters/qdrant/embedded/daemon.ts`:

Change `getStoragePath()` to accept param:

```typescript
function getStoragePath(appDataPath?: string): string {
  return (
    process.env.QDRANT_EMBEDDED_STORAGE_PATH ??
    join(appDataPath ?? join(homedir(), ".tea-rags"), "qdrant")
  );
}
```

Update `ensureDaemon()` to accept and pass `appDataPath`:

```typescript
async function ensureDaemon(appDataPath?: string): Promise<DaemonHandle> {
  const storagePath = getStoragePath(appDataPath);
```

Update `resolveQdrantUrl()` to accept `appDataPath`:

```typescript
export async function resolveQdrantUrl(
  configuredUrl: string | undefined,
  appDataPath?: string,
): Promise<QdrantResolution> {
```

Remove `import { appDataDir } from "../../../../bootstrap/config/paths.js"`.

- [ ] **Step 4: Update `download.ts` — accept binaryDir param**

In `src/core/adapters/qdrant/embedded/download.ts`:

```typescript
export function getQdrantBinaryDir(appDataPath?: string): string {
  const base = appDataPath ?? join(homedir(), ".tea-rags");
  return join(base, "qdrant", "bin");
}

export function getBinaryPath(
  platform = process.platform,
  appDataPath?: string,
): string {
  const name = platform === "win32" ? "qdrant.exe" : "qdrant";
  return join(getQdrantBinaryDir(appDataPath), name);
}
```

Remove `import { appDataDir } from "../../../../bootstrap/config/paths.js"`. Add
`import { homedir } from "node:os"` if not present.

- [ ] **Step 5: Update `IngestFacade` — receive `snapshotDir` via constructor**

In `src/core/api/ingest-facade.ts`, add `snapshotDir: string` parameter:

```typescript
constructor(
  private readonly qdrant: QdrantManager,
  embeddings: EmbeddingProvider,
  ingestConfig: IngestCodeConfig,
  trajectoryConfig: TrajectoryIngestConfig,
  private readonly statsCache?: StatsCache,
  // ... other params ...
  private readonly snapshotDir?: string,
) {
  const dir = snapshotDir ?? join(homedir(), ".tea-rags", "snapshots");
  const deps = createIngestDependencies(qdrant, dir, ...);
```

Remove `import { snapshotsDir } from "../../bootstrap/config/paths.js"`.

- [ ] **Step 6: Update `StatusModule` — add `snapshotDir` constructor param**

```typescript
constructor(
  private readonly qdrant: QdrantManager,
  private readonly snapshotDir?: string,
) {}
```

In `clearIndex()`, replace `snapshotsDir()` with `this.snapshotDir`:

```typescript
const dir = this.snapshotDir ?? join(homedir(), ".tea-rags", "snapshots");
const synchronizer = new ParallelFileSynchronizer(
  absolutePath,
  collectionName,
  dir,
);
```

Remove bootstrap import.

- [ ] **Step 7: Update `FileSynchronizer` — add `snapshotDir` constructor
      param**

`FileSynchronizer` already receives `snapshotDir` via `ParallelFileSynchronizer`
which passes it from `createIngestDependencies`. But `FileSynchronizer` ALSO
calls `snapshotsDir()` directly in its constructor. Add `snapshotDir: string` as
third constructor param:

```typescript
constructor(
  private readonly codebasePath: string,
  collectionName: string,
  snapshotDir: string,
) {
  this.collectionName = collectionName;
  const snapshotPath = join(snapshotDir, `${collectionName}.json`);
  this.checkpointPath = join(snapshotDir, `${collectionName}.checkpoint.json`);
```

Remove `import { snapshotsDir } from "../../../bootstrap/config/paths.js"`.

Also check and update any other `snapshotsDir()` calls in the file (line 338) to
use the stored value.

- [ ] **Step 8: Update `BaseIndexingPipeline` — use deps instead of direct
      import**

Replace the `snapshotDir` getter:

```typescript
protected get snapshotDir(): string {
  return this.deps.snapshotDir;
}
```

This requires adding `snapshotDir` to `IngestDependencies` interface in
`src/core/ingest/factory.ts`:

```typescript
export interface IngestDependencies {
  // ... existing fields ...
  snapshotDir: string;
}
```

And in `createIngestDependencies`, add:

```typescript
return {
  snapshotDir,
  // ... existing fields ...
};
```

Remove `import { snapshotsDir } from "../../../bootstrap/config/paths.js"` from
base.ts.

- [ ] **Step 9: Update `debug-logger.ts` — add init method**

```typescript
let LOG_DIR = ""; // Set by init()

export function initDebugLogger(opts: {
  logsDir: string;
  configDump?: () => Record<string, unknown>;
  concurrency?: {
    pipeline: number;
    chunkerPool: number;
    fileConcurrency: number;
  };
}): void {
  LOG_DIR = opts.logsDir;
  // Store configDump and concurrency for later use
}
```

Remove
`import { getConfigDump, getZodConfig, logsDir } from "../../../../bootstrap/config/index.js"`.

Call `initDebugLogger()` from `bootstrap/factory.ts` after parsing config.

- [ ] **Step 10: Update `bootstrap/factory.ts` — wire all paths**

```typescript
const config = parseAppConfig();
const { paths } = config;

// Init debug logger early
initDebugLogger({
  logsDir: paths.logs,
  configDump: () => getConfigDump(zodConfig),
  concurrency: { ... },
});

// Pass paths to resolveQdrantUrl
const resolution = await resolveQdrantUrl(config.qdrantUrl, paths.appData);

// Pass paths to embedding factory
const embeddings = EmbeddingProviderFactory.create(zodConfig.embedding, {
  models: paths.models,
  daemonSocket: paths.daemonSocket,
  daemonPid: paths.daemonPid,
});

// Pass snapshotDir to IngestFacade and StatsCache
const statsCache = new StatsCache(paths.snapshots);
const ingest = new IngestFacade(
  qdrant, embeddings, config.ingestCode, config.trajectoryIngest,
  statsCache, allPayloadSignalDescriptors, reranker,
  deleteConfig, pipelineTuning, syncTuning, paths.snapshots,
);
```

- [ ] **Step 11: Run type-check and full test suite**

Run: `npx tsc --noEmit && npx vitest run` Expected: PASS

Fix any test constructors that need the new params.

- [ ] **Step 12: Verify no core/ → bootstrap/config/paths.ts imports remain**

Run: `grep -r "bootstrap/config/paths" src/core/` Expected: No matches

- [ ] **Step 13: Commit**

```bash
git add -u
git add src/core/contracts/types/config.ts  # if not already staged
git commit -m "refactor(config): add ResolvedPaths to AppConfig, DI all path consumers

Eliminates all core/ → bootstrap/config/paths.ts imports.
Paths resolved once at startup, injected via constructors."
```

---

## Chunk 3: ExploreFacade Cleanup

### Task 5: ExploreFacade deps object + delegate buildMergedFilter (`tea-rags-mcp-dmna`)

**Depends on:** Task 1, Task 2

**Files:**

- Modify: `src/core/api/explore-facade.ts`
- Modify: `src/bootstrap/factory.ts` (update construction)
- Test: `tests/core/api/explore-facade.test.ts`
- Test: `tests/core/api/explore-facade-expanded.test.ts`
- Test: `tests/core/api/explore-facade-filter.test.ts`
- Test: `tests/core/ingest/indexer.test.ts`

- [ ] **Step 1: Define `ExploreFacadeDeps` and update constructor**

In `src/core/api/explore-facade.ts`:

```typescript
export interface ExploreFacadeDeps {
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  reranker: Reranker;
  registry: TrajectoryRegistry;
  statsCache?: StatsCache;
  schemaDriftMonitor?: SchemaDriftMonitor;
  payloadSignals?: PayloadSignalDescriptor[];
  essentialKeys?: string[];
}

export class ExploreFacade {
  private readonly qdrant: QdrantManager;
  private readonly embeddings: EmbeddingProvider;
  private readonly reranker: Reranker;
  private readonly registry: TrajectoryRegistry;
  private readonly statsCache?: StatsCache;
  private readonly schemaDriftMonitor?: SchemaDriftMonitor;
  private readonly vectorStrategy: BaseExploreStrategy;
  private readonly hybridStrategy: BaseExploreStrategy;
  private readonly scrollRankStrategy: BaseExploreStrategy;

  constructor(deps: ExploreFacadeDeps) {
    this.qdrant = deps.qdrant;
    this.embeddings = deps.embeddings;
    this.reranker = deps.reranker;
    this.registry = deps.registry;
    this.statsCache = deps.statsCache;
    this.schemaDriftMonitor = deps.schemaDriftMonitor;

    const signals = deps.payloadSignals ?? [];
    const keys = deps.essentialKeys ?? [];
    this.vectorStrategy = createExploreStrategy("vector", deps.qdrant, deps.reranker, signals, keys);
    this.hybridStrategy = createExploreStrategy("hybrid", deps.qdrant, deps.reranker, signals, keys);
    this.scrollRankStrategy = createExploreStrategy("scroll-rank", deps.qdrant, deps.reranker, signals, keys);
  }
```

- [ ] **Step 2: Replace `buildMergedFilter` with registry delegation**

Remove the private `buildMergedFilter()` method. In each public method, replace:

```typescript
// Before:
const filter = this.buildMergedFilter(request, request.filter);

// After:
const filter = this.registry.buildMergedFilter(request, request.filter);
```

For `rankChunks`:

```typescript
const filter = this.registry.buildMergedFilter(
  request,
  request.filter,
  request.level,
);
```

- [ ] **Step 3: Replace `resolveCollection` with infra import**

Remove the private `resolveCollection()` method AND the `CollectionRefError`
class declaration from `explore-facade.ts` (both move to infra/ in Task 1).
Import from infra instead:

```typescript
import {
  CollectionRefError,
  resolveCollection,
} from "../infra/collection-name.js";
```

In each public method, change:

```typescript
// Before:
const { collectionName, path } = this.resolveCollection(
  request.collection,
  request.path,
);

// After:
const { collectionName, path } = resolveCollection(
  request.collection,
  request.path,
);
```

- [ ] **Step 4: Update `bootstrap/factory.ts`**

```typescript
const explore = new ExploreFacade({
  qdrant,
  embeddings,
  reranker,
  registry,
  statsCache,
  schemaDriftMonitor,
  payloadSignals: allPayloadSignalDescriptors,
  essentialKeys: essentialTrajectoryFields,
});
```

- [ ] **Step 5: Update all test files**

Every test that creates `ExploreFacade` needs updating. Replace positional args
with deps object:

```typescript
// Before:
new ExploreFacade(
  qdrant,
  embeddings,
  reranker,
  registry,
  statsCache,
  [],
  [],
  driftMonitor,
);

// After:
new ExploreFacade({
  qdrant,
  embeddings,
  reranker,
  registry,
  statsCache,
  schemaDriftMonitor: driftMonitor,
});
```

Files to update:

- `tests/core/api/explore-facade.test.ts`
- `tests/core/api/explore-facade-expanded.test.ts`
- `tests/core/api/explore-facade-filter.test.ts`
- `tests/core/ingest/indexer.test.ts`

- [ ] **Step 6: Run full test suite**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add -u
git commit -m "refactor(explore): ExploreFacade deps object, delegate buildMergedFilter to registry

Replace 8 positional constructor params with named ExploreFacadeDeps.
Remove buildMergedFilter (delegated to TrajectoryRegistry).
Remove resolveCollection (moved to infra/collection-name)."
```

---

### Task 6: Update CLAUDE.md (`tea-rags-mcp-3qkb`)

**Files:**

- Modify: `.claude/CLAUDE.md`

- [ ] **Step 1: Update infra/ description**

In the Layer Responsibilities section, change:

```
**core/infra/** — Runtime utilities (foundation, lowest level)
- isDebug(), setDebug() — runtime config imported by all layers
```

To:

```
**core/infra/** — Foundation utilities (lowest level)
- isDebug(), setDebug() — runtime config imported by all layers
- collection-name.ts: validatePath, resolveCollectionName, resolveCollection
```

In the project structure section, add under `infra/`:

```
  infra/                               # Foundation: utilities (lowest layer)
    runtime.ts                         # isDebug(), setDebug()
    collection-name.ts                 # validatePath, resolveCollectionName, resolveCollection
    schema-drift-monitor.ts            # SchemaDriftMonitor: payload version tracking
    stats-cache.ts                     # StatsCache: collection signal stats persistence
```

- [ ] **Step 2: Commit**

```bash
git add .claude/CLAUDE.md
git commit -m "docs(infra): update CLAUDE.md infra/ layer description"
```

---

### Task 7: Final verification (`tea-rags-mcp-5723`)

**Depends on:** Tasks 1-6

- [ ] **Step 1: Full type-check**

Run: `npx tsc --noEmit` Expected: PASS

- [ ] **Step 2: Full test suite**

Run: `npx vitest run` Expected: PASS

- [ ] **Step 3: Verify no layer violations remain**

Run these greps — all must return zero matches:

```bash
# No core/ → bootstrap/config/paths.ts imports
grep -r "bootstrap/config/paths" src/core/

# No infra/ → domain module imports
grep -r "from.*\.\./ingest/" src/core/infra/
grep -r "from.*\.\./explore/" src/core/infra/
grep -r "from.*\.\./trajectory/" src/core/infra/

# No core/ → bootstrap/config type imports (except re-exports)
grep -r "from.*bootstrap/config" src/core/ | grep -v "\.d\.ts"
```

Expected: No matches for any of the above

- [ ] **Step 4: Commit fixes if any**

```bash
git add -u
git commit -m "chore(api): fix lint/type issues after GRASP cleanup"
```
