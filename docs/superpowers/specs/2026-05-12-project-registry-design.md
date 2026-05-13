# Project Registry — Auto-Populated Collection Metadata + Named Projects

> **Status:** Draft **Date:** 2026-05-12 **Beads:** tea-rags-mcp-gr4o (∪ 2mrz)

**Goal:** Persistent registry of named projects and their collection metadata,
replacing path-resolution defaults. Foundation for `tea-rags doctor` (1wxw),
auto-update watcher (hpg2), sub-collections (fl2q), and federated search
(separate shipment).

This spec supersedes the original `2026-03-18-project-registry-design.md` draft
and merges the scope of beads issue `tea-rags-mcp-2mrz` (Project Registry MCP
tools) with `tea-rags-mcp-gr4o` (Collection registry). Groups and federated
search are excluded and remain as separate work.

---

## 1. Concept

Two layers in one file:

- **Collection metadata layer** (auto-populated at end of indexing):
  `embeddingModel`, `embeddingDimensions`, `qdrantUrl`, `indexedAt`,
  `teaRagsVersion`, `chunksCount`.
- **Project name layer** (user-controlled): unique optional `name` per project.
  Lets MCP/CLI callers reference a project by name instead of `path` /
  `collection`.

**Authority shift.** Today, the source of truth for project path is the caller's
`cwd` (CLI) or the `path` parameter (MCP). After this change, the source of
truth is the registry; `cwd` / explicit `path` are fallbacks. Resolution
priority becomes `collection` > `project` (name) > `path` > error.

---

## 2. Schema

**Location:** `$TEA_RAGS_DATA_DIR/registry.json` (default
`~/.tea-rags/registry.json`).

```json
{
  "version": 1,
  "collections": {
    "code_abc123": {
      "path": "/home/user/production-rails-app",
      "name": "production-rails-app",
      "embeddingModel": "Xenova/all-MiniLM-L6-v2",
      "embeddingDimensions": 384,
      "qdrantUrl": "http://localhost:6333",
      "indexedAt": "2026-05-12T14:21:08.231Z",
      "teaRagsVersion": "0.42.1",
      "chunksCount": 12345
    }
  }
}
```

**Field semantics:**

| Field                 | Type                            | Source                                      | Required | Sticky on reindex                  |
| --------------------- | ------------------------------- | ------------------------------------------- | -------- | ---------------------------------- |
| `version`             | `1` literal                     | constant                                    | yes      | yes                                |
| `collections`         | `Record<collectionName, Entry>` | —                                           | yes      | —                                  |
| Entry key             | `collectionName` (alias)        | `resolveCollectionName(path)` deterministic | —        | yes                                |
| `path`                | absolute path string            | indexing input                              | yes      | overwritten (path may move)        |
| `name`                | `string \| null`                | user via `register_project`                 | optional | **yes — preserved across reindex** |
| `embeddingModel`      | `string`                        | embedding provider                          | yes      | overwritten                        |
| `embeddingDimensions` | `number`                        | embedding provider                          | yes      | overwritten                        |
| `qdrantUrl`           | `string`                        | `QdrantManager.url`                         | yes      | overwritten                        |
| `indexedAt`           | ISO8601 string                  | `new Date().toISOString()`                  | yes      | overwritten                        |
| `teaRagsVersion`      | `string`                        | `package.json` version                      | yes      | overwritten                        |
| `chunksCount`         | `number`                        | `qdrant.count(collectionName)` at finalize  | yes      | overwritten                        |

**Schema-level invariants:**

- Loading a file with `version != 1` throws `RegistryFileCorruptedError`. Future
  migrations will be added when needed.
- `name` is unique across all entries (enforced at `setName` /
  `register_project`).
- `name` regex: `^[a-z0-9][a-z0-9_-]{0,63}$` (lowercase, kebab/snake, 1-64
  chars). Safe to use as CLI argument and path fragment.
- Entry key (`collectionName`) does not change on rename; `name` is a separate
  field.

---

## 3. Components (infra layer)

**Layout:** `core/infra/registry/` — foundation, no domain deps. Sits alongside
`core/infra/stats-cache.ts`.

```
core/infra/registry/
  types.ts                  — RegistryFileV1, CollectionEntry, ProjectInfo
  registry-file.ts          — atomic load/save (tmp + rename), version validation
  collection-registry.ts    — class CollectionRegistry (public API)
  errors.ts                 — RegistryFileCorruptedError, RegistryWriteError
  index.ts                  — barrel
```

