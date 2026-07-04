# Domain Boundaries Refactoring — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to
> implement this plan task-by-task.

**Goal:** Fix all layer boundary violations, introduce `infra/` layer, rename
`search/` → `explore/`, update CLAUDE.md.

**Architecture:** Bottom-up approach — create foundation layer first (`infra/`),
then move misplaced utilities, then fix DI violations, then rename directory,
finally update docs.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Extract `isDebug` into `core/infra/runtime.ts`

**Files:**

- Create: `src/core/infra/runtime.ts`
- Modify: `src/core/ingest/pipeline/infra/runtime.ts` — re-export from new
  location
- Modify: `src/core/adapters/embeddings/ollama.ts` — update import
- Modify: `src/core/adapters/git/client.ts` — update import
- Modify: `src/core/trajectory/git/infra/chunk-reader.ts` — update import
- Modify: `src/core/trajectory/git/infra/file-reader.ts` — update import

**Step 1: Create `src/core/infra/runtime.ts`**

```typescript
/**
 * Runtime config — set once at startup, read many times.
 * Lives in infra/ (lowest layer) so all layers can import it.
 */
let _debug = false;

export function setDebug(value: boolean): void {
  _debug = value;
}

export function isDebug(): boolean {
  return _debug;
}
```

**Step 2: Update `src/core/ingest/pipeline/infra/runtime.ts` to re-export**

Replace entire file with:

```typescript
/**
 * @deprecated Import from "core/infra/runtime.js" instead.
 * Re-export kept for backward compatibility during migration.
 */
export { isDebug, setDebug } from "../../../infra/runtime.js";
```

**Step 3: Update imports in 4 files**

In each file, change the import path from
`../../ingest/pipeline/infra/runtime.js` (or
`../../../ingest/pipeline/infra/runtime.js`) to point to
`../../infra/runtime.js` (adjusted for depth):

- `src/core/adapters/embeddings/ollama.ts`:
  `import { isDebug } from "../../infra/runtime.js";`
- `src/core/adapters/git/client.ts`:
  `import { isDebug } from "../../infra/runtime.js";`
- `src/core/trajectory/git/infra/chunk-reader.ts`:
  `import { isDebug } from "../../../../infra/runtime.js";`
- `src/core/trajectory/git/infra/file-reader.ts`:
  `import { isDebug } from "../../../../infra/runtime.js";`

**Step 4: Run tests**

Run: `npx vitest run` Expected: All tests pass (behavior unchanged, only import
paths moved).

**Step 5: Commit**

```bash
git add src/core/infra/runtime.ts src/core/ingest/pipeline/infra/runtime.ts \
  src/core/adapters/embeddings/ollama.ts src/core/adapters/git/client.ts \
  src/core/trajectory/git/infra/chunk-reader.ts src/core/trajectory/git/infra/file-reader.ts
git commit -m "refactor(infra): extract isDebug into core/infra layer"
```

---

### Task 2: Move collection utilities from `contracts/` to `ingest/`

**Files:**

- Move: `src/core/contracts/collection.ts` → `src/core/ingest/collection.ts`
- Move: `src/core/contracts/collection-stats.ts` →
  `src/core/ingest/collection-stats.ts`
- Modify: `src/core/contracts/index.ts` — remove re-exports
- Modify: `src/core/api/ingest-facade.ts` — update import paths
- Modify: `src/core/api/search-facade.ts` — update import path
- Modify: `src/core/api/schema-drift-monitor.ts` — update import path
- Modify: `src/core/ingest/pipeline/base.ts` — update import path
- Modify: `src/core/ingest/pipeline/status-module.ts` — update import path

**Step 1: Move files**

```bash
mv src/core/contracts/collection.ts src/core/ingest/collection.ts
mv src/core/contracts/collection-stats.ts src/core/ingest/collection-stats.ts
```

**Step 2: Fix internal import in `collection-stats.ts`**

The moved file imports from `./types/trajectory.js`. Update to:

```typescript
import type {
  CollectionSignalStats,
  PayloadSignalDescriptor,
  SignalStats,
} from "../contracts/types/trajectory.js";
```

**Step 3: Update `src/core/contracts/index.ts`**

Remove these two lines:

```typescript
export { computeCollectionStats } from "./collection-stats.js";
export { resolveCollectionName, validatePath } from "./collection.js";
```

**Step 4: Update import paths in all consumers**

Each file changes its import from `../contracts/collection.js` to
`../ingest/collection.js` (api/ files) or `../../contracts/collection.js` to
`../collection.js` (ingest/ files):

- `src/core/api/ingest-facade.ts`:
  - `import { computeCollectionStats } from "../ingest/collection-stats.js";`
  - `import { resolveCollectionName, validatePath } from "../ingest/collection.js";`
