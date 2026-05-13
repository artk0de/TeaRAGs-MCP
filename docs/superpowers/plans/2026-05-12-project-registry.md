# Project Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `dinopowers:executing-plans`
> (NOT `superpowers:executing-plans` — wrapper required) to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistent registry of named projects and auto-populated collection
metadata, replacing path-resolution defaults across MCP, CLI, and indexing
pipeline.

**Architecture:** New `core/infra/registry/` provides `CollectionRegistry` —
atomic JSON store keyed by `collectionName`. `resolveCollection()` gets a new
signature that accepts `(registry, { collection, project, path })` with priority
`collection > project > path > error`.
`BaseIndexingPipeline.finalizeProcessing()` auto-writes metadata. New
`ProjectRegistryOps` (api/internal) hosts
`register_project / list_projects / unregister_project` exposed via 3 MCP tools
and 3 CLI commands. A CLI helper `applyProjectDefaults` fills
`--path / --qdrant-url / --model` from registry when `--project <name>` is
given.

**Tech Stack:** TypeScript, Node.js fs sync IO (tmp+rename), Vitest, Zod
schemas, Yargs CLI.

**Spec:** `docs/superpowers/specs/2026-05-12-project-registry-design.md`

---

## File Structure

### New files

| Path                                                       | Responsibility                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `src/core/infra/registry/types.ts`                         | `RegistryFileV1`, `CollectionEntry`, `ProjectInfo`                     |
| `src/core/infra/registry/errors.ts`                        | `RegistryFileCorruptedError`, `RegistryWriteError`                     |
| `src/core/infra/registry/registry-file.ts`                 | `loadRegistryFile`, `saveRegistryFile` (atomic tmp+rename)             |
| `src/core/infra/registry/collection-registry.ts`           | `CollectionRegistry` class (record/get/findByName/list/setName/remove) |
| `src/core/infra/registry/index.ts`                         | Barrel                                                                 |
| `src/core/api/internal/ops/project-registry-ops.ts`        | `ProjectRegistryOps` (register/list/unregister + `recoverFromQdrant`)  |
| `src/core/api/public/dto/common.ts`                        | `CollectionIdentifier` mixin (if not already present)                  |
| `src/mcp/tools/register-project.ts`                        | MCP tool wrapper                                                       |
| `src/mcp/tools/list-projects.ts`                           | MCP tool wrapper                                                       |
| `src/mcp/tools/unregister-project.ts`                      | MCP tool wrapper                                                       |
| `src/cli/registry-resolver.ts`                             | `applyProjectDefaults(argv)`                                           |
| `src/cli/commands/register-project.ts`                     | CLI command                                                            |
| `src/cli/commands/list-projects.ts`                        | CLI command                                                            |
| `src/cli/commands/unregister-project.ts`                   | CLI command                                                            |
| `tests/core/infra/registry/registry-file.test.ts`          | Atomic IO + corruption + version                                       |
| `tests/core/infra/registry/collection-registry.test.ts`    | CRUD + sticky name + uniqueness                                        |
| `tests/core/api/internal/ops/project-registry-ops.test.ts` | Ops orchestration + recoverFromQdrant                                  |
| `tests/cli/registry-resolver.test.ts`                      | Resolver fallback chain                                                |
| `tests/cli/commands/register-project.test.ts`              | CLI integration                                                        |
| `tests/mcp/tools/register-project.test.ts`                 | Tool wiring                                                            |

### Modified files

| Path                                                                      | Change                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `src/core/infra/collection-name.ts`                                       | `resolveCollection(registry, { collection, project, path })`             |
| `src/core/api/errors.ts`                                                  | + 4 `InputValidationError` subclasses                                    |
| `src/core/api/public/dto/{explore,ingest,collection,document}.ts`         | extend Input types via `CollectionIdentifier` mixin                      |
| `src/core/api/public/app.ts`                                              | + 3 method signatures (registerProject, listProjects, unregisterProject) |
| `src/core/api/internal/composition.ts`                                    | + `registry`, `projectRegistryOps` in graph                              |
| `src/core/api/internal/facades/{ingest,explore}-facade.ts`                | + registry DI, project routing                                           |
| `src/core/api/internal/ops/{indexing,explore,collection,document}-ops.ts` | resolveCollection callsite update                                        |
| `src/core/api/internal/infra/schema-builder.ts`                           | + `projectSchema` in shared identifier schemas                           |
| `src/core/api/index.ts`                                                   | + barrel exports for CollectionRegistry, types                           |
| `src/core/domains/ingest/pipeline/base.ts`                                | + registry DI + `record()` call in `finalizeProcessing`                  |
| `src/core/domains/ingest/pipeline/status-module.ts`                       | resolveCollection callsite update                                        |
| `src/core/infra/schema-drift-monitor.ts`                                  | resolveCollection callsite update                                        |
| `src/bootstrap/factory.ts`                                                | build `CollectionRegistry`, pass into composition                        |
| `src/cli/commands/tune.ts`                                                | + `--project` option, call `applyProjectDefaults`                        |
| `src/cli/commands/{index,reindex,status,metrics}.ts`                      | same (verify existence per command at task-time)                         |
| `src/cli/create-cli.ts`                                                   | register 3 new commands                                                  |

---

## Task 1: Foundation types, errors, barrel

**Files:**

- Create: `src/core/infra/registry/types.ts`
- Create: `src/core/infra/registry/errors.ts`
- Create: `src/core/infra/registry/index.ts`

**Dependencies:** none.

- [ ] **Step 1: Write the failing test for the type shape**

Create `tests/core/infra/registry/types.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import type {
  CollectionEntry,
  ProjectInfo,
  RegistryFileV1,
} from "../../../../src/core/infra/registry/types.js";

describe("registry types", () => {
  it("CollectionEntry has required fields", () => {
    const entry: CollectionEntry = {
      collectionName: "code_abc123",
      path: "/some/path",
      name: null,
      embeddingModel: "model",
      embeddingDimensions: 384,
      qdrantUrl: "http://localhost:6333",
      indexedAt: new Date().toISOString(),
      teaRagsVersion: "0.42.1",
      chunksCount: 100,
    };
    expect(entry.collectionName).toBe("code_abc123");
  });

  it("RegistryFileV1 maps collectionName → entry", () => {
    const file: RegistryFileV1 = {
      version: 1,
      collections: {
        code_abc123: { collectionName: "code_abc123" } as CollectionEntry,
      },
    };
    expect(file.version).toBe(1);
  });

  it("ProjectInfo is a serializable subset of CollectionEntry", () => {
    const info: ProjectInfo = {
      collectionName: "code_abc123",
      path: "/x",
      name: "x",
      embeddingModel: "m",
      embeddingDimensions: 1,
      qdrantUrl: "u",
      indexedAt: "t",
      teaRagsVersion: "v",
      chunksCount: 0,
    };
    expect(info.name).toBe("x");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/infra/registry/types.test.ts` Expected: FAIL
with "Cannot find module" — types do not exist yet.

- [ ] **Step 3: Create types.ts**

```typescript
// src/core/infra/registry/types.ts

export interface CollectionEntry {
  collectionName: string;
  path: string;
  name: string | null;
  embeddingModel: string;
  embeddingDimensions: number;
  qdrantUrl: string;
  indexedAt: string;
  teaRagsVersion: string;
  chunksCount: number;
}

/** Partial entry used when registry.record() is invoked from pipeline (no `name`). */
export type RecordEntryInput = Omit<CollectionEntry, "name">;

export interface RegistryFileV1 {
  version: 1;
  collections: Record<string, CollectionEntry>;
}

/** ProjectInfo is the wire shape returned by list_projects MCP tool. */
export type ProjectInfo = CollectionEntry;
```

- [ ] **Step 4: Create errors.ts**

```typescript
// src/core/infra/registry/errors.ts

import { InfraError } from "../errors.js";

export class RegistryFileCorruptedError extends InfraError {
  constructor(path: string, reason: string) {
    super(`Registry file at ${path} is corrupted: ${reason}`);
    this.name = "RegistryFileCorruptedError";
  }
}

export class RegistryWriteError extends InfraError {
  constructor(path: string, cause: unknown) {
    super(`Failed to write registry file at ${path}`);
    this.name = "RegistryWriteError";
    this.cause = cause;
  }
}
```

- [ ] **Step 5: Create barrel index.ts**

```typescript
// src/core/infra/registry/index.ts
export type {
  CollectionEntry,
  RecordEntryInput,
  RegistryFileV1,
  ProjectInfo,
} from "./types.js";
export { RegistryFileCorruptedError, RegistryWriteError } from "./errors.js";
export { CollectionRegistry } from "./collection-registry.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/core/infra/registry/types.test.ts` Expected: PASS
(all 3 cases). Type errors absent.

Note: `CollectionRegistry` import in barrel will be unresolved until Task 3 —
expect a TypeScript error here. Acceptable to leave it commented out until Task
3 lands, or land Task 1 with barrel containing only types + errors and amend in
Task 3.

- [ ] **Step 7: Commit**

```bash
git add src/core/infra/registry/types.ts \
        src/core/infra/registry/errors.ts \
        src/core/infra/registry/index.ts \
        tests/core/infra/registry/types.test.ts
git commit -m "feat(infra): add project registry foundation types and errors"
```

---

## Task 2: `registry-file.ts` — atomic IO

**Files:**

- Create: `src/core/infra/registry/registry-file.ts`
- Create: `tests/core/infra/registry/registry-file.test.ts`

**Dependencies:** Task 1.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/infra/registry/registry-file.test.ts
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RegistryFileCorruptedError } from "../../../../src/core/infra/registry/errors.js";
import {
  loadRegistryFile,
  saveRegistryFile,
} from "../../../../src/core/infra/registry/registry-file.js";
import type { RegistryFileV1 } from "../../../../src/core/infra/registry/types.js";