Note: `recoverFromQdrant()` lives at the `core/api/internal/ops/` layer (see
§6.3) because it depends on `QdrantManager` and `EmbeddingProvider`. The
`CollectionRegistry` core stays in `infra/`.

**Public API:**

```typescript
class CollectionRegistry {
  constructor(private readonly dataDir: string) {}

  // Core CRUD
  record(entry: CollectionEntry): void; // upsert; preserves sticky `name`
  get(collectionName: string): CollectionEntry | null;
  findByName(name: string): CollectionEntry | null;
  list(): CollectionEntry[];

  // Naming
  setName(collectionName: string, name: string | null): void;
  remove(collectionName: string): boolean;
}
```

**Behavior:**

- **`record(entry)`** — upserts by `collectionName`. If the existing entry has a
  `name`, the new entry inherits it (sticky); all other fields overwritten.
  Atomic save.
- **`get` / `findByName` / `list`** — pure reads from in-memory cache (lazy load
  on first access).
- **`setName`** — validates regex, validates uniqueness, atomic save. Throws
  `ProjectNameNotUniqueError`.
- **`remove`** — removes entry, atomic save. Does not touch the Qdrant
  collection.

**In-memory cache:**

- Lazy load: first read parses the file into `Map<collectionName, Entry>`.
- Every write flushes to disk (atomic tmp+rename) before returning.
- Missing or corrupt file on load → empty in-memory map, warn on stderr (do NOT
  throw — registry is optional for basic operation).

**Atomic write pattern (registry-file.ts):**

```typescript
writeFileSync(`${path}.tmp.${pid}`, json, "utf-8");
renameSync(`${path}.tmp.${pid}`, path);
```

The PID suffix prevents races between parallel tea-rags processes.

---

## 4. Resolution Chain

**Today:** `core/infra/collection-name.ts` exports:

```typescript
function resolveCollection(
  collection?: string,
  path?: string,
): { collectionName: string; path?: string };
```

**After this change:**

```typescript
function resolveCollection(
  registry: CollectionRegistry,
  input: { collection?: string; project?: string; path?: string },
): { collectionName: string; path?: string };
```

**Priority (deterministic, top-down):**

| Step | Condition          | Action                         | Result                                                                                                            |
| ---- | ------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 1    | `input.collection` | use as-is                      | `{ collectionName: input.collection, path: input.path }`                                                          |
| 2    | `input.project`    | `registry.findByName(project)` | found → `{ collectionName: entry.collectionName, path: entry.path }`; missing → throw `ProjectNotRegisteredError` |
| 3    | `input.path`       | compute hash                   | `{ collectionName: resolveCollectionName(path), path }`                                                           |
| 4    | none set           | throw                          | `CollectionNotProvidedError` (existing)                                                                           |

**Defaults removed from server.** Server-side no longer falls back to `cwd`. A
request without `collection` / `project` / `path` is an error. cwd-defaulting is
the **client's** responsibility:

- **CLI:** `--path` defaults to `process.cwd()` (unchanged from today).
- **MCP:** clients must pass at least one of the three. This is already the
  current contract.

Rationale: in a long-running MCP daemon, the process `cwd` is unrelated to the
client's `cwd`. Guessing is an anti-pattern.

**Callsites updated** (each gets `registry` via constructor DI and forwards
`project` from input DTO):

- `core/api/internal/ops/indexing-ops.ts` (5)
- `core/api/internal/ops/explore-ops.ts` (2)
- `core/api/internal/ops/collection-ops.ts`, `document-ops.ts` (verified at
  plan-time)
- `core/domains/ingest/pipeline/base.ts` (1)
- `core/domains/ingest/pipeline/status-module.ts` (2)
- `core/infra/schema-drift-monitor.ts` (1)

The standalone `resolveCollectionName(path)` function stays — used where
registration is intentionally bypassed (e.g. inside `register_project` itself).

---

## 5. MCP Tools + DTO Changes

### 5.1 New MCP tools

```typescript
register_project({ path: string, name: string }):
  Promise<{ collectionName: string; alreadyIndexed: boolean }>;

list_projects({}):
  Promise<{ projects: ProjectInfo[] }>;

unregister_project({ name: string }):
  Promise<{ removed: boolean }>;
```

`register_project` validates that `path` exists, validates `name` regex and
uniqueness, computes `collectionName = resolveCollectionName(realpath)`, and
upserts the entry. `alreadyIndexed` is `true` if the entry already had
auto-populated metadata.