- `src/core/api/search-facade.ts`:
  - `import { resolveCollectionName, validatePath } from "../ingest/collection.js";`
- `src/core/api/schema-drift-monitor.ts`:
  - `import { resolveCollectionName, validatePath } from "../ingest/collection.js";`
- `src/core/ingest/pipeline/base.ts`:
  - `import { resolveCollectionName, validatePath } from "../collection.js";`
- `src/core/ingest/pipeline/status-module.ts`:
  - `import { resolveCollectionName, validatePath } from "../collection.js";`

**Step 5: Remove `resolveCollectionName`/`validatePath` from
`search-module.ts`**

`search-module.ts` currently calls `validatePath` and `resolveCollectionName`.
After this refactoring, explore/ should receive `collectionName` as parameter.
But this changes the interface — defer to Task 3 (TrajectoryRegistry DI fix).

For now, update the import path only:

- `src/core/search/search-module.ts`:
  - `import { resolveCollectionName, validatePath } from "../ingest/collection.js";`

Note: This is a temporary cross-domain violation (`search/` → `ingest/`). Task 3
removes it.

**Step 6: Run tests**

Run: `npx vitest run` Expected: All tests pass.

**Step 7: Commit**

```bash
git add src/core/contracts/collection.ts src/core/contracts/collection-stats.ts \
  src/core/ingest/collection.ts src/core/ingest/collection-stats.ts \
  src/core/contracts/index.ts \
  src/core/api/ingest-facade.ts src/core/api/search-facade.ts \
  src/core/api/schema-drift-monitor.ts \
  src/core/ingest/pipeline/base.ts src/core/ingest/pipeline/status-module.ts \
  src/core/search/search-module.ts
git commit -m "refactor(ingest): move collection utilities from contracts to ingest"
```

---

### Task 3: Remove `search/` → `trajectory/` dependency via DI

SearchModule currently imports `TrajectoryRegistry` from `trajectory/index.js`.
Fix: pass needed capabilities via constructor.

**Files:**

- Modify: `src/core/search/search-module.ts` — replace TrajectoryRegistry with
  filter-building function
- Modify: `src/core/api/search-facade.ts` — pass filter builder from registry
- Modify: `src/core/api/composition.ts` — no changes needed (already passes
  registry)
- Modify: `tests/core/search/search-module.test.ts` — update mock
- Modify: `tests/core/api/search-facade.test.ts` — update mock

**Step 1: Define filter builder type**

In `src/core/search/search-module.ts`, replace the `TrajectoryRegistry` import
with a function type:

Remove:

```typescript
import type { TrajectoryRegistry } from "../trajectory/index.js";
```

Also remove:

```typescript
import { resolveCollectionName, validatePath } from "../ingest/collection.js";
```

Add (at top, after existing imports):

```typescript
/** Builds Qdrant filter from search params. Injected by api/ layer. */
export type FilterBuilder = (
  params: Record<string, unknown>,
  level?: string,
) => Record<string, unknown> | undefined;
```

**Step 2: Update SearchModule constructor**

Change constructor parameter:

```typescript
constructor(
  private readonly qdrant: QdrantManager,
  private readonly embeddings: EmbeddingProvider,
  private readonly config: SearchCodeConfig,
  private readonly reranker: Reranker,
  private readonly collectionName: string,
  private readonly buildFilter?: FilterBuilder,
) {}
```

**Step 3: Update `searchCode` method**

Remove path resolution (caller provides collectionName). Change method
signature:

```typescript
async searchCode(query: string, options?: SearchOptions): Promise<CodeSearchResult[]> {
  // Remove these lines:
  // const absolutePath = await validatePath(path);
  // const collectionName = resolveCollectionName(absolutePath);

  // Use this.collectionName directly
  const collectionName = this.collectionName;

  // ... rest unchanged, except replace registry?.buildFilter with this.buildFilter?.()
```

Replace:

```typescript
const trajectoryFilter = this.registry?.buildFilter(...)
```

With:

```typescript
const trajectoryFilter = this.buildFilter?.({...}, "chunk") as QdrantFilter | undefined;
```

**Step 4: Update `SearchFacade` to pass collectionName and filterBuilder**

In `src/core/api/search-facade.ts`:

```typescript
import { resolveCollectionName, validatePath } from "../ingest/collection.js";
import type { TrajectoryRegistry } from "../trajectory/index.js";

export class SearchFacade {
  constructor(
    private readonly qdrant: QdrantManager,
    private readonly embeddings: EmbeddingProvider,
    private readonly config: SearchCodeConfig,
    private readonly reranker: Reranker,
    private readonly registry?: TrajectoryRegistry,
    private readonly statsCache?: StatsCache,
  ) {}

  async searchCode(
    path: string,
    query: string,
    options?: SearchOptions,
  ): Promise<CodeSearchResult[]> {
    if (this.statsCache && !this.reranker.hasCollectionStats) {
      await this.loadStatsFromCache(path);
    }
    const absolutePath = await validatePath(path);
    const collectionName = resolveCollectionName(absolutePath);
    const filterBuilder = this.registry
      ? (params: Record<string, unknown>, level?: string) =>
          this.registry!.buildFilter(
            params,
            (level as "chunk" | "file") ?? "chunk",
          )
      : undefined;
    const search = new SearchModule(
      this.qdrant,
      this.embeddings,
      this.config,
      this.reranker,
      collectionName,
      filterBuilder,
    );
    return search.searchCode(query, options);
  }
}
```

Note: SearchModule is now created per-call with resolved collectionName. This is
lightweight (no state).

**Step 5: Update tests**

- `tests/core/search/search-module.test.ts` — update constructor calls, remove
  path from searchCode
- `tests/core/api/search-facade.test.ts` — verify mock passes through correctly

**Step 6: Run tests**

Run: `npx vitest run` Expected: All tests pass.

**Step 7: Commit**

```bash
git add src/core/search/search-module.ts src/core/api/search-facade.ts \
  tests/core/search/search-module.test.ts tests/core/api/search-facade.test.ts
git commit -m "refactor(search): remove trajectory dependency via DI filter builder"
```

---

### Task 4: Rename `search/` → `explore/`

**Files:**

- Rename: `src/core/search/` → `src/core/explore/`
- Rename: `tests/core/search/` → `tests/core/explore/`
- Rename: `src/core/api/search-facade.ts` → `src/core/api/explore-facade.ts`
- Rename: `tests/core/api/search-facade.test.ts` →
  `tests/core/api/explore-facade.test.ts`
- Update all import paths referencing `/search/` across src/ and tests/

**Step 1: Rename directories and facade file**

```bash
mv src/core/search src/core/explore
mv tests/core/search tests/core/explore
mv src/core/api/search-facade.ts src/core/api/explore-facade.ts
mv tests/core/api/search-facade.test.ts tests/core/api/explore-facade.test.ts
```

**Step 2: Update all import paths in `src/`**

Files with `/search/` imports (update to `/explore/`):

- `src/core/api/composition.ts`:
  - `../search/rerank/presets/index.js` → `../explore/rerank/presets/index.js`
  - `../search/reranker.js` → `../explore/reranker.js`
- `src/core/api/explore-facade.ts` (was search-facade.ts):
  - `../search/reranker.js` → `../explore/reranker.js`
  - `../search/search-module.js` → `../explore/search-module.js`
- `src/core/api/ingest-facade.ts`:
  - `../search/reranker.js` → `../explore/reranker.js`
- `src/core/api/schema-builder.ts`:
  - `../search/reranker.js` → `../explore/reranker.js`
- `src/mcp/tools/index.ts`:
  - `../../core/search/reranker.js` → `../../core/explore/reranker.js`
- `src/mcp/tools/search.ts`:
  - `../../core/search/rank-module.js` → `../../core/explore/rank-module.js`
  - `../../core/search/reranker.js` → `../../core/explore/reranker.js`
- `src/mcp/tools/formatters/search-pipeline.ts`:
  - `../../../core/search/reranker.js` → `../../../core/explore/reranker.js`

Internal imports within `src/core/explore/` (files reference each other with
`./`): no changes needed.

**Step 3: Update all import paths in `tests/`**

- `tests/core/explore/reranker.test.ts`:
  - `../../../src/core/search/rerank/presets/index.js` →
    `../../../src/core/explore/rerank/presets/index.js`
  - `../../../src/core/search/reranker.js` →
    `../../../src/core/explore/reranker.js`
- `tests/core/explore/search-module.test.ts`:
  - `../../../src/core/search/rerank/presets/index.js` →
    `../../../src/core/explore/rerank/presets/index.js`
  - `../../../src/core/search/reranker.js` →
    `../../../src/core/explore/reranker.js`
- `tests/core/explore/rank-module.test.ts`:
  - `../../../src/core/search/rank-module.js` →
    `../../../src/core/explore/rank-module.js`
  - `../../../src/core/search/reranker.js` →
    `../../../src/core/explore/reranker.js`
- `tests/core/explore/presets/index.test.ts`:
  - `../../../../src/core/search/rerank/presets/index.js` →
    `../../../../src/core/explore/rerank/presets/index.js`
- `tests/core/explore/rerank/presets/decomposition.test.ts`:
  - `../../../../../src/core/search/reranker.js` →
    `../../../../../src/core/explore/reranker.js`
- `tests/core/explore/rerank/derived-signals/chunk-size.test.ts`:
  - Check and update any `/search/` imports