describe("registry-file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tea-rags-registry-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadRegistryFile returns null when file is missing", () => {
    expect(loadRegistryFile(dir)).toBeNull();
  });

  it("loadRegistryFile parses a valid v1 file", () => {
    const file: RegistryFileV1 = { version: 1, collections: {} };
    writeFileSync(join(dir, "registry.json"), JSON.stringify(file), "utf-8");
    const loaded = loadRegistryFile(dir);
    expect(loaded).toEqual(file);
  });

  it("loadRegistryFile throws RegistryFileCorruptedError on invalid JSON", () => {
    writeFileSync(join(dir, "registry.json"), "{not json", "utf-8");
    expect(() => loadRegistryFile(dir)).toThrow(RegistryFileCorruptedError);
  });

  it("loadRegistryFile throws on unknown version", () => {
    writeFileSync(
      join(dir, "registry.json"),
      JSON.stringify({ version: 99, collections: {} }),
      "utf-8",
    );
    expect(() => loadRegistryFile(dir)).toThrow(RegistryFileCorruptedError);
  });

  it("saveRegistryFile writes atomically (tmp + rename)", () => {
    const file: RegistryFileV1 = { version: 1, collections: {} };
    saveRegistryFile(dir, file);
    expect(existsSync(join(dir, "registry.json"))).toBe(true);
    expect(
      JSON.parse(readFileSync(join(dir, "registry.json"), "utf-8")),
    ).toEqual(file);
    // No stale tmp files after success:
    expect(existsSync(join(dir, `registry.json.tmp.${process.pid}`))).toBe(
      false,
    );
  });

  it("saveRegistryFile creates dataDir if missing", () => {
    const nested = join(dir, "deeper");
    saveRegistryFile(nested, { version: 1, collections: {} });
    expect(existsSync(join(nested, "registry.json"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/infra/registry/registry-file.test.ts` Expected:
FAIL — module not found.

- [ ] **Step 3: Implement registry-file.ts**

```typescript
// src/core/infra/registry/registry-file.ts
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { RegistryFileCorruptedError, RegistryWriteError } from "./errors.js";
import type { RegistryFileV1 } from "./types.js";

const FILE_NAME = "registry.json";

function filePath(dataDir: string): string {
  return join(dataDir, FILE_NAME);
}

export function loadRegistryFile(dataDir: string): RegistryFileV1 | null {
  const path = filePath(dataDir);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RegistryFileCorruptedError(
      path,
      `JSON parse failed: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new RegistryFileCorruptedError(path, "root is not an object");
  }
  const obj = parsed as { version?: unknown; collections?: unknown };
  if (obj.version !== 1) {
    throw new RegistryFileCorruptedError(
      path,
      `unsupported version ${String(obj.version)}`,
    );
  }
  if (typeof obj.collections !== "object" || obj.collections === null) {
    throw new RegistryFileCorruptedError(path, "collections is not an object");
  }
  return obj as RegistryFileV1;
}

export function saveRegistryFile(dataDir: string, file: RegistryFileV1): void {
  mkdirSync(dataDir, { recursive: true });
  const path = filePath(dataDir);
  const tmp = `${path}.tmp.${process.pid}`;
  const json = JSON.stringify(file, null, 2);
  try {
    writeFileSync(tmp, json, "utf-8");
    renameSync(tmp, path);
  } catch (err) {
    throw new RegistryWriteError(path, err);
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/core/infra/registry/registry-file.test.ts` Expected:
6/6 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/infra/registry/registry-file.ts tests/core/infra/registry/registry-file.test.ts
git commit -m "feat(infra): add atomic registry file IO"
```

---

## Task 3: `CollectionRegistry` class

**Files:**

- Create: `src/core/infra/registry/collection-registry.ts`
- Create: `tests/core/infra/registry/collection-registry.test.ts`
- Modify: `src/core/infra/registry/index.ts` (uncomment CollectionRegistry
  export)

**Dependencies:** Task 1, Task 2.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/infra/registry/collection-registry.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollectionRegistry } from "../../../../src/core/infra/registry/collection-registry.js";
import type { CollectionEntry } from "../../../../src/core/infra/registry/types.js";

function makeEntry(
  over: Partial<CollectionEntry> = {},
): Omit<CollectionEntry, "name"> {
  return {
    collectionName: "code_abc",
    path: "/repo/a",
    embeddingModel: "m",
    embeddingDimensions: 384,
    qdrantUrl: "http://localhost:6333",
    indexedAt: "2026-05-12T00:00:00.000Z",
    teaRagsVersion: "0.1.0",
    chunksCount: 10,
    ...over,
  };
}

describe("CollectionRegistry", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when registry is empty", () => {
    const r = new CollectionRegistry(dir);
    expect(r.get("code_abc")).toBeNull();
    expect(r.findByName("anything")).toBeNull();
    expect(r.list()).toEqual([]);
  });

  it("record() upserts an entry", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    const got = r.get("code_abc");
    expect(got?.path).toBe("/repo/a");
    expect(got?.name).toBeNull();
  });

  it("record() preserves sticky name on second record() call", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    r.setName("code_abc", "alpha");
    r.record(makeEntry({ path: "/repo/a2", chunksCount: 20 }));
    const got = r.get("code_abc");
    expect(got?.name).toBe("alpha");
    expect(got?.path).toBe("/repo/a2");
    expect(got?.chunksCount).toBe(20);
  });

  it("setName() enforces uniqueness across entries", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry({ collectionName: "code_a" }));
    r.record(makeEntry({ collectionName: "code_b", path: "/repo/b" }));
    r.setName("code_a", "shared");
    expect(() => r.setName("code_b", "shared")).toThrow(/not unique/i);
  });

  it("findByName() returns the entry or null", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    r.setName("code_abc", "alpha");
    expect(r.findByName("alpha")?.collectionName).toBe("code_abc");
    expect(r.findByName("missing")).toBeNull();
  });

  it("remove() returns true on existing, false on missing", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    expect(r.remove("code_abc")).toBe(true);
    expect(r.remove("code_abc")).toBe(false);
  });

  it("persists across instances (atomic save)", () => {
    const r1 = new CollectionRegistry(dir);
    r1.record(makeEntry());
    r1.setName("code_abc", "alpha");
    const r2 = new CollectionRegistry(dir);
    expect(r2.findByName("alpha")?.collectionName).toBe("code_abc");
  });

  it("setName(name=null) clears the name", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    r.setName("code_abc", "alpha");
    r.setName("code_abc", null);
    expect(r.get("code_abc")?.name).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/infra/registry/collection-registry.test.ts`
Expected: FAIL — class not found.

- [ ] **Step 3: Implement CollectionRegistry**

```typescript
// src/core/infra/registry/collection-registry.ts
import { loadRegistryFile, saveRegistryFile } from "./registry-file.js";
import type {
  CollectionEntry,
  RecordEntryInput,
  RegistryFileV1,
} from "./types.js";

export class ProjectNameNotUniqueError extends Error {
  constructor(name: string, existingCollectionName: string) {
    super(
      `Project name '${name}' is not unique — already used by '${existingCollectionName}'`,
    );
    this.name = "ProjectNameNotUniqueError";
  }
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export class CollectionRegistry {
  private cache: Map<string, CollectionEntry> | null = null;

  constructor(private readonly dataDir: string) {}

  private ensureLoaded(): Map<string, CollectionEntry> {
    if (this.cache !== null) return this.cache;
    try {
      const file = loadRegistryFile(this.dataDir);
      const map = new Map<string, CollectionEntry>();
      if (file !== null) {
        for (const [k, v] of Object.entries(file.collections)) map.set(k, v);
      }
      this.cache = map;
      return map;
    } catch (err) {
      process.stderr.write(
        `[tea-rags] registry corrupt, starting empty: ${(err as Error).message}\n`,
      );
      this.cache = new Map();
      return this.cache;
    }
  }

  private flush(): void {
    const map = this.cache!;
    const file: RegistryFileV1 = {
      version: 1,
      collections: Object.fromEntries(map.entries()),
    };
    saveRegistryFile(this.dataDir, file);
  }

  record(entry: RecordEntryInput): void {
    const map = this.ensureLoaded();
    const existing = map.get(entry.collectionName);
    map.set(entry.collectionName, {
      ...entry,
      name: existing?.name ?? null, // sticky
    });
    this.flush();
  }

  get(collectionName: string): CollectionEntry | null {
    return this.ensureLoaded().get(collectionName) ?? null;
  }

  findByName(name: string): CollectionEntry | null {
    const map = this.ensureLoaded();
    for (const entry of map.values()) {
      if (entry.name === name) return entry;
    }
    return null;
  }

  list(): CollectionEntry[] {
    return [...this.ensureLoaded().values()];
  }

  setName(collectionName: string, name: string | null): void {
    const map = this.ensureLoaded();
    const entry = map.get(collectionName);
    if (!entry)
      throw new Error(`Collection '${collectionName}' not in registry`);
    if (name !== null) {
      if (!NAME_RE.test(name)) {
        throw new Error(`Name '${name}' does not match ${NAME_RE.source}`);
      }
      for (const other of map.values()) {
        if (other.name === name && other.collectionName !== collectionName) {
          throw new ProjectNameNotUniqueError(name, other.collectionName);
        }
      }
    }
    map.set(collectionName, { ...entry, name });
    this.flush();
  }

  remove(collectionName: string): boolean {
    const map = this.ensureLoaded();
    const had = map.delete(collectionName);
    if (had) this.flush();
    return had;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/core/infra/registry/collection-registry.test.ts`
Expected: 8/8 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/infra/registry/collection-registry.ts src/core/infra/registry/index.ts \
        tests/core/infra/registry/collection-registry.test.ts
git commit -m "feat(infra): add CollectionRegistry class"
```

---

## Task 4: Typed errors in `api/errors.ts`

**Files:**

- Modify: `src/core/api/errors.ts`
- Create: `tests/core/api/errors-registry.test.ts`

**Dependencies:** none (parallel to Tasks 1-3 if author is comfortable splitting
work).

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/api/errors-registry.test.ts
import { describe, expect, it } from "vitest";

import {
  PathDoesNotExistError,
  ProjectNameInvalidError,
  ProjectNameNotUniqueError,
  ProjectNotRegisteredError,
} from "../../../src/core/api/errors.js";

describe("project registry errors", () => {
  it("ProjectNotRegisteredError lists available names in message", () => {
    const e = new ProjectNotRegisteredError("missing", ["a", "b"]);
    expect(e.message).toContain("missing");
    expect(e.message).toContain("a");
    expect(e.message).toContain("b");
  });

  it("ProjectNameNotUniqueError references existing collection", () => {
    const e = new ProjectNameNotUniqueError("x", "code_abc");
    expect(e.message).toContain("code_abc");
  });

  it("ProjectNameInvalidError reports reason", () => {
    const e = new ProjectNameInvalidError("BAD", "regex");
    expect(e.message).toContain("regex");
  });

  it("PathDoesNotExistError quotes the path", () => {
    const e = new PathDoesNotExistError("/nope");
    expect(e.message).toContain("/nope");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/errors-registry.test.ts` Expected: FAIL —
imports do not exist.

- [ ] **Step 3: Read the current errors.ts to determine the InputValidationError
      base**

Run: `cat src/core/api/errors.ts | head -80`

Identify the existing `InputValidationError` abstract class. Confirm naming
convention.

- [ ] **Step 4: Append the 4 new error classes**

Append to `src/core/api/errors.ts`:

```typescript
export class ProjectNotRegisteredError extends InputValidationError {
  constructor(name: string, available: string[]) {
    const hint = available.length > 0 ? available.join(", ") : "(none)";
    super(`Project '${name}' is not registered. Available: ${hint}`);
    this.name = "ProjectNotRegisteredError";
  }
}

export class ProjectNameNotUniqueError extends InputValidationError {
  constructor(name: string, existingCollectionName: string) {
    super(
      `Project name '${name}' is not unique — already used by '${existingCollectionName}'`,
    );
    this.name = "ProjectNameNotUniqueError";
  }
}

export class ProjectNameInvalidError extends InputValidationError {
  constructor(name: string, reason: "regex" | "tooLong" | "empty") {
    super(`Project name '${name}' is invalid: ${reason}`);
    this.name = "ProjectNameInvalidError";
  }
}

export class PathDoesNotExistError extends InputValidationError {
  constructor(path: string) {
    super(`Path '${path}' does not exist`);
    this.name = "PathDoesNotExistError";
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/core/api/errors-registry.test.ts` Expected: 4/4 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/api/errors.ts tests/core/api/errors-registry.test.ts
git commit -m "feat(contracts): add typed errors for project registry validation"
```

---

## Task 5: DTO mixin `CollectionIdentifier` + extend Input DTOs

**Files:**

- Create or modify: `src/core/api/public/dto/common.ts` (verify if file exists;
  if not, create)
- Modify: `src/core/api/public/dto/explore.ts`
- Modify: `src/core/api/public/dto/ingest.ts`
- Modify: `src/core/api/public/dto/collection.ts`
- Modify: `src/core/api/public/dto/document.ts`
- Create: `tests/core/api/public/dto/collection-identifier.test.ts`

**Dependencies:** none.

- [ ] **Step 1: Check whether `dto/common.ts` exists**

Run: `ls src/core/api/public/dto/` If `common.ts` exists, append. If not,
create.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/core/api/public/dto/collection-identifier.test.ts
import { describe, expect, it } from "vitest";

import type { CollectionIdentifier } from "../../../../../src/core/api/public/dto/common.js";
import type { IndexCodebaseInput } from "../../../../../src/core/api/public/dto/ingest.js";

describe("CollectionIdentifier mixin", () => {
  it("permits all three optional fields", () => {
    const a: CollectionIdentifier = { collection: "c" };
    const b: CollectionIdentifier = { project: "p" };
    const c: CollectionIdentifier = { path: "/x" };
    const d: CollectionIdentifier = {};
    expect([a, b, c, d].length).toBe(4);
  });

  it("IndexCodebaseInput inherits project field", () => {
    const input: IndexCodebaseInput = { path: "/x", project: "p" };
    expect(input.project).toBe("p");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/core/api/public/dto/collection-identifier.test.ts`
Expected: FAIL — `CollectionIdentifier` not exported.

- [ ] **Step 4: Add `CollectionIdentifier` to `common.ts`**

```typescript
// src/core/api/public/dto/common.ts (append or create)
/**
 * Shared mixin for any DTO that addresses a single collection.
 * Resolution priority: collection > project > path.
 */
export interface CollectionIdentifier {
  collection?: string;
  project?: string;
  path?: string;
}
```

If barrel `dto/index.ts` exists, add `export * from "./common.js";`.

- [ ] **Step 5: Extend each Input DTO via mixin**

For each of `explore.ts`, `ingest.ts`, `collection.ts`, `document.ts`:

Identify all Input types that currently have `collection?: string` and
`path?: string`. Change each to extend `CollectionIdentifier`:

Before:

```typescript
export interface IndexCodebaseInput {
  collection?: string;
  path?: string;
  // ... other fields
}
```

After:

```typescript
import type { CollectionIdentifier } from "./common.js";

export interface IndexCodebaseInput extends CollectionIdentifier {
  // collection?, project?, path? now inherited
  // ... other fields unchanged
}
```

Repeat for: `SearchInput`, `ReindexChangesInput`, `ForceReindexInput`,
`GetIndexStatusInput`, `GetIndexMetricsInput`, `GetCollectionInfoInput`,
`ClearIndexInput`, `DeleteCollectionInput`, `AddDocumentsInput`,
`DeleteDocumentsInput`.

For inputs that do NOT have a `collection?`/`path?` field today, leave them
unchanged.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/core/api/public/dto/collection-identifier.test.ts`
Also run full type-check: `npx tsc --noEmit` Expected: 2/2 PASS. No new TS
errors.

- [ ] **Step 7: Commit**

```bash
git add src/core/api/public/dto/ tests/core/api/public/dto/collection-identifier.test.ts
git commit -m "feat(dto): add CollectionIdentifier mixin with optional project field"
```

---

## Task 6: SchemaBuilder — `projectSchema` in shared identifier

**Files:**

- Modify: `src/core/api/internal/infra/schema-builder.ts`
- Modify: `tests/core/api/internal/infra/schema-builder.test.ts` (or create if
  absent)

**Dependencies:** Task 5.

- [ ] **Step 1: Read schema-builder.ts to identify the shared identifier
      schema**

Run: `cat src/core/api/internal/infra/schema-builder.ts | head -100`

Locate the Zod schema that today produces
`{ collection: z.string().optional(), path: z.string().optional() }`.

- [ ] **Step 2: Write the failing test**

Add to (or create) `tests/core/api/internal/infra/schema-builder.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { SchemaBuilder } from "../../../../../src/core/api/internal/infra/schema-builder.js";

// Use whatever reranker stub the existing tests use; copy the pattern.

describe("SchemaBuilder.collectionIdentifier", () => {
  it("includes optional project field with regex validation", () => {
    const schema = SchemaBuilder.collectionIdentifier();
    expect(schema.safeParse({ project: "valid-name" }).success).toBe(true);
    expect(schema.safeParse({ project: "BAD" }).success).toBe(false);
    expect(schema.safeParse({}).success).toBe(true);
  });
});
```

(Adapt the import and SchemaBuilder API to match the existing class shape — if
it's instance-based, instantiate as the existing tests do.)

- [ ] **Step 3: Run test to verify it fails**

Run:
`npx vitest run tests/core/api/internal/infra/schema-builder.test.ts -t collectionIdentifier`
Expected: FAIL — method not present or schema missing project.

- [ ] **Step 4: Update the shared identifier schema in schema-builder.ts**

```typescript
const projectNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9_-]{0,63}$/,
    "Project name must match ^[a-z0-9][a-z0-9_-]{0,63}$",
  )
  .optional();

// Wherever the shared "collection identifier" schema is built today:
const collectionIdentifierSchema = z.object({
  collection: z.string().optional(),
  project: projectNameSchema,
  path: z.string().optional(),
});
```

Wire this into every place that currently merges `{ collection, path }` into a
tool's input schema.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/core/api/internal/infra/schema-builder.test.ts` Also:
`npx tsc --noEmit` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/api/internal/infra/schema-builder.ts tests/core/api/internal/infra/schema-builder.test.ts
git commit -m "feat(api): add projectSchema with regex validation to SchemaBuilder"
```

---

## Task 7: `resolveCollection` signature change + all callsites

**Files:**

- Modify: `src/core/infra/collection-name.ts`
- Modify: `src/core/api/internal/ops/indexing-ops.ts`
- Modify: `src/core/api/internal/ops/explore-ops.ts`
- Modify: `src/core/api/internal/ops/collection-ops.ts`
- Modify: `src/core/api/internal/ops/document-ops.ts`
- Modify: `src/core/domains/ingest/pipeline/base.ts`
- Modify: `src/core/domains/ingest/pipeline/status-module.ts`
- Modify: `src/core/infra/schema-drift-monitor.ts`
- Modify: `tests/core/infra/collection-name.test.ts` (or create)

**Dependencies:** Tasks 1-4.

> **Note on big-bang change.** This Task changes a foundational function
> signature and updates every callsite in one commit. This is acceptable
> because: (1) all callers are within the same package, (2) single owner (Arthur
> K) per impact analysis, (3) TypeScript catches every missed callsite at
> compile time, (4) tests guard each callsite's behavior. The alternative
> (introducing a second function and migrating callsites one-by-one) would leave
> the codebase with two parallel APIs for many commits — a worse state.

- [ ] **Step 1: Write/extend the failing test for the new signature**

```typescript
// tests/core/infra/collection-name.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CollectionNotProvidedError,
  ProjectNotRegisteredError,
} from "../../../src/core/api/errors.js";
import { resolveCollection } from "../../../src/core/infra/collection-name.js";
import { CollectionRegistry } from "../../../src/core/infra/registry/collection-registry.js";

describe("resolveCollection (new signature)", () => {
  let dir: string;
  let registry: CollectionRegistry;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rc-"));
    registry = new CollectionRegistry(dir);
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("priority 1: collection wins over everything", () => {
    const out = resolveCollection(registry, {
      collection: "explicit",
      project: "x",
      path: "/x",
    });
    expect(out.collectionName).toBe("explicit");
  });

  it("priority 2: project resolves via registry", () => {
    registry.record({
      collectionName: "code_abc",
      path: "/repo",
      embeddingModel: "m",
      embeddingDimensions: 1,
      qdrantUrl: "u",
      indexedAt: "t",
      teaRagsVersion: "v",
      chunksCount: 0,
    });
    registry.setName("code_abc", "alpha");
    const out = resolveCollection(registry, { project: "alpha" });
    expect(out.collectionName).toBe("code_abc");
    expect(out.path).toBe("/repo");
  });

  it("priority 2 failure: unknown project throws ProjectNotRegisteredError", () => {
    expect(() => resolveCollection(registry, { project: "ghost" })).toThrow(
      ProjectNotRegisteredError,
    );
  });

  it("priority 3: path computes deterministic hash", () => {
    const out = resolveCollection(registry, { path: "/some/abs/path" });
    expect(out.collectionName).toMatch(/^code_[a-f0-9]{8}$/);
    expect(out.path).toBe("/some/abs/path");
  });

  it("priority 4: nothing → CollectionNotProvidedError", () => {
    expect(() => resolveCollection(registry, {})).toThrow(
      CollectionNotProvidedError,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/infra/collection-name.test.ts -t "new signature"`
Expected: FAIL — function signature still old.

- [ ] **Step 3: Update `collection-name.ts`**

```typescript
// src/core/infra/collection-name.ts
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { resolve } from "node:path";

import {
  CollectionNotProvidedError,
  ProjectNotRegisteredError,
} from "../api/errors.js";
import type { CollectionRegistry } from "./registry/collection-registry.js";

export async function validatePath(path: string): Promise<string> {
  const absolutePath = resolve(path);
  try {
    return await fs.realpath(absolutePath);
  } catch {
    return absolutePath;
  }
}

export function resolveCollectionName(path: string): string {
  const absolutePath = resolve(path);
  const hash = createHash("md5").update(absolutePath).digest("hex");
  return `code_${hash.substring(0, 8)}`;
}

export interface ResolveInput {
  collection?: string;
  project?: string;
  path?: string;
}

export function resolveCollection(
  registry: CollectionRegistry,
  input: ResolveInput,
): { collectionName: string; path?: string } {
  if (input.collection) {
    return { collectionName: input.collection, path: input.path };
  }
  if (input.project) {
    const entry = registry.findByName(input.project);
    if (!entry) {
      const available = registry
        .list()
        .map((e) => e.name)
        .filter((n): n is string => n !== null);
      throw new ProjectNotRegisteredError(input.project, available);
    }
    return { collectionName: entry.collectionName, path: entry.path };
  }
  if (input.path) {
    return {
      collectionName: resolveCollectionName(input.path),
      path: input.path,
    };
  }
  throw new CollectionNotProvidedError();
}
```

- [ ] **Step 4: Update all 7 callsites**

For each file in the modified-files list of this Task, find every
`resolveCollection(collection, path)` and replace with
`resolveCollection(this.registry, { collection, project, path })`.

For callsites that don't yet have access to `registry` and `project`, the class
will be updated in subsequent Tasks (ops/facades/pipeline). For this Task,
**inject `registry` via constructor** and **plumb `project` from the input
parameter** in each call. The DI plumbing for `registry` happens in Task 9/10;
for now, accept it as a required constructor argument and write the callsite
update — type errors at constructor sites are expected and will be fixed in
Task 9.

Example for `indexing-ops.ts`:

Before:

```typescript
const collectionName = resolveCollectionName(absolutePath);
```

After (where input contains `collection`/`project`/`path`):

```typescript
const { collectionName, path } = resolveCollection(this.registry, {
  collection: input.collection,
  project: input.project,
  path: absolutePath,
});
```

For `status-module.ts` and `schema-drift-monitor.ts` which only currently take
`path`, update to:

```typescript
const { collectionName } = resolveCollection(this.registry, {
  path: absolutePath,
});
```

- [ ] **Step 5: Add `registry` to constructors of touched classes**

Add `private readonly registry: CollectionRegistry` to constructors of:

- `IndexingOps`, `ExploreOps`, `CollectionOps`, `DocumentOps` (under
  `core/api/internal/ops/`)
- `StatusModule` (under `core/domains/ingest/pipeline/`)
- `SchemaDriftMonitor` (under `core/infra/`)
- `BaseIndexingPipeline` (under `core/domains/ingest/pipeline/`)

Use `private readonly registry: CollectionRegistry` parameter property. DO NOT
update the call-site of these constructors yet — Task 9 wires DI.

- [ ] **Step 6: Run tests and full type-check**

Run:

```
npx vitest run tests/core/infra/collection-name.test.ts
npx tsc --noEmit 2>&1 | head -50
```

Expected from vitest: 5/5 PASS on resolveCollection tests.

Expected from tsc: errors only in `composition.ts` / `factory.ts` /
`ingest-facade.ts` / `explore-facade.ts` saying registry is not provided to
constructors. These are addressed in Tasks 8-10.

- [ ] **Step 7: Update existing collection-name tests for old signature**

Find any tests currently calling `resolveCollection(coll, path)` and migrate
them to the new form. If the existing test asserts the old two-arg behavior,
replace those assertions with the new chain assertions.

- [ ] **Step 8: Commit**

```bash
git add src/core/infra/collection-name.ts \
        src/core/api/internal/ops/indexing-ops.ts \
        src/core/api/internal/ops/explore-ops.ts \
        src/core/api/internal/ops/collection-ops.ts \
        src/core/api/internal/ops/document-ops.ts \
        src/core/domains/ingest/pipeline/base.ts \
        src/core/domains/ingest/pipeline/status-module.ts \
        src/core/infra/schema-drift-monitor.ts \
        tests/core/infra/collection-name.test.ts
git commit -m "refactor(infra): resolveCollection accepts registry and project input"
```

The commit may leave compile errors in `composition.ts` / `factory.ts` — fixed
in Tasks 9-10. To keep `main` clean, commit Tasks 7-10 together as a PR or local
branch; but each step commits individually as per the workflow.

---

## Task 8: `ProjectRegistryOps` — register/list/unregister

**Files:**

- Create: `src/core/api/internal/ops/project-registry-ops.ts`
- Create: `tests/core/api/internal/ops/project-registry-ops.test.ts`

**Dependencies:** Tasks 1-4.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/api/internal/ops/project-registry-ops.test.ts
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PathDoesNotExistError,
  ProjectNameInvalidError,
  ProjectNameNotUniqueError,
} from "../../../../../src/core/api/errors.js";
import { ProjectRegistryOps } from "../../../../../src/core/api/internal/ops/project-registry-ops.js";
import { CollectionRegistry } from "../../../../../src/core/infra/registry/collection-registry.js";

describe("ProjectRegistryOps", () => {
  let dir: string;
  let realPath: string;
  let ops: ProjectRegistryOps;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pro-"));
    realPath = join(dir, "repo");
    mkdirSync(realPath, { recursive: true });
    writeFileSync(join(realPath, ".keep"), "");
    ops = new ProjectRegistryOps({ registry: new CollectionRegistry(dir) });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("register() upserts a name and returns collectionName", async () => {
    const out = await ops.register({ path: realPath, name: "alpha" });
    expect(out.collectionName).toMatch(/^code_[a-f0-9]{8}$/);
    expect(out.alreadyIndexed).toBe(false);
  });

  it("register() throws PathDoesNotExistError on missing path", async () => {
    await expect(
      ops.register({ path: "/no/such/path", name: "x" }),
    ).rejects.toThrow(PathDoesNotExistError);
  });

  it("register() throws ProjectNameInvalidError on bad regex", async () => {
    await expect(
      ops.register({ path: realPath, name: "BAD NAME" }),
    ).rejects.toThrow(ProjectNameInvalidError);
  });

  it("register() throws ProjectNameNotUniqueError on duplicate name", async () => {
    const repo2 = join(dir, "repo2");
    mkdirSync(repo2);
    await ops.register({ path: realPath, name: "shared" });
    await expect(ops.register({ path: repo2, name: "shared" })).rejects.toThrow(
      ProjectNameNotUniqueError,
    );
  });

  it("list() returns all entries", async () => {
    await ops.register({ path: realPath, name: "alpha" });
    const out = await ops.list();
    expect(out.projects).toHaveLength(1);
    expect(out.projects[0].name).toBe("alpha");
  });

  it("unregister() is idempotent (removed=false when missing)", async () => {
    const out1 = await ops.unregister({ name: "nope" });
    expect(out1.removed).toBe(false);
    await ops.register({ path: realPath, name: "alpha" });
    const out2 = await ops.unregister({ name: "alpha" });
    expect(out2.removed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/internal/ops/project-registry-ops.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ProjectRegistryOps (register/list/unregister only)**

```typescript
// src/core/api/internal/ops/project-registry-ops.ts
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  resolveCollectionName,
  validatePath,
} from "../../../infra/collection-name.js";
import type { CollectionRegistry } from "../../../infra/registry/collection-registry.js";
import type { ProjectInfo } from "../../../infra/registry/types.js";
import {
  PathDoesNotExistError,
  ProjectNameInvalidError,
  ProjectNameNotUniqueError,
} from "../../errors.js";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface ProjectRegistryOpsDeps {
  registry: CollectionRegistry;
  // qdrant + embeddings injected in Task 13 (recoverFromQdrant)
}

export class ProjectRegistryOps {
  constructor(private readonly deps: ProjectRegistryOpsDeps) {}

  async register(input: {
    path: string;
    name: string;
  }): Promise<{ collectionName: string; alreadyIndexed: boolean }> {
    if (!input.name || input.name.length === 0) {
      throw new ProjectNameInvalidError(input.name, "empty");
    }
    if (input.name.length > 64) {
      throw new ProjectNameInvalidError(input.name, "tooLong");
    }
    if (!NAME_RE.test(input.name)) {
      throw new ProjectNameInvalidError(input.name, "regex");
    }
    if (!existsSync(resolve(input.path))) {
      throw new PathDoesNotExistError(input.path);
    }
    const realPath = await validatePath(input.path);
    const collectionName = resolveCollectionName(realPath);

    const existing = this.deps.registry.get(collectionName);
    const alreadyIndexed = existing !== null && existing.chunksCount > 0;

    if (existing === null) {
      // Stub-record so setName has something to attach to.
      this.deps.registry.record({
        collectionName,
        path: realPath,
        embeddingModel: existing?.embeddingModel ?? "",
        embeddingDimensions: existing?.embeddingDimensions ?? 0,
        qdrantUrl: existing?.qdrantUrl ?? "",
        indexedAt: existing?.indexedAt ?? "",
        teaRagsVersion: existing?.teaRagsVersion ?? "",
        chunksCount: existing?.chunksCount ?? 0,
      });
    }
    try {
      this.deps.registry.setName(collectionName, input.name);
    } catch (err) {
      const msg = (err as Error).message ?? "";
      if (msg.includes("not unique")) {
        const other = this.deps.registry
          .list()
          .find((e) => e.name === input.name);
        throw new ProjectNameNotUniqueError(
          input.name,
          other?.collectionName ?? "",
        );
      }
      throw err;
    }
    return { collectionName, alreadyIndexed };
  }

  async list(): Promise<{ projects: ProjectInfo[] }> {
    return { projects: this.deps.registry.list() };
  }

  async unregister(input: { name: string }): Promise<{ removed: boolean }> {
    const entry = this.deps.registry.findByName(input.name);
    if (!entry) return { removed: false };
    return { removed: this.deps.registry.remove(entry.collectionName) };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/core/api/internal/ops/project-registry-ops.test.ts`
Expected: 6/6 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/api/internal/ops/project-registry-ops.ts \
        tests/core/api/internal/ops/project-registry-ops.test.ts
git commit -m "feat(api): add ProjectRegistryOps for register/list/unregister"
```

---

## Task 9: DI wiring — facades, composition, factory

**Files:**

- Modify: `src/core/api/internal/facades/ingest-facade.ts`
- Modify: `src/core/api/internal/facades/explore-facade.ts`
- Modify: `src/core/api/internal/composition.ts`
- Modify: `src/bootstrap/factory.ts`

**Dependencies:** Tasks 3, 7, 8.

> **Highest-blast-radius Task.** factory.ts has 23 imports / 41 commits;
> ingest-facade has 20 imports / 23 commits. Run full test suite after.

- [ ] **Step 1: Verify all type-check errors are localized to these files**

Run: `npx tsc --noEmit 2>&1 | grep -E "factory|composition|facade" | head -20`

Expected: a manageable set of "registry is missing" errors.

- [ ] **Step 2: Update `IngestFacade` constructor + propagation**

```typescript
// src/core/api/internal/facades/ingest-facade.ts

import type { CollectionRegistry } from "../../../infra/registry/collection-registry.js";

interface IngestFacadeDeps {
  // ... existing
  registry: CollectionRegistry;
}

export class IngestFacade {
  constructor(private readonly deps: IngestFacadeDeps) {
    /* ... */
  }

  // Where IndexingOps / StatusModule / etc. are constructed, pass `registry: this.deps.registry`.
}
```

- [ ] **Step 3: Update `ExploreFacade` similarly**

Add `registry: CollectionRegistry` to deps. Pass to `ExploreOps` constructor.

- [ ] **Step 4: Update `composition.ts`**

```typescript
// src/core/api/internal/composition.ts
import { CollectionRegistry } from "../../infra/registry/collection-registry.js";
import { ProjectRegistryOps } from "./ops/project-registry-ops.js";

export interface CompositionDeps {
  // ... existing
  registry: CollectionRegistry;
}

export function createComposition(deps: CompositionDeps) {
  // ... existing wiring, pass deps.registry into each facade/ops
  const projectRegistryOps = new ProjectRegistryOps({
    registry: deps.registry,
  });
  return {
    // ... existing returns
    projectRegistryOps,
  };
}
```

- [ ] **Step 5: Update `factory.ts`**

```typescript
// src/bootstrap/factory.ts
import { homedir } from "node:os";
import { join } from "node:path";
import { CollectionRegistry } from "../core/infra/registry/collection-registry.js";

export function createAppContext(config: Config): AppContext {
  // ... existing setup
  const dataDir = process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
  const registry = new CollectionRegistry(dataDir);
  const composition = createComposition({ /* existing */, registry });
  // ... rest
}
```

- [ ] **Step 6: Run full type-check + test suite**

```
npx tsc --noEmit
npx vitest run
```

Expected: tsc clean, all existing tests still pass (no regressions). New tests
from Tasks 1-8 also pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/api/internal/facades/ \
        src/core/api/internal/composition.ts \
        src/bootstrap/factory.ts
git commit -m "feat(api): wire CollectionRegistry through DI graph"
```

---

## Task 10: App interface + 3 new methods

**Files:**

- Modify: `src/core/api/public/app.ts`
- Modify: `src/core/api/index.ts` (barrel)
- Modify: `tests/core/api/public/app.test.ts` (or create)

**Dependencies:** Tasks 8, 9.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/api/public/app.test.ts (extend or create)
import { describe, expect, it } from "vitest";

import type { App } from "../../../../src/core/api/public/app.js";

describe("App interface", () => {
  it("declares registerProject, listProjects, unregisterProject", () => {
    const stub: Pick<
      App,
      "registerProject" | "listProjects" | "unregisterProject"
    > = {
      registerProject: async () => ({
        collectionName: "x",
        alreadyIndexed: false,
      }),
      listProjects: async () => ({ projects: [] }),
      unregisterProject: async () => ({ removed: false }),
    };
    expect(typeof stub.registerProject).toBe("function");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/core/api/public/app.test.ts -t "registerProject"`
Expected: FAIL — interface methods do not exist.

- [ ] **Step 3: Extend App interface**

```typescript
// src/core/api/public/app.ts
import type { ProjectInfo } from "../../infra/registry/index.js";

export interface App {
  // ... existing
  registerProject(input: {
    path: string;
    name: string;
  }): Promise<{ collectionName: string; alreadyIndexed: boolean }>;
  listProjects(): Promise<{ projects: ProjectInfo[] }>;
  unregisterProject(input: { name: string }): Promise<{ removed: boolean }>;
}

interface AppDeps {
  // ... existing
  projectRegistryOps: import("../internal/ops/project-registry-ops.js").ProjectRegistryOps;
}

export function createApp(deps: AppDeps): App {
  return {
    // ... existing
    registerProject: (input) => deps.projectRegistryOps.register(input),
    listProjects: () => deps.projectRegistryOps.list(),
    unregisterProject: (input) => deps.projectRegistryOps.unregister(input),
  };
}
```

- [ ] **Step 4: Update `api/index.ts` barrel**

Re-export from registry:

```typescript
// src/core/api/index.ts
export type { CollectionEntry, ProjectInfo } from "../infra/registry/index.js";
export { CollectionRegistry } from "../infra/registry/index.js";
```

- [ ] **Step 5: Wire `projectRegistryOps` into `createApp` invocation**

In `composition.ts` / `factory.ts`, ensure `projectRegistryOps` from composition
is passed into `createApp`'s deps.

- [ ] **Step 6: Run tests + type-check**

```
npx tsc --noEmit
npx vitest run tests/core/api/public/
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/api/public/app.ts src/core/api/index.ts \
        src/core/api/internal/composition.ts \
        tests/core/api/public/app.test.ts
git commit -m "feat(api): expose registerProject/listProjects/unregisterProject on App"
```

---

## Task 11: MCP tool — `register_project`

**Files:**

- Create: `src/mcp/tools/register-project.ts`
- Modify: `src/mcp/tools/index.ts` (barrel)
- Create: `tests/mcp/tools/register-project.test.ts`

**Dependencies:** Task 10.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp/tools/register-project.test.ts
import { describe, expect, it, vi } from "vitest";

import { registerProjectTool } from "../../../src/mcp/tools/register-project.js";

describe("register_project tool", () => {
  it("invokes app.registerProject and returns its result", async () => {
    const app = {
      registerProject: vi.fn().mockResolvedValue({
        collectionName: "code_abc",
        alreadyIndexed: false,
      }),
    };
    const result = await registerProjectTool.handler(
      { path: "/x", name: "alpha" },
      { app: app as any },
    );
    expect(app.registerProject).toHaveBeenCalledWith({
      path: "/x",
      name: "alpha",
    });
    expect(result).toEqual({
      collectionName: "code_abc",
      alreadyIndexed: false,
    });
  });
});
```

(Adapt to whatever shape `src/mcp/tools/` tools use today — refer to an existing
tool like `index-codebase.ts` for the exact registration pattern.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/tools/register-project.test.ts` Expected: FAIL —
module not found.

- [ ] **Step 3: Implement the tool**

Follow the existing pattern in `src/mcp/tools/`. Sketch:

```typescript
// src/mcp/tools/register-project.ts
import { z } from "zod";

import type { App } from "../../core/api/public/app.js";

const inputSchema = z.object({
  path: z.string().min(1),
  name: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
});

export const registerProjectTool = {
  name: "register_project",
  description: "Register a name for a project path. Stores into registry.json.",
  inputSchema,
  handler: async (
    input: z.infer<typeof inputSchema>,
    { app }: { app: App },
  ) => {
    return app.registerProject(input);
  },
};
```

Adapt to match `registerToolSafe` / `registerAllTools` conventions present in
the repo.

- [ ] **Step 4: Register in barrel**

In `src/mcp/tools/index.ts`, add the tool to the registration list.

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/mcp/tools/register-project.test.ts` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/mcp/tools/register-project.ts src/mcp/tools/index.ts \
        tests/mcp/tools/register-project.test.ts
git commit -m "feat(mcp): add register_project tool"
```

---

## Task 12: MCP tool — `list_projects`

**Files:**

- Create: `src/mcp/tools/list-projects.ts`
- Modify: `src/mcp/tools/index.ts`
- Create: `tests/mcp/tools/list-projects.test.ts`

**Dependencies:** Task 10.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp/tools/list-projects.test.ts
import { describe, expect, it, vi } from "vitest";

import { listProjectsTool } from "../../../src/mcp/tools/list-projects.js";

describe("list_projects tool", () => {
  it("returns app.listProjects result", async () => {
    const app = {
      listProjects: vi.fn().mockResolvedValue({ projects: [] }),
    };
    const result = await listProjectsTool.handler({}, { app: app as any });
    expect(result.projects).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/tools/list-projects.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement and register**

```typescript
// src/mcp/tools/list-projects.ts
import { z } from "zod";

import type { App } from "../../core/api/public/app.js";

export const listProjectsTool = {
  name: "list_projects",
  description: "List all registered projects with their collection metadata.",
  inputSchema: z.object({}),
  handler: async (_input: unknown, { app }: { app: App }) => app.listProjects(),
};
```

Register in `index.ts` barrel.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/mcp/tools/list-projects.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/list-projects.ts src/mcp/tools/index.ts tests/mcp/tools/list-projects.test.ts
git commit -m "feat(mcp): add list_projects tool"
```

---

## Task 13: MCP tool — `unregister_project`

**Files:**

- Create: `src/mcp/tools/unregister-project.ts`
- Modify: `src/mcp/tools/index.ts`
- Create: `tests/mcp/tools/unregister-project.test.ts`

**Dependencies:** Task 10.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/mcp/tools/unregister-project.test.ts
import { describe, expect, it, vi } from "vitest";

import { unregisterProjectTool } from "../../../src/mcp/tools/unregister-project.js";

describe("unregister_project tool", () => {
  it("delegates to app.unregisterProject", async () => {
    const app = {
      unregisterProject: vi.fn().mockResolvedValue({ removed: true }),
    };
    const result = await unregisterProjectTool.handler(
      { name: "alpha" },
      { app: app as any },
    );
    expect(app.unregisterProject).toHaveBeenCalledWith({ name: "alpha" });
    expect(result.removed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/mcp/tools/unregister-project.test.ts` Expected: FAIL.

- [ ] **Step 3: Implement and register**

```typescript
// src/mcp/tools/unregister-project.ts
import { z } from "zod";

import type { App } from "../../core/api/public/app.js";

const inputSchema = z.object({ name: z.string() });

export const unregisterProjectTool = {
  name: "unregister_project",
  description:
    "Remove a registered project by name. Does not touch the Qdrant collection.",
  inputSchema,
  handler: async (input: z.infer<typeof inputSchema>, { app }: { app: App }) =>
    app.unregisterProject(input),
};
```

Register in barrel.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/mcp/tools/unregister-project.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/unregister-project.ts src/mcp/tools/index.ts tests/mcp/tools/unregister-project.test.ts
git commit -m "feat(mcp): add unregister_project tool"
```

---

## Task 14: `BaseIndexingPipeline.finalizeProcessing` — registry.record()

**Files:**

- Modify: `src/core/domains/ingest/pipeline/base.ts`
- Create/modify: `tests/core/domains/ingest/pipeline/base.test.ts`

**Dependencies:** Tasks 3, 9 (registry must be injected via DI).

> **Hook point:** Real method name confirmed via grep —
> `BaseIndexingPipeline.finalizeProcessing()` already exists at line 154. Extend
> it to call `registry.record()` after Qdrant writes are complete.

- [ ] **Step 1: Read current finalizeProcessing**

Run: `sed -n '150,200p' src/core/domains/ingest/pipeline/base.ts`

Understand the order of operations. The registry write happens **last**, after
all flush/upsert/snapshot work, and is wrapped in try/catch so a failed registry
write does NOT roll back the index.

- [ ] **Step 2: Write the failing test**

```typescript
// tests/core/domains/ingest/pipeline/base.test.ts (extend existing or create)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CollectionRegistry } from "../../../../../src/core/infra/registry/collection-registry.js";

describe("BaseIndexingPipeline finalizeProcessing — registry write", () => {
  it("records a complete CollectionEntry at finalization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pipe-"));
    try {
      const registry = new CollectionRegistry(dir);
      // Build a minimal pipeline harness with mocked qdrant/embeddings.
      const qdrant = {
        url: "http://localhost:6333",
        count: vi.fn().mockResolvedValue(42),
        // ... other minimum
      };
      const embeddings = { modelId: "model-x", dimensions: 384 };
      // Construct pipeline subclass; trigger finalizeProcessing path.
      // (Adapt to existing pipeline test helpers in tests/core/domains/ingest/__helpers__/)
      // ... call finalizeProcessing ...
      const entry = registry.get("code_xxx");
      expect(entry?.embeddingModel).toBe("model-x");
      expect(entry?.embeddingDimensions).toBe(384);
      expect(entry?.qdrantUrl).toBe("http://localhost:6333");
      expect(entry?.chunksCount).toBe(42);
      expect(entry?.indexedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(entry?.name).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("registry write failure does not throw from finalizeProcessing", async () => {
    // Mock registry to throw on record; pipeline should swallow.
    // ... harness ...
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/ingest/pipeline/base.test.ts -t "registry write"`
Expected: FAIL — no registry write yet.

- [ ] **Step 4: Extend finalizeProcessing**

Open `src/core/domains/ingest/pipeline/base.ts` and add at the END of
`finalizeProcessing` (after all existing work):

```typescript
import { TEA_RAGS_VERSION } from "../../../infra/version.js"; // create if missing — pulls from package.json
// ... existing imports

protected async finalizeProcessing(
  // ... existing params
): Promise</* existing return */> {
  // ... existing body unchanged

  // Project registry — auto-populate metadata. Non-fatal on failure.
  try {
    const chunksCount = await this.qdrant.count(this.collectionName);
    this.registry.record({
      collectionName: this.collectionName,
      path: this.absolutePath,
      embeddingModel: this.embeddings.modelId,
      embeddingDimensions: this.embeddings.dimensions,
      qdrantUrl: this.qdrant.url,
      indexedAt: new Date().toISOString(),
      teaRagsVersion: TEA_RAGS_VERSION,
      chunksCount,
    });
  } catch (err) {
    pipelineLog(`registry record failed: ${(err as Error).message}`);
  }
}
```

If `TEA_RAGS_VERSION` does not exist anywhere, create it:

```typescript
// src/core/infra/version.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(__dirname, "../../../package.json"), "utf-8"),
);
export const TEA_RAGS_VERSION: string = pkg.version;
```

If something equivalent already exists, reuse it.

- [ ] **Step 5: Verify pipeline subclasses still construct correctly**

`BaseIndexingPipeline` constructor signature gained `registry` in Task 7.
Subclasses (`IndexingPipeline`, `ReindexPipeline`, etc.) must pass it through
`super(...)`.

Run: `npx tsc --noEmit` Fix any remaining "registry not provided" errors at
pipeline subclass constructor sites.

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/core/domains/ingest/pipeline/` Also: `npx vitest run`
(full suite, ensure no regressions) Expected: all pass, including new
registry-write assertions.

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/ingest/pipeline/base.ts \
        src/core/infra/version.ts \
        tests/core/domains/ingest/pipeline/base.test.ts
git commit -m "feat(pipeline): write to collection registry at finalize"
```

---

## Task 15: `recoverFromQdrant` in ProjectRegistryOps

**Files:**

- Modify: `src/core/api/internal/ops/project-registry-ops.ts`
- Modify: `tests/core/api/internal/ops/project-registry-ops.test.ts`

**Dependencies:** Tasks 8, 9.

- [ ] **Step 1: Write the failing test**

Append to `tests/core/api/internal/ops/project-registry-ops.test.ts`:

```typescript
describe("ProjectRegistryOps.recoverFromQdrant", () => {
  it("populates registry from Qdrant collections + snapshot meta", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rec-"));
    try {
      const registry = new CollectionRegistry(dir);
      const qdrant = {
        url: "http://localhost:6333",
        listCollections: async () => [
          { name: "code_abc" },
          { name: "code_def" },
        ],
        getCollectionInfo: async (n: string) => ({
          vectors: { size: n === "code_abc" ? 384 : 768 },
        }),
        scroll: async () => ({
          points: [{ payload: { runtime: { embeddingModel: "m-fake" } } }],
        }),
      };
      const embeddings = { modelId: "m-fake", dimensions: 384 };
      const ops = new ProjectRegistryOps({
        registry,
        qdrant: qdrant as any,
        embeddings: embeddings as any,
        snapshotDir: "/no/snapshots",
      });
      await ops.recoverFromQdrant();
      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list[0].indexedAt).toBe("");
      expect(list[0].chunksCount).toBe(0);
      expect(list[0].embeddingDimensions).toBe(384);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/api/internal/ops/project-registry-ops.test.ts -t recoverFromQdrant`
Expected: FAIL.

- [ ] **Step 3: Extend ProjectRegistryOps**

Update `ProjectRegistryOpsDeps`:

```typescript
import type { QdrantManager } from "../../../adapters/qdrant/client.js";
import type { EmbeddingProvider } from "../../../adapters/embeddings/base.js";

export interface ProjectRegistryOpsDeps {
  registry: CollectionRegistry;
  qdrant: QdrantManager;
  embeddings: EmbeddingProvider;
  snapshotDir: string;
}

// ... in class:
async recoverFromQdrant(): Promise<void> {
  const collections = await this.deps.qdrant.listCollections();
  for (const c of collections) {
    const collectionName = c.name;
    if (this.deps.registry.get(collectionName)) continue; // already populated
    let dimensions = 0;
    try {
      const info = await this.deps.qdrant.getCollectionInfo(collectionName);
      dimensions = info.vectors?.size ?? 0;
    } catch { /* ignore */ }
    // Try to read embeddingModel from a sample payload's `runtime` field.
    let embeddingModel = "";
    try {
      const sample = await this.deps.qdrant.scroll(collectionName, { limit: 1 });
      embeddingModel = sample.points?.[0]?.payload?.runtime?.embeddingModel ?? "";
    } catch { /* ignore */ }
    this.deps.registry.record({
      collectionName,
      path: "", // unknown without snapshot meta lookup
      embeddingModel,
      embeddingDimensions: dimensions,
      qdrantUrl: this.deps.qdrant.url,
      indexedAt: "",
      teaRagsVersion: "",
      chunksCount: 0,
    });
  }
}
```

(Adapt to the actual `QdrantManager` API — `listCollections`,
`getCollectionInfo`, `scroll` shapes.)

- [ ] **Step 4: Update composition to pass qdrant, embeddings, snapshotDir**

```typescript
// composition.ts
const projectRegistryOps = new ProjectRegistryOps({
  registry: deps.registry,
  qdrant: deps.qdrant,
  embeddings: deps.embeddings,
  snapshotDir: deps.snapshotDir,
});
```

- [ ] **Step 5: Run tests**

```
npx tsc --noEmit
npx vitest run tests/core/api/internal/ops/project-registry-ops.test.ts
```

Expected: PASS, including new recoverFromQdrant case.

- [ ] **Step 6: Commit**

```bash
git add src/core/api/internal/ops/project-registry-ops.ts \
        src/core/api/internal/composition.ts \
        tests/core/api/internal/ops/project-registry-ops.test.ts
git commit -m "feat(api): add ProjectRegistryOps.recoverFromQdrant for doctor"
```

---

## Task 16: CLI helper `applyProjectDefaults`

**Files:**

- Create: `src/cli/registry-resolver.ts`
- Create: `tests/cli/registry-resolver.test.ts`

**Dependencies:** Task 3.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/registry-resolver.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { applyProjectDefaults } from "../../src/cli/registry-resolver.ts";
import { CollectionRegistry } from "../../src/core/infra/registry/collection-registry.js";

describe("applyProjectDefaults", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-rr-"));
    process.env.TEA_RAGS_DATA_DIR = dir;
    const r = new CollectionRegistry(dir);
    r.record({
      collectionName: "code_abc",
      path: "/repo/a",
      embeddingModel: "model-y",
      embeddingDimensions: 512,
      qdrantUrl: "http://qdrant:6333",
      indexedAt: "2026-05-12T00:00:00Z",
      teaRagsVersion: "0.1",
      chunksCount: 10,
    });
    r.setName("code_abc", "alpha");
  });
  afterEach(() => {
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("no project → returns argv unchanged", () => {
    const out = applyProjectDefaults({ path: "/explicit", model: "m" });
    expect(out.path).toBe("/explicit");
    expect(out.model).toBe("m");
  });

  it("project → fills missing fields from registry", () => {
    const out = applyProjectDefaults({ project: "alpha" });
    expect(out.path).toBe("/repo/a");
    expect(out["qdrant-url"]).toBe("http://qdrant:6333");
    expect(out.model).toBe("model-y");
  });

  it("project + explicit path → explicit wins", () => {
    const out = applyProjectDefaults({ project: "alpha", path: "/override" });
    expect(out.path).toBe("/override");
    expect(out["qdrant-url"]).toBe("http://qdrant:6333");
  });

  it("unknown project name → exit code 1 (mocked)", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as any);
    expect(() => applyProjectDefaults({ project: "ghost" })).toThrow("exit");
    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });
});
```

(Add `import { vi } from "vitest"`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/registry-resolver.test.ts` Expected: FAIL —
module missing.

- [ ] **Step 3: Implement `registry-resolver.ts`**

```typescript
// src/cli/registry-resolver.ts
import { homedir } from "node:os";
import { join } from "node:path";

import { CollectionRegistry } from "../core/infra/registry/collection-registry.js";

export interface ProjectAwareArgs {
  project?: string;
  path?: string;
  "qdrant-url"?: string;
  model?: string;
}

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

export function applyProjectDefaults<A extends ProjectAwareArgs>(argv: A): A {
  if (!argv.project) return argv;
  const registry = new CollectionRegistry(resolveDataDir());
  const entry = registry.findByName(argv.project);
  if (!entry) {
    const names = registry
      .list()
      .map((e) => e.name)
      .filter((n): n is string => n !== null);
    process.stderr.write(
      `Project '${argv.project}' not registered. Available: ${names.join(", ") || "(none)"}\n`,
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

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/cli/registry-resolver.test.ts` Expected: 4/4 PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/registry-resolver.ts tests/cli/registry-resolver.test.ts
git commit -m "feat(cli): add applyProjectDefaults helper for --project resolution"
```

---

## Task 17: CLI command — `tea-rags register-project`

**Files:**

- Create: `src/cli/commands/register-project.ts`
- Modify: `src/cli/create-cli.ts`
- Create: `tests/cli/commands/register-project.test.ts`

**Dependencies:** Tasks 3, 8.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/commands/register-project.test.ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { registerProjectCommand } from "../../../src/cli/commands/register-project.js";
import { CollectionRegistry } from "../../../src/core/infra/registry/collection-registry.js";

describe("CLI register-project", () => {
  let dir: string;
  let repo: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-rp-"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".keep"), "");
    process.env.TEA_RAGS_DATA_DIR = dir;
  });
  afterEach(() => {
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes a registry entry with the given name", async () => {
    await registerProjectCommand.handler({ path: repo, name: "alpha" } as any);
    const r = new CollectionRegistry(dir);
    expect(r.findByName("alpha")?.path).toBe(
      await import("node:fs").then((fs) => fs.realpathSync(repo)),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/cli/commands/register-project.test.ts` Expected:
FAIL.

- [ ] **Step 3: Implement the command**

```typescript
// src/cli/commands/register-project.ts
import { homedir } from "node:os";
import { join } from "node:path";

import type { CommandModule } from "yargs";

import { ProjectRegistryOps } from "../../core/api/internal/ops/project-registry-ops.js";
import { CollectionRegistry } from "../../core/infra/registry/collection-registry.js";

interface Args {
  path: string;
  name: string;
}

export const registerProjectCommand: CommandModule<object, Args> = {
  command: "register-project",
  describe: "Register a name for a project path in the local registry.",
  builder: (y) =>
    y
      .option("path", { type: "string", demandOption: true })
      .option("name", { type: "string", demandOption: true }),
  handler: async (argv) => {
    const dataDir =
      process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
    const registry = new CollectionRegistry(dataDir);
    // Minimal ops construction — recoverFromQdrant not used here.
    const ops = new ProjectRegistryOps({
      registry,
      qdrant: null as never,
      embeddings: null as never,
      snapshotDir: "",
    });
    const out = await ops.register({ path: argv.path, name: argv.name });
    process.stdout.write(
      `Registered '${argv.name}' → ${out.collectionName}${out.alreadyIndexed ? " (already indexed)" : ""}\n`,
    );
  },
};
```

> **Note:** The `ProjectRegistryOps` constructor now requires qdrant/embeddings,
> but `register()` doesn't use them. Either: (a) make those optional in the deps
> interface for CLI usage, or (b) construct only `CollectionRegistry` and inline
> the validation. Option (a) is cleaner — adjust `ProjectRegistryOpsDeps` to
> mark `qdrant`/`embeddings`/`snapshotDir` as optional, and have
> `recoverFromQdrant()` assert they're present at call time. Update Task 15 if
> needed.

- [ ] **Step 4: Register the command**

In `src/cli/create-cli.ts`:

```typescript
import { registerProjectCommand } from "./commands/register-project.js";
// ...
.command(registerProjectCommand)
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/cli/commands/register-project.test.ts` Expected:
PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/register-project.ts src/cli/create-cli.ts \
        src/core/api/internal/ops/project-registry-ops.ts \
        tests/cli/commands/register-project.test.ts
git commit -m "feat(cli): add register-project command"
```

---

## Task 18: CLI commands — `list-projects` and `unregister-project`

**Files:**

- Create: `src/cli/commands/list-projects.ts`
- Create: `src/cli/commands/unregister-project.ts`
- Modify: `src/cli/create-cli.ts`
- Create: `tests/cli/commands/list-projects.test.ts`
- Create: `tests/cli/commands/unregister-project.test.ts`

**Dependencies:** Task 17.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/cli/commands/list-projects.test.ts
import { describe, expect, it, vi } from "vitest";

import { listProjectsCommand } from "../../../src/cli/commands/list-projects.js";
import { CollectionRegistry } from "../../../src/core/infra/registry/collection-registry.js";

// ... mkdtemp setup as in Task 17

it("prints registry entries", async () => {
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation((m) => {
    out.push(String(m));
    return true;
  });
  // setup registry with 2 entries
  await listProjectsCommand.handler({} as any);
  expect(out.join("")).toMatch(/alpha|beta/);
});
```

(Similar for unregister-project.)

- [ ] **Step 2: Run tests to verify they fail**

Run both. Expected: FAIL.

- [ ] **Step 3: Implement both commands**

```typescript
// src/cli/commands/list-projects.ts
import { homedir } from "node:os";
import { join } from "node:path";

import type { CommandModule } from "yargs";

import { CollectionRegistry } from "../../core/infra/registry/collection-registry.js";

interface Args {
  json?: boolean;
}

export const listProjectsCommand: CommandModule<object, Args> = {
  command: "list-projects",
  describe: "List all registered projects.",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  handler: (argv) => {
    const dataDir =
      process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
    const list = new CollectionRegistry(dataDir).list();
    if (argv.json) {
      process.stdout.write(JSON.stringify(list, null, 2) + "\n");
      return;
    }
    for (const e of list) {
      process.stdout.write(
        `${e.name ?? "(no name)"}\t${e.collectionName}\t${e.path}\n`,
      );
    }
  },
};
```

```typescript
// src/cli/commands/unregister-project.ts
import { homedir } from "node:os";
import { join } from "node:path";

import type { CommandModule } from "yargs";

import { ProjectRegistryOps } from "../../core/api/internal/ops/project-registry-ops.js";
import { CollectionRegistry } from "../../core/infra/registry/collection-registry.js";

interface Args {
  name: string;
}

export const unregisterProjectCommand: CommandModule<object, Args> = {
  command: "unregister-project",
  describe: "Remove a registered project by name (does not touch Qdrant).",
  builder: (y) => y.option("name", { type: "string", demandOption: true }),
  handler: async (argv) => {
    const dataDir =
      process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
    const registry = new CollectionRegistry(dataDir);
    const ops = new ProjectRegistryOps({ registry });
    const out = await ops.unregister({ name: argv.name });
    process.stdout.write(
      out.removed
        ? `Removed '${argv.name}'\n`
        : `'${argv.name}' was not registered\n`,
    );
  },
};
```

- [ ] **Step 4: Register in create-cli.ts**

```typescript
import { listProjectsCommand } from "./commands/list-projects.js";
import { unregisterProjectCommand } from "./commands/unregister-project.js";
// ...
.command(listProjectsCommand)
.command(unregisterProjectCommand)
```

- [ ] **Step 5: Run tests**

```
npx vitest run tests/cli/commands/list-projects.test.ts
npx vitest run tests/cli/commands/unregister-project.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/list-projects.ts src/cli/commands/unregister-project.ts \
        src/cli/create-cli.ts \
        tests/cli/commands/list-projects.test.ts tests/cli/commands/unregister-project.test.ts
git commit -m "feat(cli): add list-projects and unregister-project commands"
```

---

## Task 19: CLI `tune` — `--project` option

**Files:**

- Modify: `src/cli/commands/tune.ts`
- Modify: `tests/cli/commands/tune.test.ts` (or create)

**Dependencies:** Task 16.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/cli/commands/tune.test.ts
import { describe, expect, it, vi } from "vitest";

import { tuneCommand } from "../../../src/cli/commands/tune.js";

describe("tune --project", () => {
  it("calls applyProjectDefaults before runScript", async () => {
    // Mock applyProjectDefaults to assert it was invoked
    // Mock child_process.spawn to capture args
    // Assert that --path ends up matching the registry-resolved path
    // ... details ...
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL (no --project handling yet).

- [ ] **Step 3: Add `--project` to builder + call resolver**

```typescript
// src/cli/commands/tune.ts
import { applyProjectDefaults } from "../registry-resolver.js";

interface TuneArgs {
  project?: string;
  path?: string;
  // ... existing
}

export const tuneCommand: CommandModule<object, TuneArgs> = {
  command: "tune [subcommand]",
  describe: "Auto-tune performance parameters for your hardware",
  builder: (yargs) =>
    yargs
      // ... existing options
      .option("project", {
        type: "string",
        describe:
          "Resolve --path / --qdrant-url / --model from registry by project name",
      }),
  handler: (argv) => {
    const resolved = applyProjectDefaults(argv as never);
    const sub = resolved.subcommand as string | undefined;
    if (sub === "embeddings") {
      runScript("benchmark-embeddings.mjs", resolved);
    } else {
      runScript("tune.mjs", resolved);
    }
  },
};
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/cli/commands/tune.test.ts` Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/tune.ts tests/cli/commands/tune.test.ts
git commit -m "feat(cli): add --project option to tune command"
```

---

## Task 20: CLI other commands — `--project` option

**Files:**

- Modify: `src/cli/commands/index.ts` (if exists; verify)
- Modify: `src/cli/commands/reindex.ts` (if exists; verify)
- Modify: `src/cli/commands/status.ts` (if exists; verify)
- Modify: `src/cli/commands/metrics.ts` (if exists; verify)
- Modify: corresponding tests

**Dependencies:** Task 16.

- [ ] **Step 1: Check which commands exist**

Run: `ls src/cli/commands/`

For each project-aware command found (index, reindex, status, metrics, or
similar):

- [ ] **Step 2: Add `--project` option + applyProjectDefaults**

For each command, apply the same pattern as Task 19. Example for
`src/cli/commands/index.ts`:

```typescript
// add option:
.option("project", { type: "string", describe: "..." })

// in handler, call:
const resolved = applyProjectDefaults(argv);
```

- [ ] **Step 3: Write/update tests per command**

For each modified command, add a test verifying `--project` triggers registry
lookup.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/cli/commands/` Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/ tests/cli/commands/
git commit -m "feat(cli): add --project option to index/reindex/status/metrics commands"
```

---

## Task 21: SchemaBuilder integration in MCP tools

**Files:**

- Modify: `src/mcp/tools/*.ts` (every project-aware tool)
- Modify: `src/core/api/internal/infra/schema-builder.ts` if needed

**Dependencies:** Tasks 5, 6.

- [ ] **Step 1: Identify project-aware tools**

These tools currently accept `{ collection?, path? }`. After this Task they also
accept `project?`:

- `semantic_search`, `hybrid_search`, `search_code`, `find_symbol`,
  `find_similar`, `rank_chunks`
- `index_codebase`, `reindex_changes`, `force_reindex`, `get_index_status`,
  `get_index_metrics`
- `get_collection_info`, `clear_index`, `delete_collection`
- `add_documents`, `delete_documents` (if applicable)

- [ ] **Step 2: Verify SchemaBuilder produces a schema with `project?`**

Use whichever path applies:

- If SchemaBuilder centrally produces a "collection identifier" schema and Task
  6 was sufficient — most tools inherit automatically.
- If each tool has a hand-written schema — modify each individually to include
  `project: z.string().regex(...).optional()`.

For each tool, the corresponding handler routes `project` through the DTO. Since
Tasks 5+7 already plumbed `project` into the DTO and `resolveCollection`, no
handler code changes here — only schema.

- [ ] **Step 3: Write/extend tests for one canonical tool**

Pick `semantic_search` (or whichever is most representative). Add a test:

```typescript
it("accepts project parameter", () => {
  const schema = semanticSearchTool.inputSchema;
  expect(schema.safeParse({ query: "x", project: "alpha" }).success).toBe(true);
});
```

- [ ] **Step 4: Run tests + tsc**

```
npx tsc --noEmit
npx vitest run tests/mcp/
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/mcp/tools/ src/core/api/internal/infra/schema-builder.ts tests/mcp/
git commit -m "feat(mcp): expose project parameter in project-aware tools"
```

---

## Task 22: Documentation, beads closure, README

**Files:**

- Modify: `README.md` (Project Registry section)
- Modify: `CHANGELOG.md`
- Beads: close `tea-rags-mcp-gr4o`, reduce/close `tea-rags-mcp-2mrz`.

**Dependencies:** all previous Tasks.

- [ ] **Step 1: Add a section to README**

Add under "Configuration" or "CLI Usage":

````markdown
### Project Registry

Tea-rags maintains a per-machine registry at `~/.tea-rags/registry.json` that
records collection metadata and lets you address projects by name.

```bash
tea-rags register-project --path ./my-repo --name myrepo
tea-rags list-projects
tea-rags index --project myrepo
tea-rags tune --project myrepo
tea-rags unregister-project --name myrepo
```
````

In MCP, `register_project`, `list_projects`, `unregister_project` tools mirror
these commands. Search/indexing tools also accept an optional `project`
parameter alongside `path` and `collection`.

````

- [ ] **Step 2: Update CHANGELOG**

Add an entry under the unreleased section:

```markdown
### Added
- Project registry (`registry.json`) — auto-populated collection metadata + named
  project bindings. New MCP tools: `register_project`, `list_projects`,
  `unregister_project`. New CLI commands: `register-project`, `list-projects`,
  `unregister-project`. All project-aware tools/commands accept an optional
  `project` parameter.
````

- [ ] **Step 3: Close beads issues**

```bash
bd update tea-rags-mcp-gr4o --status=done --notes="Implemented per docs/superpowers/specs/2026-05-12-project-registry-design.md"
bd update tea-rags-mcp-2mrz --status=done --notes="Scope (register_project / list_projects / name resolution) absorbed into gr4o. Groups + federated search remain for a future shipment — file a new issue if needed."
```

- [ ] **Step 4: Final verification**

```
npx vitest run
npx tsc --noEmit
npm run lint
```

Expected: full green.

- [ ] **Step 5: Commit**

```bash
git add README.md CHANGELOG.md
git commit -m "docs: document project registry MCP tools and CLI commands"
```

---

## Self-Review Notes

**Spec coverage check:**

- §2 Schema → Task 1 (types) ✓
- §3 Components → Tasks 1-3 ✓
- §4 Resolution chain → Task 7 ✓
- §5 MCP tools + DTO → Tasks 5, 6, 8, 10, 11, 12, 13, 21 ✓
- §6 Pipeline + recovery → Tasks 14 (finalize), 15 (recovery) ✓
- §7 CLI + DI → Tasks 9, 16, 17, 18, 19, 20 ✓
- §8 Out of scope / testing / migration → respected (no groups, no
  auto-recovery, no migration step) ✓
- §9 Files matrix → cross-referenced; all listed files appear in at least one
  Task ✓
- §10 Beads relation → Task 22 closes gr4o + 2mrz ✓

**Type consistency:** `CollectionEntry` / `RecordEntryInput` / `ProjectInfo`
defined in Task 1 are used identically in Tasks 3, 8, 10, 14, 15, 17, 18 with
the same field set.

**Sequencing dependencies:**

```
T1 (types/errors/barrel) ──┬──> T2 (registry-file) ──> T3 (CollectionRegistry)
T4 (api/errors)             │
T5 (DTO mixin) ─────────────┤
T6 (SchemaBuilder) ─────────┤
                            └──> T7 (resolveCollection) ──> T9 (facades/composition/factory) ──> T10 (App)
                                                                  │
                            T8 (ProjectRegistryOps register)──────┤
                                                                  ├──> T11/12/13 (MCP tools)
                                                                  │
                                                                  ├──> T14 (pipeline finalize)
                                                                  │
                            T15 (recoverFromQdrant)────────────────┤
                                                                  │
T16 (CLI resolver)──┬──> T17 (register-project CLI)
                    ├──> T18 (list/unregister CLI)
                    ├──> T19 (tune --project)
                    └──> T20 (other --project)

T21 (SchemaBuilder per-tool integration) — after T6

T22 (docs + beads) — last
```

**Independent / parallelizable:**

- T1, T4, T5, T6, T16 are independent foundation Tasks. Can be done by separate
  workers in parallel.
- After T3 + T9 + T10 land: T11/12/13 (MCP tools) and T17/18 (CLI commands) are
  independent leaf Tasks.
- T19, T20 depend only on T16.

---

## Beads Sync (MANDATORY per `.claude/rules/.local/plan-beads-sync.md`)

After this plan is approved, before execution:

1. Create matching beads epic (title: "Project Registry foundation", parent:
   none, labels: `architecture`, `dx`, `api`).
2. Create 22 beads tasks 1:1 with plan Tasks 1-22. Use plan Task titles. Labels
   per the dependency-tree above (mostly `api`, some `dx`, T14 also
   `architecture`).
3. Add `bd dep add` for each Task → previous Task per the sequencing graph.
4. Link the new epic as blocking `tea-rags-mcp-1wxw` (doctor),
   `tea-rags-mcp-hpg2` (watcher), `tea-rags-mcp-fl2q` (sub-collections),
   `tea-rags-mcp-mc87` (multi-collection search).

---

## Execution Handoff

**Plan complete and saved to
`docs/superpowers/plans/2026-05-12-project-registry.md`. Two execution
options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task,
review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using
`dinopowers:executing-plans` (NOT superpowers — wrapper required per chaining
rule), batch execution with checkpoints.

**Which approach?**