`list_projects` returns all entries (empty array if registry is empty; no
errors).

`unregister_project` is idempotent — `removed: false` if `name` not found, no
throw. Does NOT touch the Qdrant collection.

**Tool files** (thin wrappers, no try/catch — middleware handles typed errors):

```
src/mcp/tools/
  register-project.ts
  list-projects.ts
  unregister-project.ts
```

### 5.2 App interface

```typescript
interface App {
  // ... existing methods
  registerProject(input: {
    path: string;
    name: string;
  }): Promise<{ collectionName: string; alreadyIndexed: boolean }>;
  listProjects(): Promise<{ projects: ProjectInfo[] }>;
  unregisterProject(input: { name: string }): Promise<{ removed: boolean }>;
}
```

Routing: `App` → `ProjectRegistryOps`
(`core/api/internal/ops/project-registry-ops.ts`) → `CollectionRegistry`.

### 5.3 DTO changes — `project?` parameter

All DTOs that currently accept `path | collection` gain optional
`project?: string`. Backward compatible — existing callers unchanged.

**Affected DTOs:**

- `dto/explore.ts` → `SearchInput` (semantic, hybrid, search_code, find_symbol,
  find_similar, rank_chunks).
- `dto/ingest.ts` → `IndexCodebaseInput`, `ReindexChangesInput`,
  `ForceReindexInput`, `GetIndexStatusInput`, `GetIndexMetricsInput`.
- `dto/collection.ts` → `GetCollectionInfoInput`, `ClearIndexInput`,
  `DeleteCollectionInput`.
- `dto/document.ts` → `AddDocumentsInput`, `DeleteDocumentsInput` (if they
  accept `path|collection`).

**Common mixin:**

```typescript
// dto/common.ts
export interface CollectionIdentifier {
  collection?: string;
  project?: string;
  path?: string;
}
```

Each Input type extends this mixin. SchemaBuilder uses a shared
`collectionIdentifierSchema` (Zod) injected into every tool.

### 5.4 SchemaBuilder update

`core/api/internal/infra/schema-builder.ts` adds:

```typescript
const projectSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
  .optional();
```

Wired into the shared identifier schema used by every project-aware tool.

### 5.5 Typed errors

`core/api/errors.ts`:

```typescript
class ProjectNotRegisteredError extends InputValidationError {
  constructor(name: string, available: string[]);
}
class ProjectNameNotUniqueError extends InputValidationError {
  constructor(name: string, existingCollectionName: string);
}
class ProjectNameInvalidError extends InputValidationError {
  constructor(name: string, reason: "regex" | "tooLong" | "empty");
}
class PathDoesNotExistError extends InputValidationError {
  constructor(path: string);
}
```

`core/infra/registry/errors.ts`:

```typescript
class RegistryFileCorruptedError extends InfraError {}
class RegistryWriteError extends InfraError {}
```

All InputValidation errors map to MCP `Invalid params` via the existing error
middleware.

---

## 6. Pipeline Integration & Recovery

### 6.1 Auto-populate point

`CollectionRegistry.record()` is called from `BaseIndexingPipeline.finalize()`
(`src/core/domains/ingest/pipeline/base.ts`) after all critical indexing work
has succeeded: Qdrant upserts, snapshot save, alias switch (forceReindex).
Background enrichment is NOT awaited — `chunksCount` reflects the canonical
Qdrant point count.

```typescript
async finalize(stats: IndexingStats): Promise<void> {
  // ... existing finalize work
  if (this.registry) {
    try {
      this.registry.record({
        collectionName: this.collectionName,
        path: this.absolutePath,
        embeddingModel: this.embeddings.modelId,
        embeddingDimensions: this.embeddings.dimensions,
        qdrantUrl: this.qdrant.url,
        indexedAt: new Date().toISOString(),
        teaRagsVersion: TEA_RAGS_VERSION,
        chunksCount: await this.qdrant.count(this.collectionName),
      });
    } catch (err) {
      logger.warn("Failed to update collection registry", { err });
    }
  }
}
```

**Invariants:**

- Registry write happens after all critical indexing operations; failure here
  does NOT roll back the index.
- Registry write is a synchronous JSON write (~1ms at typical N).
- `name` is omitted from the `record()` call — sticky, preserved if present.
- `path` is overwritten on reindex (project may have moved).

### 6.2 `chunksCount` source

Canonical: `qdrant.count(collectionName)` at the end of `finalize()`. This
reflects the count in the active alias-targeted collection, which is the truth
after alias switch.