- `tests/core/explore/rerank/derived-signals/chunk-density.test.ts`:
  - Check and update any `/search/` imports
- `tests/core/explore/rerank-rank-chunks-fixes.test.ts`:
  - `../../../src/core/search/reranker.js` →
    `../../../src/core/explore/reranker.js`
- `tests/core/explore/structural-signals.test.ts`:
  - Check and update any `/search/` imports
- `tests/core/api/explore-facade.test.ts`:
  - `../../../src/core/search/search-module.js` →
    `../../../src/core/explore/search-module.js`
- `tests/core/api/schema-builder.test.ts`:
  - `../../../src/core/search/reranker.js` →
    `../../../src/core/explore/reranker.js`
- `tests/core/api/stats-lifecycle.test.ts`:
  - `../../../src/core/search/reranker.js` →
    `../../../src/core/explore/reranker.js`
- `tests/core/ingest/indexer.test.ts`:
  - `../../../src/core/search/rerank/presets/index.js` →
    `../../../src/core/explore/rerank/presets/index.js`
  - `../../../src/core/search/reranker.js` →
    `../../../src/core/explore/reranker.js`
- `tests/integration/integration.test.ts`:
  - `../../src/core/search/rerank/presets/index.js` →
    `../../src/core/explore/rerank/presets/index.js`
  - `../../src/core/search/reranker.js` → `../../src/core/explore/reranker.js`
- `tests/mcp/tools/formatters/search-pipeline.test.ts`:
  - `../../../../src/core/search/reranker.js` →
    `../../../../src/core/explore/reranker.js`
- `tests/bootstrap/factory.test.ts`:
  - `../../src/core/search/reranker.js` → `../../src/core/explore/reranker.js`
  - `../../src/core/search/rerank/presets/index.js` →
    `../../src/core/explore/rerank/presets/index.js`

**Step 4: Run tests**

Run: `npx vitest run` Expected: All tests pass.

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor(explore): rename search module to explore"
```

---

### Task 5: Update CLAUDE.md

**Files:**

- Modify: `.claude/CLAUDE.md` — update layer diagram, dependency rules, project
  structure

**Step 1: Update layer diagram**

Replace the current diagram in "Layer Dependency Rules" section with:

```
                  api/                            ← Composition root
               ↗   ↑   ↖                           Imports from: everything (assembles DI)
             /     |     \
          explore/ trajectory/ ingest/            ← Domain modules
             \     |     /                          Import from: contracts/, infra/
              ↘    ↓    ↙                           NOT from each other
          contracts/   adapters/   infra/         ← Foundation (lowest level)
```

**Step 2: Update dependency table**

| Layer              | Imports from                                  | Exports to             |
| ------------------ | --------------------------------------------- | ---------------------- |
| `core/api/`        | domain modules, contracts/, adapters/, infra/ | external consumers     |
| `core/explore/`    | `contracts/`, `infra/`                        | `api/`                 |
| `core/trajectory/` | `contracts/`, `adapters/`, `infra/`           | `api/`                 |
| `core/ingest/`     | `contracts/`, `adapters/`, `infra/`           | `api/`                 |
| `core/contracts/`  | `infra/`                                      | domain modules, `api/` |
| `core/adapters/`   | `infra/`                                      | domain modules, `api/` |
| `core/infra/`      | nothing                                       | all layers             |

**Step 3: Update prohibited dependencies**

```
- Domain modules → each other (`explore` ↔ `trajectory` ↔ `ingest`)
- Foundation → any layer above (`contracts`/`adapters`/`infra` → domain modules or `api/`)
```

Remove the old rule about `api/` not importing from `contracts/` and
`adapters/`.

**Step 4: Update Project Structure section**

Replace `search/` with `explore/` throughout the tree. Add `infra/` section:

```
  infra/                                         # Foundation: runtime utilities
    runtime.ts                                   # isDebug(), setDebug() — lowest layer
```

Move `collection.ts` and `collection-stats.ts` entries from `contracts/` to
`ingest/`.

**Step 5: Update any references to `search/` in terminology table and other
sections**

Replace `search/` → `explore/` in descriptions:

- "core/search/" → "core/explore/"
- search-module → search-module (file name stays)

**Step 6: Commit**

```bash
git add .claude/CLAUDE.md
git commit -m "docs(config): update CLAUDE.md for domain boundaries and explore rename"
```

---

### Task 6: Close beads issues

**Step 1: Close issues**

```bash
bd close tea-rags-mcp-c13 --reason="Included in domain boundaries refactoring"
bd update tea-rags-mcp-k62 --status=in_progress
```

**Step 2: Final verification**

Run: `npx vitest run` Run: `npx tsc --noEmit` Expected: All tests pass, no type
errors.

```bash
bd close tea-rags-mcp-k62
```