### 6.3 Recovery semantics

`recoverFromQdrant()` lives in `ProjectRegistryOps` (api/internal/ops layer)
because it depends on `QdrantManager` and `EmbeddingProvider`. Three triggers:

1. **Lazy on load (file missing/corrupt):** in-memory empty map, warn on stderr.
   **No automatic Qdrant scan.** This keeps startup latency unchanged (hpg2
   requirement).
2. **Explicit doctor call (1wxw):** `projectRegistryOps.recoverFromQdrant()`
   does a sequential scan:
   - `qdrant.listCollections()` → alias names.
   - For each:
     - `path` ← snapshot meta if available, else null.
     - `embeddingDimensions` ← `qdrant.getCollectionInfo(name).vectors.size`.
     - `embeddingModel` ← read from `runtime` payload in the same collection
       (already written by embedding-model-guard).
     - `qdrantUrl` ← `qdrant.url`.
     - `indexedAt`, `teaRagsVersion`, `chunksCount` ← null (unknown). Doctor
       flags as "incomplete — reindex recommended".
   - `registry.record()` per entry.
3. **Implicit on next indexing:** no-op — `finalize()` will overwrite full
   metadata.

**What recovery does NOT do:**

- Does not reconstruct `name` (user-set; lost if registry is deleted —
  acceptable, user re-registers manually).
- Does not call `qdrant.count()` here — that's doctor diagnostics, not recovery.
- Is not invoked automatically by any MCP/CLI command. Doctor is the only entry
  point.

---

## 7. CLI Integration + DI Wiring

### 7.1 `--project` option

All project-aware CLI commands gain optional `--project <name>`:

- `tea-rags index`
- `tea-rags reindex`
- `tea-rags status`
- `tea-rags metrics`
- `tea-rags tune` (and `tune embeddings`)

(Exact command set verified at plan-time.)

**Per-option priority within a single command:**

1. Explicit CLI flag (`--path`, `--qdrant-url`, `--model`) wins.
2. Registry entry resolved by `--project <name>` fills undefined.
3. Hard-coded defaults (cwd, `http://localhost:6333`, etc.).

If `--project <name>` is provided but missing in the registry, the command exits
1 with a hint listing available names.

### 7.2 Shared resolver

`src/cli/registry-resolver.ts` (new):

```typescript
interface ProjectAwareArgs {
  project?: string;
  path?: string;
  "qdrant-url"?: string;
  model?: string;
}

function applyProjectDefaults(argv: ProjectAwareArgs): ProjectAwareArgs {
  if (!argv.project) return argv;
  const registry = new CollectionRegistry(resolveDataDir());
  const entry = registry.findByName(argv.project);
  if (!entry) {
    const names = registry
      .list()
      .map((e) => e.name)
      .filter(Boolean);
    console.error(
      `Project '${argv.project}' not registered. Available: ${names.join(", ") || "(none)"}`,
    );
    process.exit(1);
  }
  return {
    ...argv,
    path: argv.path ?? entry.path,
    "qdrant-url": argv["qdrant-url"] ?? entry.qdrantUrl,
    model: argv.model ?? entry.embeddingModel,
  };
}
```

Every project-aware command calls `applyProjectDefaults(argv)` at the top of its
`handler`, before the business logic.

### 7.3 New CLI commands

```
tea-rags register-project --path <path> --name <name>
tea-rags list-projects [--json]
tea-rags unregister-project --name <name>
```

These read/write `registry.json` directly via `CollectionRegistry` — no App, no
QdrantManager, no embeddings. Fast, idempotent. Registered in
`src/cli/create-cli.ts`.

### 7.4 DI wiring

**Bootstrap (`src/bootstrap/factory.ts`):**

```typescript
const dataDir =
  process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
const registry = new CollectionRegistry(dataDir);
const composition = createComposition({ ..., registry });
```

**Composition (`src/core/api/internal/composition.ts`):**

```typescript
const ingestFacade = new IngestFacade({ ..., registry });
const exploreFacade = new ExploreFacade({ ..., registry });
const collectionOps = new CollectionOps({ ..., registry });
const documentOps = new DocumentOps({ ..., registry });
const projectRegistryOps = new ProjectRegistryOps({
  registry,
  qdrant,
  embeddings,
});
```

Facades call `resolveCollection(this.registry, input)` instead of the legacy
two-arg form.

`IndexingOps` constructs `BaseIndexingPipeline` with `registry` injected, and
the pipeline calls `registry.record()` in `finalize()`.

**App layer (`src/core/api/public/app.ts`):**

```typescript
function createApp(deps: AppDeps): App {
  return {
    // ... existing
    registerProject: (i) => deps.projectRegistryOps.register(i),
    listProjects: () => deps.projectRegistryOps.list(),
    unregisterProject: (i) => deps.projectRegistryOps.unregister(i),
  };
}
```

**MCP server (`src/mcp/`):** `registerAllTools` picks up the three new tool
files via the barrel in `src/mcp/tools/index.ts`.

### 7.5 No global singleton

The `CollectionRegistry` instance lives only in `AppContext`. CLI registry
commands create a short-lived instance directly in the handler (lifetime =
command execution). No process-wide cache that could desync between parallel CLI
and MCP server processes.

Atomic writes in `registry-file.ts` provide consistency under concurrent access
— each load after rename sees a consistent file.

---

## 8. Out of Scope, Testing, Migration

### 8.1 Out of scope

- **Groups + federated search** — separate shipment. `tea-rags-mcp-2mrz` is
  reduced to "groups only" (or replaced by a new issue) after this lands.
- **Standalone `rename_project` MCP tool** — `register_project` is idempotent;
  rename = `unregister` then `register`. Add an explicit `rename_project` only
  if usage demands it.
- **Auto-recovery on load** — recovery is explicit, doctor-driven only.
- **Per-project config file resolution (`hrai`)** — separate issue. May reuse
  registry for path discovery once this lands.
- **Migration of pre-registry installations** — registry simply starts empty; it
  fills on the next `index_codebase` / `reindex_changes`. No migration step
  required.
- **Multi-machine sync** — registry is per-machine state.
- **Concurrent write protection beyond tmp+rename** — no file locking;
  last-writer-wins with PID-suffixed tmp file. Acceptable for rare writes.

### 8.2 Testing strategy

**Unit (infra):**

- `registry-file.test.ts` — missing file → empty; corrupt JSON → throws
  `RegistryFileCorruptedError`; save → tmp file appears, gets renamed;
  concurrent-write simulation (two writes with different PIDs).
- `collection-registry.test.ts` — `record` upsert; sticky `name` preserved;
  `setName` uniqueness violation; `findByName` returns null on miss; `list`
  returns sorted.

**Integration (ops):**

- `project-registry-ops.test.ts` — `register` happy path;
  `PathDoesNotExistError`; `ProjectNameNotUniqueError`; `unregister`
  idempotency; `list` shape; `recoverFromQdrant` with mock QdrantManager.

**Resolution chain:**

- `collection-name.test.ts` — priority (collection > project > path); `project`
  not found → throws; `project` found → returns entry's `collectionName + path`.

**CLI:**

- `registry-resolver.test.ts` — explicit `--path` overrides registry; missing
  project → exit 1; happy path fills undefined fields.
- CLI command tests use a temp `TEA_RAGS_DATA_DIR` and verify file contents
  after each command.

**End-to-end pipeline:**

- After `index_codebase`, `registry.get(collectionName)` returns an entry with
  populated metadata.
- After `reindex_changes`, `name` is preserved while other fields are
  overwritten.

### 8.3 Migration / rollout

- Existing installs: registry is created on the first `register_project` or the
  first `index_codebase` after upgrade. Empty registry between upgrade and first
  indexing is fine — server requires explicit `path | collection | project` and
  never silently fell back to cwd.
- Pre-registry indexed projects: user either reindexes (entries appear) or
  manually runs `tea-rags register-project --path X --name Y` (the deterministic
  path-hash matches the existing collection; doctor recovery fills metadata).
- Breaking changes for users: **none**. All new parameters are optional.

---

## 9. Files Matrix

### 9.1 New files

| File                                                       | Purpose                                            |
| ---------------------------------------------------------- | -------------------------------------------------- |
| `src/core/infra/registry/types.ts`                         | `RegistryFileV1`, `CollectionEntry`, `ProjectInfo` |
| `src/core/infra/registry/registry-file.ts`                 | Atomic load/save, version check                    |
| `src/core/infra/registry/collection-registry.ts`           | `CollectionRegistry` class                         |
| `src/core/infra/registry/errors.ts`                        | `RegistryFileCorruptedError`, `RegistryWriteError` |
| `src/core/infra/registry/index.ts`                         | Barrel                                             |
| `src/core/api/internal/ops/project-registry-ops.ts`        | Register/list/unregister + `recoverFromQdrant`     |
| `src/mcp/tools/register-project.ts`                        | MCP tool                                           |
| `src/mcp/tools/list-projects.ts`                           | MCP tool                                           |
| `src/mcp/tools/unregister-project.ts`                      | MCP tool                                           |
| `src/cli/registry-resolver.ts`                             | `applyProjectDefaults`                             |
| `src/cli/commands/register-project.ts`                     | CLI command                                        |
| `src/cli/commands/list-projects.ts`                        | CLI command                                        |
| `src/cli/commands/unregister-project.ts`                   | CLI command                                        |
| `tests/core/infra/registry/registry-file.test.ts`          | Atomic IO + corruption                             |
| `tests/core/infra/registry/collection-registry.test.ts`    | CRUD + sticky name                                 |
| `tests/core/api/internal/ops/project-registry-ops.test.ts` | Ops orchestration + recovery                       |
| `tests/cli/registry-resolver.test.ts`                      | Resolver                                           |
| `tests/cli/commands/register-project.test.ts`              | CLI integration                                    |
| `tests/mcp/tools/register-project.test.ts`                 | Tool wiring                                        |

### 9.2 Modified files

| File                                                              | Change                                                        |
| ----------------------------------------------------------------- | ------------------------------------------------------------- |
| `src/core/infra/collection-name.ts`                               | `resolveCollection(registry, { collection, project, path })`  |
| `src/core/api/errors.ts`                                          | + 4 `InputValidationError` subclasses                         |
| `src/core/api/public/dto/common.ts` (new or extend existing)      | `CollectionIdentifier` mixin                                  |
| `src/core/api/public/dto/{explore,ingest,collection,document}.ts` | Extend Input types via mixin                                  |
| `src/core/api/public/app.ts`                                      | + 3 method signatures                                         |
| `src/core/api/internal/composition.ts`                            | + registry, projectRegistryOps                                |
| `src/core/api/internal/facades/ingest-facade.ts`                  | + registry DI, project routing                                |
| `src/core/api/internal/facades/explore-facade.ts`                 | Same                                                          |
| `src/core/api/internal/ops/indexing-ops.ts`                       | `resolveCollection` with registry+project, pass into pipeline |
| `src/core/api/internal/ops/explore-ops.ts`                        | Same                                                          |
| `src/core/api/internal/ops/collection-ops.ts`                     | Same                                                          |
| `src/core/api/internal/ops/document-ops.ts`                       | Same                                                          |
| `src/core/api/internal/infra/schema-builder.ts`                   | + `projectSchema` in shared identifier schemas                |
| `src/core/api/index.ts`                                           | + barrel exports for `CollectionRegistry`, types              |
| `src/core/domains/ingest/pipeline/base.ts`                        | + registry DI, + `record()` in `finalize`                     |
| `src/core/domains/ingest/pipeline/status-module.ts`               | `resolveCollection` update                                    |
| `src/core/infra/schema-drift-monitor.ts`                          | `resolveCollection` update                                    |
| `src/bootstrap/factory.ts`                                        | Build `CollectionRegistry`, pass into composition             |
| `src/cli/commands/tune.ts`                                        | + `--project` option, call `applyProjectDefaults`             |
| `src/cli/commands/{index,reindex,status,metrics}.ts`              | Same (verified at plan-time)                                  |

---

## 10. Relation to other beads issues

| Issue               | Relation                                                                                                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tea-rags-mcp-gr4o` | This spec; closes on landing.                                                                                                                                            |
| `tea-rags-mcp-2mrz` | Scope merged into this spec (MCP tools + name resolution). Reduced/closed on landing. Groups + federated search remain as a future shipment.                             |
| `tea-rags-mcp-1wxw` | Doctor — consumes `recoverFromQdrant` and diagnoses incomplete entries.                                                                                                  |
| `tea-rags-mcp-hpg2` | Auto-update watcher — consumes `indexedAt`, `teaRagsVersion`, `chunksCount` from registry. Hard requirement: startup latency unchanged (no auto-recover on load — §6.3). |
| `tea-rags-mcp-fl2q` | Sub-collections — will extend schema to nest sub-collection entries (future, additive).                                                                                  |
| `tea-rags-mcp-mc87` | Multi-collection search — depends on this for collection discovery.                                                                                                      |
| `tea-rags-mcp-hrai` | Runtime config per project path — may use registry for path discovery, separate work.                                                                                    |
