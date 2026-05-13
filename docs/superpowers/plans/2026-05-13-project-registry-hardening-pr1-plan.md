# Project Registry Hardening — PR1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `dinopowers:executing-plans`
> (NOT `superpowers:executing-plans`) and `dinopowers:test-driven-development`
> (NOT `superpowers:test-driven-development`) for the failing-test-first phases.
> If running via subagents, use `superpowers:subagent-driven-development` (that
> one is NOT wrapped). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close audit items #1, #2, #3, #4, #9, #10, #11 by hardening the
project-registry foundation in `src/core/infra/registry/` plus four touch-points
(`api/errors.ts`, `api/internal/ops/project-registry-ops.ts`,
`mcp/tools/register-project.ts`, `bootstrap/factory.ts`). All changes are
internal — `RegistryFileV1` shape and the `App` API surface stay
byte-compatible.

**Architecture:** Merge-on-write with CAS retry in `registry-file.ts`,
`fs.watch`-based cache invalidation in `CollectionRegistry`, inline migration
framework (`KNOWN_MIGRATIONS` map), corrupt-file backup before fallback,
single-source `PROJECT_NAME_RE`, single typed `ProjectNameNotUniqueError`.

**Tech Stack:** TypeScript (strict), vitest, lint-staged (prettier + tsc
pre-commit). Target: `src/core/infra/registry/**`.

**Spec:**
`docs/superpowers/specs/2026-05-13-project-registry-hardening-design.md` (commit
`bcf10bf5` in worktree `project-registry-hardening`). Read it before drafting
any change.

---

## Affected Files (tea-rags impact enrichment, rerank: imports+churn+ownership)

| File                                                    | Owner                                     | Churn                  | Age | Bugs | Tasks      |
| ------------------------------------------------------- | ----------------------------------------- | ---------------------- | --- | ---- | ---------- |
| `src/bootstrap/factory.ts`                              | Arthur 66% (shared with Artur — same UID) | **41 commits extreme** | 12d | n/a  | 8          |
| `src/core/api/errors.ts`                                | Arthur 100% deep-silo                     | 2 commits low          | 49d | n/a  | 2          |
| `src/core/infra/registry/registry-file.ts`              | Arthur (new)                              | new                    | 1d  | —    | 3, 4       |
| `src/core/infra/registry/collection-registry.ts`        | Arthur (new)                              | new                    | 1d  | —    | 2, 4, 6, 7 |
| `src/core/infra/registry/types.ts`                      | Arthur (new)                              | new                    | 1d  | —    | 1          |
| `src/core/infra/registry/errors.ts`                     | Arthur (new)                              | new                    | 1d  | —    | 1          |
| `src/core/infra/registry/index.ts`                      | Arthur (new)                              | new                    | 1d  | —    | 1, 7       |
| `src/core/infra/registry/constants.ts`                  | — (new file)                              | —                      | —   | —    | 1          |
| `src/core/api/internal/ops/project-registry-ops.ts`     | Arthur (new)                              | new                    | 1d  | —    | 5          |
| `src/mcp/tools/register-project.ts`                     | Arthur (new)                              | new                    | 1d  | —    | 5          |
| `tests/core/infra/registry/registry-file.test.ts`       | (existing)                                | —                      | —   | —    | 3, 4       |
| `tests/core/infra/registry/collection-registry.test.ts` | (existing)                                | —                      | —   | —    | 4, 6, 7    |
| `tests/core/infra/registry/migrate.test.ts`             | — (new)                                   | —                      | —   | —    | 3          |
| `tests/core/api/errors.test.ts`                         | (existing)                                | —                      | —   | —    | 2          |
| `tests/bootstrap/factory.test.ts`                       | (existing)                                | —                      | —   | —    | 8          |

**Coordinated change candidates** (shared `taskIds`): none — greenfield
hardening, no existing tickets thread through these files.

**High-blast-radius file:** `src/bootstrap/factory.ts` — 41 commits extreme
churn, composition root, 22 transitive import edges. The factory edit is
isolated into Task 8 with its own test and run AFTER all registry-internal Tasks
are green.

---

## Out of scope (do NOT modify)

- `src/core/infra/collection-name.ts:resolveCollection` signature (main risk
  node per all three rerank lenses — bugFixRate 50% critical).
- `RegistryFileV1` shape — version stays at 1, schema unchanged.
- `record()` semantics (still idempotent, still sticky name) — only adds input
  validation in Task 6.
- `App` public API (`registerProject` / `listProjects` / `unregisterProject`
  stay byte-compatible — verified via no-changes diff on
  `core/api/public/app.ts` after this PR).
- CLI commands and MCP tools beyond the regex swap in Task 5 — orphan UX +
  doctor live in PR2.
- `proper-lockfile` or any concurrency-related dependency — native
  merge-on-write + CAS is enough.

---

## Beads Epic — create FIRST, before Task 1

```bash
bd dolt pull
bd create \
  --title="PR1 — registry foundation hardening" \
  --description="Spec: docs/superpowers/specs/2026-05-13-project-registry-hardening-design.md (commit bcf10bf5). Plan: docs/superpowers/plans/2026-05-13-project-registry-hardening-pr1-plan.md. Closes audit items #1 (CAS+merge-on-write), #2 (fs.watch), #3 (corrupt-backup), #4 (dedup ProjectNameNotUniqueError), #9 (PROJECT_NAME_RE consolidation), #10 (migration framework), #11 (record validation). RegistryFileV1 shape unchanged. App surface unchanged." \
  --type=epic \
  --priority=2
# Returns an issue ID — capture as $EPIC (e.g. tea-rags-mcp-XXX) and reuse below.
bd label add $EPIC architecture
bd label add $EPIC bugfix
bd label add $EPIC dx
```

Each subsequent Task creates a beads task and links it to `$EPIC` and to the
previous Task. Capture each returned ID as `$T1`…`$T8`.

---

## Task 1: Foundation primitives — `constants.ts`, `RegistryConcurrencyError`, barrel

**Goal:** Introduce shared `PROJECT_NAME_RE` constant and typed
`RegistryConcurrencyError` that downstream Tasks depend on. No behaviour change
yet — just additive primitives. Smallest possible green commit.

**Beads:**

```bash
bd dolt pull
bd create \
  --title="registry: add PROJECT_NAME_RE constant + RegistryConcurrencyError type" \
  --description="Create src/core/infra/registry/constants.ts exporting PROJECT_NAME_RE. Add RegistryConcurrencyError extends InfraError in errors.ts. Update index.ts barrel. Closes audit #9 (constant) and primes #1 (error type). No behaviour change. Spec §A,§B." \
  --type=task \
  --priority=2
# Capture as $T1
bd label add $T1 architecture
bd dep add $T1 $EPIC
```

**Files:**

- Create: `src/core/infra/registry/constants.ts`
- Modify: `src/core/infra/registry/errors.ts` (append
  `RegistryConcurrencyError`)
- Modify: `src/core/infra/registry/index.ts` (export new symbols)

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T1 --status=in_progress
```

- [ ] **Step 2: Create `constants.ts`**

File: `src/core/infra/registry/constants.ts`

```ts
/**
 * Project Registry shared constants.
 *
 * Single source of truth for runtime values consumed by multiple layers
 * (CollectionRegistry, ProjectRegistryOps, MCP register_project tool).
 * Types belong in types.ts; this file holds regex / numeric / string
 * primitives that survive a Zod schema rebuild.
 */

/**
 * Valid project-alias regex. Constraints: lowercase letters, digits, dash,
 * underscore; must start with letter or digit; max 64 chars.
 *
 * Consumed by:
 * - CollectionRegistry.setName (runtime validation)
 * - ProjectRegistryOps.register (input validation)
 * - mcp/tools/register-project (Zod schema via PROJECT_NAME_RE.source)
 */
export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
```

- [ ] **Step 3: Append `RegistryConcurrencyError` to `errors.ts`**

File: `src/core/infra/registry/errors.ts` (append after `RegistryWriteError`):

```ts
/**
 * Thrown when the CAS retry loop in flush() exhausts its attempts because
 * another process keeps mutating registry.json. Indicates sustained
 * contention; the caller should log and move on (pipeline) or surface to
 * the user (interactive CLI).
 */
export class RegistryConcurrencyError extends InfraError {
  constructor(path: string, attempts: number) {
    super({
      code: "INFRA_REGISTRY_CONCURRENCY",
      message: `Registry file at ${path} was modified concurrently across ${attempts} attempts`,
      hint: "Retry the operation; if it persists, check for runaway tea-rags processes.",
      httpStatus: 503,
    });
  }
}
```

- [ ] **Step 4: Update `index.ts` barrel**

File: `src/core/infra/registry/index.ts`:

```ts
/**
 * Project Registry barrel.
 *
 * Foundation layer — no domain deps. See
 * docs/superpowers/specs/2026-05-12-project-registry-design.md §3.
 */

export type {
  CollectionEntry,
  ProjectInfo,
  RecordEntryInput,
  RegistryFileV1,
} from "./types.js";
export { PROJECT_NAME_RE } from "./constants.js";
export {
  RegistryFileCorruptedError,
  RegistryWriteError,
  RegistryConcurrencyError,
} from "./errors.js";
export { loadRegistryFile, saveRegistryFile } from "./registry-file.js";
export {
  CollectionRegistry,
  ProjectNameNotUniqueError,
} from "./collection-registry.js";
```

- [ ] **Step 5: Run build + tests**

Run: `npm run build && npx vitest run` Expected: PASS — no behaviour change,
additive only.

- [ ] **Step 6: Commit**

```bash
git add src/core/infra/registry/constants.ts \
        src/core/infra/registry/errors.ts \
        src/core/infra/registry/index.ts
git commit -m "$(cat <<'EOF'
feat(registry): add PROJECT_NAME_RE constant and RegistryConcurrencyError

Foundation primitives for upcoming dedup (#9) and CAS retry loop (#1).
No behaviour change — additive only.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Close beads task**

```bash
bd close $T1
```

---

## Task 2: Dedup `ProjectNameNotUniqueError` — keep typed, drop plain

**Goal:** Remove the plain-`Error` duplicate from
`src/core/infra/registry/collection-registry.ts` and route `setName` to throw
the typed `InputValidationError` subclass from `src/core/api/errors.ts`.
Middleware then correctly maps it to a 400 instead of 500. Closes audit #4.

**Beads:**

```bash
bd dolt pull
bd create \
  --title="registry: dedup ProjectNameNotUniqueError into typed InputValidationError" \
  --description="Delete plain ProjectNameNotUniqueError from collection-registry.ts. Import the typed subclass from api/errors.ts. setName throws the typed one. Closes audit #4 (middleware now maps to 400). Spec §A 'What we explicitly DO NOT do' — no api/errors.ts ProjectNameNotUniqueError signature change." \
  --type=task \
  --priority=2
# Capture as $T2
bd label add $T2 bugfix
bd label add $T2 architecture
bd dep add $T2 $EPIC
```

**Files:**

- Modify: `src/core/infra/registry/collection-registry.ts` (remove local class,
  import typed)
- Modify: `src/core/infra/registry/index.ts` (re-export from `api/errors.ts`
  location OR drop the re-export entirely)
- Modify: `tests/core/api/errors.test.ts` (extend — assert single definition +
  instanceof InputValidationError)

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T2 --status=in_progress
```

- [ ] **Step 2: Write the failing assertion**

File: `tests/core/api/errors.test.ts` — append:

```ts
import {
  InputValidationError,
  ProjectNameNotUniqueError,
} from "../../../src/core/api/errors.js";

describe("ProjectNameNotUniqueError dedup (audit #4)", () => {
  it("is an InputValidationError so the MCP middleware maps it to 400", () => {
    const err = new ProjectNameNotUniqueError("foo", "code_abc");
    expect(err).toBeInstanceOf(InputValidationError);
  });

  it("has a single definition in the codebase", async () => {
    const fromApi = await import("../../../src/core/api/errors.js");
    const fromRegistry =
      await import("../../../src/core/infra/registry/index.js");
    expect(fromApi.ProjectNameNotUniqueError).toBe(
      fromRegistry.ProjectNameNotUniqueError,
    );
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/core/api/errors.test.ts -t "dedup"` Expected: FAIL —
second assertion fails because `registry/index.ts` re-exports the plain class
from `collection-registry.ts`, not the typed one from `api/errors.ts`.

- [ ] **Step 4: Remove the local plain-Error duplicate**

File: `src/core/infra/registry/collection-registry.ts` — replace lines 1–9:

```ts
import { ProjectNameNotUniqueError } from "../../api/errors.js";
import { PROJECT_NAME_RE } from "./constants.js";
import { loadRegistryFile, saveRegistryFile } from "./registry-file.js";
import type {
  CollectionEntry,
  RecordEntryInput,
  RegistryFileV1,
} from "./types.js";
```

Delete the local `class ProjectNameNotUniqueError extends Error` block and the
local `NAME_RE` constant (the latter is now imported as `PROJECT_NAME_RE` from
constants.ts — Task 1 introduced it).

Update `setName` body to throw the imported typed class (signature is
`new ProjectNameNotUniqueError(name, existingCollectionName)` — matches the
api/errors.ts constructor):

```ts
if (name !== null) {
  if (!PROJECT_NAME_RE.test(name)) {
    throw new Error(`Name '${name}' does not match ${PROJECT_NAME_RE.source}`);
  }
  for (const other of map.values()) {
    if (other.name === name && other.collectionName !== collectionName) {
      throw new ProjectNameNotUniqueError(name, other.collectionName);
    }
  }
}
```

(The first `throw new Error` for regex mismatch stays as plain `Error` for now —
it's a programmer-error / invariant violation. Task 6 replaces it with a typed
`ProjectNameInvalidError`.)

- [ ] **Step 5: Re-export the typed class through registry barrel**

File: `src/core/infra/registry/index.ts` — replace the line that re-exports
`ProjectNameNotUniqueError`:

```ts
export { CollectionRegistry } from "./collection-registry.js";
export { ProjectNameNotUniqueError } from "../../api/errors.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/core/api/errors.test.ts -t "dedup"` Expected: PASS.

- [ ] **Step 7: Run full vitest + build**

Run: `npm run build && npx vitest run` Expected: PASS — confirm no regression in
collection-registry.test.ts.

- [ ] **Step 8: Commit**

```bash
git add src/core/infra/registry/collection-registry.ts \
        src/core/infra/registry/index.ts \
        tests/core/api/errors.test.ts
git commit -m "$(cat <<'EOF'
refactor(registry): dedup ProjectNameNotUniqueError into typed subclass

Remove the local plain-Error definition from collection-registry.ts; setName
now throws the InputValidationError subclass from api/errors.ts so the MCP
middleware maps it to 400 instead of 500. Closes audit #4.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Close beads task**

```bash
bd close $T2
```

---

## Task 3: Migration framework + corrupt-file backup

**Goal:** `loadRegistryFile` becomes the central guard: `version === CURRENT`
returns as-is, `KNOWN_MIGRATIONS[version]` transforms-then-saves-back, otherwise
renames the corrupt file to a timestamped `.bak` and throws. Empty
`KNOWN_MIGRATIONS` for V1 — the framework exists for the next bump. Closes audit
items #3 and #10.

**Beads:**

```bash
bd dolt pull
bd create \
  --title="registry: add migration framework + corrupt-file backup" \
  --description="loadRegistryFile dispatches on version: CURRENT → as-is, KNOWN_MIGRATIONS → transform+save, otherwise backupCorruptFile(*.corrupt-<ISO>.bak) + throw. KNOWN_MIGRATIONS empty for V1. Closes audit #3 (no silent overwrite) and #10 (V2 migration ready). Spec §B + §B-bonus." \
  --type=task \
  --priority=2
# Capture as $T3
bd label add $T3 architecture
bd label add $T3 bugfix
bd dep add $T3 $T2
bd dep add $T3 $EPIC
```

**Files:**

- Modify: `src/core/infra/registry/registry-file.ts` (add `KNOWN_MIGRATIONS`,
  `migrateRegistryFile`, `backupCorruptFile`; dispatch in `loadRegistryFile`)
- Create: `tests/core/infra/registry/migrate.test.ts`
- Modify: `tests/core/infra/registry/registry-file.test.ts` (extend for
  backup-on-corrupt scenarios)

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T3 --status=in_progress
```

- [ ] **Step 2: Write the failing test — migration framework no-op for V1**

File: `tests/core/infra/registry/migrate.test.ts` (new):

```ts
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
import { loadRegistryFile } from "../../../../src/core/infra/registry/registry-file.js";

describe("registry migration framework (audit #10)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "regmig-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns V1 as-is when version matches CURRENT_VERSION", () => {
    writeFileSync(
      join(dir, "registry.json"),
      JSON.stringify({
        version: 1,
        collections: {
          code_abc: {
            collectionName: "code_abc",
            path: "/x",
            name: null,
            embeddingModel: "m",
            embeddingDimensions: 1,
            qdrantUrl: "http://q",
            indexedAt: "",
            teaRagsVersion: "",
            chunksCount: 0,
          },
        },
      }),
      "utf-8",
    );
    const result = loadRegistryFile(dir);
    expect(result?.version).toBe(1);
    expect(Object.keys(result?.collections ?? {})).toContain("code_abc");
  });
});

describe("registry corrupt-file backup (audit #3)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "regcrp-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("renames the file to *.corrupt-<ISO>.bak before throwing on JSON parse failure", () => {
    writeFileSync(join(dir, "registry.json"), "{not-json", "utf-8");
    expect(() => loadRegistryFile(dir)).toThrow(RegistryFileCorruptedError);
    const files = require("node:fs").readdirSync(dir);
    const backup = files.find(
      (f: string) =>
        f.startsWith("registry.json.corrupt-") && f.endsWith(".bak"),
    );
    expect(backup).toBeDefined();
    expect(existsSync(join(dir, "registry.json"))).toBe(false);
  });

  it("renames the file before throwing on unknown version", () => {
    writeFileSync(
      join(dir, "registry.json"),
      JSON.stringify({ version: 99, collections: {} }),
      "utf-8",
    );
    expect(() => loadRegistryFile(dir)).toThrow(RegistryFileCorruptedError);
    const files = require("node:fs").readdirSync(dir);
    expect(
      files.some((f: string) => f.startsWith("registry.json.corrupt-")),
    ).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run tests/core/infra/registry/migrate.test.ts` Expected: FAIL —
current `loadRegistryFile` throws but does not rename the corrupt file; current
code does not declare `CURRENT_VERSION`.

- [ ] **Step 4: Implement the migration framework + backup in
      `registry-file.ts`**

File: `src/core/infra/registry/registry-file.ts` — full replacement (keep
`saveRegistryFile` body, modify only the imports and `loadRegistryFile` plus add
helpers):

```ts
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
const CURRENT_VERSION = 1 as const;

/**
 * Registered migrations transform an older on-disk shape into the current
 * RegistryFileV1. Empty in this PR — framework only. When a V2 lands, add
 * `1: (raw) => transformV1toV2(raw)` here in the same PR as the schema bump.
 */
const KNOWN_MIGRATIONS: Record<number, (raw: unknown) => RegistryFileV1> = {};

function filePath(dataDir: string): string {
  return join(dataDir, FILE_NAME);
}

/**
 * Rename a corrupt registry.json to registry.json.corrupt-<ISO>.bak so the
 * user can recover entries by hand or via `tea-rags doctor --recover-registry`
 * (PR2). Best-effort: if the rename itself fails, log to stderr and re-throw
 * the caller's corruption error — never silently overwrite.
 */
function backupCorruptFile(path: string): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${path}.corrupt-${stamp}.bak`;
  try {
    renameSync(path, backupPath);
    process.stderr.write(
      `[tea-rags] corrupt registry preserved at ${backupPath}\n`,
    );
  } catch (err) {
    process.stderr.write(
      `[tea-rags] failed to back up corrupt registry: ${(err as Error).message}\n`,
    );
  }
}

export function loadRegistryFile(dataDir: string): RegistryFileV1 | null {
  const path = filePath(dataDir);
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, "utf-8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    backupCorruptFile(path);
    throw new RegistryFileCorruptedError(
      path,
      `JSON parse failed: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    backupCorruptFile(path);
    throw new RegistryFileCorruptedError(path, "root is not an object");
  }
  const obj = parsed as { version?: unknown; collections?: unknown };
  if (obj.version === CURRENT_VERSION) {
    if (typeof obj.collections !== "object" || obj.collections === null) {
      backupCorruptFile(path);
      throw new RegistryFileCorruptedError(
        path,
        "collections is not an object",
      );
    }
    return obj as RegistryFileV1;
  }
  if (typeof obj.version === "number" && KNOWN_MIGRATIONS[obj.version]) {
    const migrated = KNOWN_MIGRATIONS[obj.version](parsed);
    saveRegistryFile(dataDir, migrated);
    return migrated;
  }
  backupCorruptFile(path);
  throw new RegistryFileCorruptedError(
    path,
    `unsupported version ${String(obj.version)}`,
  );
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

- [ ] **Step 5: Update existing corrupt-recovery test in CollectionRegistry**

The existing test at
`tests/core/infra/registry/collection-registry.test.ts:100-121` asserts that a
corrupt file is recovered to empty Map. That behaviour is preserved BUT the file
is now renamed first. Extend the test:

```ts
it("recovers as empty when registry.json is corrupt (writes warning, backs up file, no throw)", () => {
  writeFileSync(join(dir, "registry.json"), "{not-json", "utf-8");
  const stderr: string[] = [];
  const spy = vi.spyOn(process.stderr, "write").mockImplementation(((
    m: string,
  ) => {
    stderr.push(String(m));
    return true;
  }) as never);
  try {
    const r = new CollectionRegistry(dir);
    expect(r.list()).toEqual([]);
    expect(r.get("anything")).toBeNull();
    r.record(makeEntry());
    expect(r.get("code_abc")?.path).toBe("/repo/a");
    // The corrupt file must have been preserved as a .bak before fallback.
    const files = require("node:fs").readdirSync(dir);
    expect(
      files.some((f: string) => f.startsWith("registry.json.corrupt-")),
    ).toBe(true);
  } finally {
    spy.mockRestore();
  }
  expect(stderr.join("")).toMatch(/registry corrupt/);
});
```

- [ ] **Step 6: Run tests to verify all pass**

Run: `npx vitest run tests/core/infra/registry/` Expected: PASS (4 new
assertions + existing extended test).

- [ ] **Step 7: Run full build**

Run: `npm run build` Expected: PASS — no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/core/infra/registry/registry-file.ts \
        tests/core/infra/registry/migrate.test.ts \
        tests/core/infra/registry/collection-registry.test.ts
git commit -m "$(cat <<'EOF'
feat(registry): add migration framework and corrupt-file backup

loadRegistryFile dispatches on payload version: CURRENT returns as-is,
KNOWN_MIGRATIONS transforms+persists, otherwise backupCorruptFile renames
to registry.json.corrupt-<ISO>.bak before throwing. KNOWN_MIGRATIONS is
empty for V1 — the framework exists for the next schema bump.

Closes audit #3 (no silent overwrite of corrupt files) and primes #10
(future RegistryFileV2 migration path is wired in).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Close beads task**

```bash
bd close $T3
```

---

## Task 4: CAS + merge-on-write in `flush()`

**Goal:** Replace the unconditional read-modify-write in
`CollectionRegistry.flush` with a CAS retry loop: snapshot inode+mtime before
the disk read, merge in-memory delta with on-disk snapshot, re-stat before
rename, retry up to 5× on stat mismatch with exp-backoff (10→160ms), throw
`RegistryConcurrencyError` on exhaustion. This closes audit #1 (cross-process
race) and is the biggest behavioural Task in the PR.

**Beads:**

```bash
bd dolt pull
bd create \
  --title="registry: CAS retry loop and merge-on-write in flush()" \
  --description="CollectionRegistry.flush re-reads disk, merges per-collection LWW (sticky name with directional bias: in-memory non-null wins, in-memory null + disk non-null → disk wins), and atomic-renames. Inode+mtime CAS before rename; up to 5 retries with exp-backoff (10→160ms); throws RegistryConcurrencyError after exhaustion. Pure helpers mergeRegistryEntries + mergeRegistryDelta live in registry-file.ts and are unit-tested directly. Spec §A. Closes audit #1." \
  --type=task \
  --priority=2
# Capture as $T4
bd label add $T4 architecture
bd label add $T4 bugfix
bd dep add $T4 $T3
bd dep add $T4 $EPIC
```

**Files:**

- Modify: `src/core/infra/registry/registry-file.ts` (export
  `mergeRegistryEntries`, `mergeRegistryDelta`, new `flushWithCAS` function)
- Modify: `src/core/infra/registry/collection-registry.ts` (`flush` calls
  `flushWithCAS`)
- Modify: `tests/core/infra/registry/registry-file.test.ts` (CAS retry mocked)
- Modify: `tests/core/infra/registry/collection-registry.test.ts`
  (merge-on-write LWW, sticky name directional bias)

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T4 --status=in_progress
```

- [ ] **Step 2: Write failing tests for the pure merge helpers**

File: `tests/core/infra/registry/registry-file.test.ts` — append:

```ts
import {
  mergeRegistryDelta,
  mergeRegistryEntries,
} from "../../../../src/core/infra/registry/registry-file.js";
import type {
  CollectionEntry,
  RegistryFileV1,
} from "../../../../src/core/infra/registry/types.js";

function entry(over: Partial<CollectionEntry> = {}): CollectionEntry {
  return {
    collectionName: "code_abc",
    path: "/repo/a",
    name: null,
    embeddingModel: "m",
    embeddingDimensions: 384,
    qdrantUrl: "http://localhost:6333",
    indexedAt: "2026-05-12T00:00:00.000Z",
    teaRagsVersion: "0.1.0",
    chunksCount: 10,
    ...over,
  };
}

describe("mergeRegistryEntries (per-collection LWW)", () => {
  it("in-memory wins for non-name fields", () => {
    const disk = entry({ chunksCount: 10 });
    const mem = entry({ chunksCount: 20 });
    expect(mergeRegistryEntries(disk, mem).chunksCount).toBe(20);
  });

  it("in-memory non-null name wins (audit #1, sticky name directional bias)", () => {
    const disk = entry({ name: "old" });
    const mem = entry({ name: "new" });
    expect(mergeRegistryEntries(disk, mem).name).toBe("new");
  });

  it("disk non-null name wins when in-memory is null (don't erase concurrent rename)", () => {
    const disk = entry({ name: "concurrent" });
    const mem = entry({ name: null });
    expect(mergeRegistryEntries(disk, mem).name).toBe("concurrent");
  });
});

describe("mergeRegistryDelta", () => {
  it("inserts new collections from delta", () => {
    const disk: RegistryFileV1 = {
      version: 1,
      collections: { code_a: entry({ collectionName: "code_a" }) },
    };
    const delta = new Map([
      ["code_b", entry({ collectionName: "code_b", path: "/repo/b" })],
    ]);
    const merged = mergeRegistryDelta(disk, delta);
    expect(Object.keys(merged.collections)).toEqual(["code_a", "code_b"]);
  });

  it("preserves disk-only entries not in delta", () => {
    const disk: RegistryFileV1 = {
      version: 1,
      collections: { code_a: entry({ collectionName: "code_a" }) },
    };
    const delta = new Map<string, CollectionEntry>();
    const merged = mergeRegistryDelta(disk, delta);
    expect(merged.collections.code_a).toBeDefined();
  });
});
```

- [ ] **Step 3: Write failing test for CAS retry**

File: `tests/core/infra/registry/registry-file.test.ts` — append (uses `vi.mock`
of `node:fs.statSync` to flip inode on second call):

```ts
import { RegistryConcurrencyError } from "../../../../src/core/infra/registry/errors.js";
import { flushWithCAS } from "../../../../src/core/infra/registry/registry-file.js";

describe("flushWithCAS retry loop (audit #1)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "regcas-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("succeeds on the first attempt when stat is stable", () => {
    const delta = new Map([["code_a", entry({ collectionName: "code_a" })]]);
    flushWithCAS(dir, delta);
    const saved = loadRegistryFile(dir);
    expect(saved?.collections.code_a).toBeDefined();
  });

  it("retries when inode changes mid-flush and eventually succeeds", () => {
    // Pre-seed the file so stat returns a real inode.
    saveRegistryFile(dir, { version: 1, collections: {} });
    let callCount = 0;
    const realStat = require("node:fs").statSync;
    const spy = vi
      .spyOn(require("node:fs"), "statSync")
      .mockImplementation((p: string) => {
        callCount++;
        const real = realStat(p);
        // Pretend the inode flipped between the "before" and "after" stat on the
        // first attempt; stabilise from attempt 2.
        if (callCount === 2)
          return { ...real, ino: real.ino + 1, mtimeMs: real.mtimeMs + 1 };
        return real;
      });
    try {
      const delta = new Map([["code_a", entry({ collectionName: "code_a" })]]);
      flushWithCAS(dir, delta);
      const saved = loadRegistryFile(dir);
      expect(saved?.collections.code_a).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("throws RegistryConcurrencyError after 5 failed attempts", async () => {
    saveRegistryFile(dir, { version: 1, collections: {} });
    const realStat = require("node:fs").statSync;
    let flipCount = 0;
    const spy = vi
      .spyOn(require("node:fs"), "statSync")
      .mockImplementation((p: string) => {
        flipCount++;
        const real = realStat(p);
        // Flip inode on every "after" call (even attempt → before, odd → after).
        if (flipCount % 2 === 0)
          return {
            ...real,
            ino: real.ino + flipCount,
            mtimeMs: real.mtimeMs + flipCount,
          };
        return real;
      });
    try {
      const delta = new Map([["code_a", entry({ collectionName: "code_a" })]]);
      expect(() => flushWithCAS(dir, delta)).toThrow(RegistryConcurrencyError);
    } finally {
      spy.mockRestore();
    }
  });
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `npx vitest run tests/core/infra/registry/registry-file.test.ts -t "merge"`
Expected: FAIL — `mergeRegistryEntries`, `mergeRegistryDelta`, `flushWithCAS` do
not yet exist.

- [ ] **Step 5: Implement the merge helpers + CAS flush**

File: `src/core/infra/registry/registry-file.ts` — add at top (after the
existing exports already in place):

```ts
import { statSync } from "node:fs";

import { RegistryConcurrencyError } from "./errors.js";
import type { CollectionEntry } from "./types.js";

const CAS_MAX_ATTEMPTS = 5;
const CAS_BACKOFF_MS_BASE = 10;

/**
 * Per-collection last-writer-wins with a directional bias on the sticky
 * `name` field:
 *
 *   - in-memory non-null wins (explicit user action via setName)
 *   - in-memory null + disk non-null → disk wins (don't erase concurrent rename)
 *
 * All other fields take in-memory value.
 */
export function mergeRegistryEntries(
  disk: CollectionEntry,
  mem: CollectionEntry,
): CollectionEntry {
  const name = mem.name !== null ? mem.name : disk.name;
  return { ...mem, name };
}

/**
 * Merge an in-memory delta (Map<collectionName, CollectionEntry>) into the
 * on-disk RegistryFileV1. Disk-only entries are preserved; delta-only entries
 * are inserted; overlapping entries go through mergeRegistryEntries.
 */
export function mergeRegistryDelta(
  disk: RegistryFileV1 | null,
  delta: Map<string, CollectionEntry>,
): RegistryFileV1 {
  const out: Record<string, CollectionEntry> = {};
  if (disk) {
    for (const [k, v] of Object.entries(disk.collections)) out[k] = v;
  }
  for (const [k, v] of delta.entries()) {
    const onDisk = out[k];
    out[k] = onDisk ? mergeRegistryEntries(onDisk, v) : v;
  }
  return { version: CURRENT_VERSION, collections: out };
}

function sleepSync(ms: number): void {
  // Vitest tests must run synchronously; pipeline writes are off the hot path,
  // so a busy-wait of ≤160ms is acceptable. (If this becomes a problem, lift
  // flush to async — but then the 5 callers in pipeline/CLI must follow.)
  const end = Date.now() + ms;
  while (Date.now() < end) {
    /* spin */
  }
}

function statOrNull(path: string): { ino: number; mtimeMs: number } | null {
  try {
    const s = statSync(path);
    return { ino: s.ino, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Flush an in-memory delta to disk under cross-process CAS. Retries up to
 * CAS_MAX_ATTEMPTS times with exp-backoff if another writer mutates the file
 * between our read and our rename. Throws RegistryConcurrencyError on
 * exhaustion. Audit #1.
 */
export function flushWithCAS(
  dataDir: string,
  delta: Map<string, CollectionEntry>,
): void {
  const path = filePath(dataDir);
  for (let attempt = 0; attempt < CAS_MAX_ATTEMPTS; attempt++) {
    const before = statOrNull(path);
    const disk = loadRegistryFile(dataDir);
    const merged = mergeRegistryDelta(disk, delta);
    const after = statOrNull(path);
    const stable =
      (before === null && after === null) ||
      (before !== null &&
        after !== null &&
        before.ino === after.ino &&
        before.mtimeMs === after.mtimeMs);
    if (stable) {
      saveRegistryFile(dataDir, merged);
      return;
    }
    if (attempt < CAS_MAX_ATTEMPTS - 1) {
      sleepSync(CAS_BACKOFF_MS_BASE * 2 ** attempt);
    }
  }
  throw new RegistryConcurrencyError(path, CAS_MAX_ATTEMPTS);
}
```

- [ ] **Step 6: Wire `CollectionRegistry.flush` to `flushWithCAS`**

File: `src/core/infra/registry/collection-registry.ts` — replace the body of
`flush()`:

```ts
private flush(): void {
  const map = this.ensureLoaded();
  flushWithCAS(this.dataDir, map);
}
```

Also update the imports at the top:

```ts
import { flushWithCAS, loadRegistryFile } from "./registry-file.js";
```

(Note: `loadRegistryFile` still used by `ensureLoaded`. `saveRegistryFile`
import — if no longer used directly here — should be removed.)

- [ ] **Step 7: Run tests to verify all pass**

Run: `npx vitest run tests/core/infra/registry/` Expected: PASS (3 merge tests +
3 CAS tests + all existing tests still green).

- [ ] **Step 8: Run full vitest + build**

Run: `npm run build && npx vitest run` Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/core/infra/registry/registry-file.ts \
        src/core/infra/registry/collection-registry.ts \
        tests/core/infra/registry/registry-file.test.ts
git commit -m "$(cat <<'EOF'
fix(registry): merge-on-write with inode+mtime CAS in flush()

CollectionRegistry.flush() now re-reads the on-disk file, merges with the
in-memory delta (per-collection last-writer-wins; sticky name keeps a
directional bias — in-memory non-null wins, disk wins when in-memory is
null), and atomic-renames the result. The read–merge–rename triple is
guarded by an inode+mtime CAS retry loop (max 5 attempts, 10→160ms
backoff). On contention exhaustion, throws RegistryConcurrencyError.

Closes audit #1 (cross-process read-modify-write race that could lose
entries written by a concurrent CLI or pipeline indexing run).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 10: Close beads task**

```bash
bd close $T4
```

---

## Task 5: Consolidate `PROJECT_NAME_RE` across callers

**Goal:** Replace the two remaining inline regex literals
(`project-registry-ops.ts:11` and `mcp/tools/register-project.ts:20`) with the
shared `PROJECT_NAME_RE` from `registry/constants.ts`. The MCP-tool Zod schema
uses `PROJECT_NAME_RE.source` to keep the user-facing error message identical.
Closes audit #9.

**Beads:**

```bash
bd dolt pull
bd create \
  --title="registry: route project-registry-ops + mcp register tool to PROJECT_NAME_RE" \
  --description="Replace two inline /^[a-z0-9][a-z0-9_-]{0,63}$/ literals with import { PROJECT_NAME_RE } from registry constants. Zod schema in mcp/tools/register-project.ts uses PROJECT_NAME_RE so source string is identical to current — no schema-drift, no user-facing message change. Closes audit #9 (regex drift across 3 sites)." \
  --type=task \
  --priority=2
# Capture as $T5
bd label add $T5 architecture
bd dep add $T5 $T1
bd dep add $T5 $EPIC
```

**Files:**

- Modify: `src/core/api/internal/ops/project-registry-ops.ts`
- Modify: `src/mcp/tools/register-project.ts`

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T5 --status=in_progress
```

- [ ] **Step 2: Update `project-registry-ops.ts`**

File: `src/core/api/internal/ops/project-registry-ops.ts`. At the top of the
imports, add:

```ts
import { PROJECT_NAME_RE } from "../../../infra/registry/constants.js";
```

Delete the local declaration on line 11:

```ts
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
```

Replace the three usages in `register()` (the test on line 30):

```ts
if (!PROJECT_NAME_RE.test(input.name)) {
  throw new ProjectNameInvalidError(input.name, "regex");
}
```

- [ ] **Step 3: Update `register-project.ts` MCP tool**

File: `src/mcp/tools/register-project.ts`. Add import:

```ts
import { PROJECT_NAME_RE } from "../../core/infra/registry/index.js";
```

Replace the regex literal in the Zod schema:

```ts
const RegisterProjectSchema = {
  path: z.string().min(1).describe("Absolute path to project root"),
  name: z
    .string()
    .regex(PROJECT_NAME_RE, `Project name must match ${PROJECT_NAME_RE.source}`)
    .describe(
      "Short alias to register for this project (lowercase, digits, '-', '_'; max 64 chars)",
    ),
};
```

- [ ] **Step 4: Run build + vitest**

Run: `npm run build && npx vitest run` Expected: PASS — existing
`mcp/tools/register-project.test.ts` validates regex error message; identical
`.source` means identical message.

- [ ] **Step 5: Commit**

```bash
git add src/core/api/internal/ops/project-registry-ops.ts \
        src/mcp/tools/register-project.ts
git commit -m "$(cat <<'EOF'
refactor(registry): route ops + MCP tool to shared PROJECT_NAME_RE

Replace two inline regex literals with import from registry constants.
Zod schema uses PROJECT_NAME_RE so .source is identical — no schema
drift, no user-facing message change. Closes audit #9 (NAME_RE drift
risk across 3 sites).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 6: Close beads task**

```bash
bd close $T5
```

---

## Task 6: `record()` input validation

**Goal:** `CollectionRegistry.record` accepts any `RecordEntryInput` today —
including empty `collectionName` and negative `embeddingDimensions`. Add a
narrow validation block at the top of `record()` that throws typed errors for
malformed input. Closes audit #11.

**Beads:**

```bash
bd dolt pull
bd create \
  --title="registry: input validation in CollectionRegistry.record()" \
  --description="Throw on empty/whitespace collectionName, on negative embeddingDimensions, on chunksCount<0. Reuse existing typed errors (e.g. plain Error for invariant violations). Does not validate name (name lives in setName via PROJECT_NAME_RE in Task 2). Closes audit #11." \
  --type=task \
  --priority=2
# Capture as $T6
bd label add $T6 bugfix
bd dep add $T6 $T5
bd dep add $T6 $EPIC
```

**Files:**

- Modify: `src/core/infra/registry/collection-registry.ts`
- Modify: `tests/core/infra/registry/collection-registry.test.ts`

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T6 --status=in_progress
```

- [ ] **Step 2: Write failing tests**

File: `tests/core/infra/registry/collection-registry.test.ts` — append:

```ts
describe("record() input validation (audit #11)", () => {
  it("rejects empty collectionName", () => {
    const r = new CollectionRegistry(dir);
    expect(() => r.record(makeEntry({ collectionName: "" }))).toThrow(
      /collectionName/,
    );
  });

  it("rejects negative embeddingDimensions", () => {
    const r = new CollectionRegistry(dir);
    expect(() => r.record(makeEntry({ embeddingDimensions: -1 }))).toThrow(
      /embeddingDimensions/,
    );
  });

  it("rejects negative chunksCount", () => {
    const r = new CollectionRegistry(dir);
    expect(() => r.record(makeEntry({ chunksCount: -5 }))).toThrow(
      /chunksCount/,
    );
  });

  it("accepts entries with empty embeddingModel and qdrantUrl (stub from recoverFromQdrant)", () => {
    // Audit #5 will tighten this in PR2 — for now ensure stubs still round-trip.
    const r = new CollectionRegistry(dir);
    expect(() =>
      r.record(makeEntry({ embeddingModel: "", qdrantUrl: "", indexedAt: "" })),
    ).not.toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:
`npx vitest run tests/core/infra/registry/collection-registry.test.ts -t "input validation"`
Expected: FAIL — current `record()` accepts everything.

- [ ] **Step 4: Add validation block to `record()`**

File: `src/core/infra/registry/collection-registry.ts` — modify `record()`:

```ts
record(entry: RecordEntryInput): void {
  if (typeof entry.collectionName !== "string" || entry.collectionName.trim().length === 0) {
    throw new Error(`Invalid collectionName: ${JSON.stringify(entry.collectionName)}`);
  }
  if (typeof entry.embeddingDimensions !== "number" || entry.embeddingDimensions < 0) {
    throw new Error(`Invalid embeddingDimensions: ${entry.embeddingDimensions}`);
  }
  if (typeof entry.chunksCount !== "number" || entry.chunksCount < 0) {
    throw new Error(`Invalid chunksCount: ${entry.chunksCount}`);
  }
  const map = this.ensureLoaded();
  const existing = map.get(entry.collectionName);
  map.set(entry.collectionName, {
    ...entry,
    name: existing?.name ?? null,
  });
  this.flush();
}
```

Plain `Error` is correct here per `.claude/rules/typed-errors.md`: these are
invariant violations from internal callers (pipeline, ops), not user input. The
Zod-schema layer in MCP tools catches malformed user input upstream.

- [ ] **Step 5: Run tests to verify all pass**

Run: `npx vitest run tests/core/infra/registry/` Expected: PASS.

- [ ] **Step 6: Run full build**

Run: `npm run build` Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/infra/registry/collection-registry.ts \
        tests/core/infra/registry/collection-registry.test.ts
git commit -m "$(cat <<'EOF'
feat(registry): reject malformed entries in CollectionRegistry.record()

Throw on empty collectionName, negative embeddingDimensions, negative
chunksCount. Plain Error is appropriate — these are invariant violations
from internal callers (pipeline, ops), not user input. Stub entries with
empty model/url still round-trip (audit #5 tightens that in PR2).

Closes audit #11.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Close beads task**

```bash
bd close $T6
```

---

## Task 7: `startWatching()` — `fs.watch` cache invalidation

**Goal:** Add `CollectionRegistry.startWatching(): () => void` that subscribes
to `fs.watch(registryPath)` and clears `this.cache` on every change event.
Returns a stop handle (the `FSWatcher#close` fn) so the caller can clean up on
shutdown. Bootstrap (Task 8) calls this only for the long-lived MCP server.
Closes audit #2.

**Beads:**

```bash
bd dolt pull
bd create \
  --title="registry: fs.watch-based cache invalidation in CollectionRegistry" \
  --description="Add startWatching(): () => void to CollectionRegistry. Subscribes to fs.watch(registryPath), clears this.cache on every 'change' event so next ensureLoaded re-reads from disk. Returns stop fn (FSWatcher.close bound). Idempotent — multiple calls return the same stop handle. Spec §A.3. Closes audit #2." \
  --type=task \
  --priority=2
# Capture as $T7
bd label add $T7 architecture
bd label add $T7 bugfix
bd dep add $T7 $T4
bd dep add $T7 $EPIC
```

**Files:**

- Modify: `src/core/infra/registry/collection-registry.ts`
- Modify: `src/core/infra/registry/index.ts` (no new export — startWatching is
  an instance method, but verify barrel still works)
- Modify: `tests/core/infra/registry/collection-registry.test.ts`

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T7 --status=in_progress
```

- [ ] **Step 2: Write failing test**

File: `tests/core/infra/registry/collection-registry.test.ts` — append:

```ts
describe("startWatching() (audit #2)", () => {
  it("returns a stop function", () => {
    const r = new CollectionRegistry(dir);
    const stop = r.startWatching();
    expect(typeof stop).toBe("function");
    stop();
  });

  it("invalidates the cache when registry.json changes on disk", async () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry({ collectionName: "code_a", path: "/repo/a" }));
    const stop = r.startWatching();
    expect(r.get("code_a")?.path).toBe("/repo/a");

    // External writer mutates the file behind r's back.
    saveRegistryFile(dir, {
      version: 1,
      collections: {
        code_a: {
          collectionName: "code_a",
          path: "/repo/b-external",
          name: null,
          embeddingModel: "m",
          embeddingDimensions: 384,
          qdrantUrl: "http://localhost:6333",
          indexedAt: "2026-05-13T00:00:00.000Z",
          teaRagsVersion: "0.1.0",
          chunksCount: 10,
        },
      },
    });

    // Let fs.watch deliver the event.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(r.get("code_a")?.path).toBe("/repo/b-external");
    stop();
  });

  it("is idempotent — second call returns the same stop handle", () => {
    const r = new CollectionRegistry(dir);
    const stop1 = r.startWatching();
    const stop2 = r.startWatching();
    expect(stop1).toBe(stop2);
    stop1();
  });
});
```

(Test file already imports `saveRegistryFile` from earlier tasks; if not, add to
imports.)

- [ ] **Step 3: Run test to verify failure**

Run:
`npx vitest run tests/core/infra/registry/collection-registry.test.ts -t "startWatching"`
Expected: FAIL — `startWatching` does not exist.

- [ ] **Step 4: Implement `startWatching`**

File: `src/core/infra/registry/collection-registry.ts`. Add to imports:

```ts
import { watch, type FSWatcher } from "node:fs";
import { join } from "node:path";
```

Add a private field and method to the class:

```ts
private watcher: FSWatcher | null = null;
private stopHandle: (() => void) | null = null;

/**
 * Subscribe to registry.json mtime changes and invalidate the in-process
 * cache on every event so the next read sees fresh data written by a
 * concurrent CLI or pipeline run. Returns a stop handle that closes the
 * watcher. Idempotent — repeated calls return the same handle. Audit #2.
 */
startWatching(): () => void {
  if (this.stopHandle !== null) return this.stopHandle;
  const path = join(this.dataDir, "registry.json");
  // fs.watch fails if the path does not exist yet; tolerate by deferring
  // the watch until the first flush creates the file. We accept losing
  // the very first external mutation (extremely unlikely race) in
  // exchange for not throwing at construction time.
  try {
    this.watcher = watch(path, { persistent: false }, () => {
      this.cache = null;
    });
  } catch {
    this.watcher = null;
  }
  this.stopHandle = () => {
    if (this.watcher !== null) {
      this.watcher.close();
      this.watcher = null;
    }
    this.stopHandle = null;
  };
  return this.stopHandle;
}
```

- [ ] **Step 5: Run tests to verify all pass**

Run: `npx vitest run tests/core/infra/registry/` Expected: PASS.

- [ ] **Step 6: Run full build**

Run: `npm run build` Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/core/infra/registry/collection-registry.ts \
        tests/core/infra/registry/collection-registry.test.ts
git commit -m "$(cat <<'EOF'
feat(registry): fs.watch-based cache invalidation in CollectionRegistry

Add startWatching() that subscribes to registry.json mtime events and
clears the in-process cache so the next read sees fresh data written by
a concurrent CLI or pipeline run. Returns a stop handle for shutdown.
Idempotent. Bootstrap (Task 8) wires it up only for the long-lived MCP
server; CLI processes don't call it.

Closes audit #2 (long-lived MCP server cache stale across CLI writes).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Close beads task**

```bash
bd close $T7
```

---

## Task 8: Wire `startWatching` into `bootstrap/factory.ts`

**Goal:** Call `collectionRegistry.startWatching()` exactly once when
constructing the MCP server context, never when running CLI commands. This is
the highest-blast-radius file in the PR (41 commits extreme churn) — keep the
diff minimal, run the full test suite, and verify the build cleanly.

**Beads:**

```bash
bd dolt pull
bd create \
  --title="bootstrap: wire CollectionRegistry.startWatching for MCP server context" \
  --description="In src/bootstrap/factory.ts:182, after `new CollectionRegistry(config.paths.appData)`, call startWatching() and store the stop handle on the returned AppContext so the server lifecycle can close it on shutdown. Do NOT call from CLI command entry points. High-blast-radius file (41 commits extreme churn) — minimal diff, dedicated test." \
  --type=task \
  --priority=2
# Capture as $T8
bd label add $T8 architecture
bd dep add $T8 $T7
bd dep add $T8 $EPIC
```

**Files:**

- Modify: `src/bootstrap/factory.ts` (add `startWatching()` call in the MCP
  server context construction; expose the stop handle on `AppContext`)
- Modify: `tests/bootstrap/factory.test.ts` (assert startWatching was called
  exactly once when factory builds the MCP context)

---

- [ ] **Step 1: Mark task in progress**

```bash
bd update $T8 --status=in_progress
```

- [ ] **Step 2: Verify wiring site is still at the documented location**

Run: `grep -n 'new CollectionRegistry' src/bootstrap/factory.ts` Expected: a
single match at line 182 inside `createAppContext`:
`const collectionRegistry = new CollectionRegistry(config.paths.appData);`. If
churn has moved it (factory.ts has 41 commits extreme churn — recent shuffles
are likely), adjust the anchor in Step 5 accordingly. The `cleanup` closure was
at line 222 at plan-authoring time.

- [ ] **Step 3: Write failing factory test**

First check whether `tests/bootstrap/factory.test.ts` exists. Run:
`ls tests/bootstrap/ 2>/dev/null`. If the directory or file is absent, create
the test file as the first step.

File: `tests/bootstrap/factory.test.ts` — add (or extend) with:

```ts
import { describe, expect, it, vi } from "vitest";

describe("createAppContext wires CollectionRegistry.startWatching (audit #2)", () => {
  it("calls startWatching exactly once and cleanup closes the watcher", async () => {
    const stop = vi.fn();
    const startWatching = vi.fn(() => stop);
    vi.doMock("../../src/core/infra/registry/index.js", async () => {
      const actual = await vi.importActual<
        typeof import("../../src/core/infra/registry/index.js")
      >("../../src/core/infra/registry/index.js");
      class WatchingRegistry extends actual.CollectionRegistry {
        startWatching = startWatching;
      }
      return { ...actual, CollectionRegistry: WatchingRegistry };
    });
    const { createAppContext } = await import("../../src/bootstrap/factory.js");
    // Reuse the minimal-config builder that other factory.test.ts cases use.
    // If no such helper exists yet, build the smallest AppConfig the factory
    // accepts (paths.appData = tmpdir, paths.snapshots = tmpdir, qdrantUrl
    // pointing at a mock manager). See tests/bootstrap/factory.test.ts for
    // the existing pattern (if file exists) or copy from
    // tests/core/api/create-app.test.ts which exercises a similar shape.
    const ctx = await createAppContext(/* minimal config */);
    expect(startWatching).toHaveBeenCalledOnce();
    ctx.cleanup?.();
    expect(stop).toHaveBeenCalledOnce();
    vi.doUnmock("../../src/core/infra/registry/index.js");
  });
});
```

The two assertions together cover: (a) the watcher is started exactly once at
factory time (no leak via repeated subscriptions), (b) `cleanup` closes it so
SIGINT shutdown doesn't keep an event listener alive.

- [ ] **Step 4: Run test to verify failure**

Run: `npx vitest run tests/bootstrap/factory.test.ts -t "startWatching"`
Expected: FAIL — factory doesn't call startWatching yet.

- [ ] **Step 5: Wire the call in `factory.ts`**

File: `src/bootstrap/factory.ts`. After line 182
(`const collectionRegistry = new CollectionRegistry(config.paths.appData);`),
insert:

```ts
const registryWatchStop = collectionRegistry.startWatching();
```

Then thread the stop handle into the existing `cleanup` closure at line 222 (do
not introduce a new `AppContext` field — `cleanup` is the documented
graceful-shutdown hook already declared in the `AppContext` interface at line
50). Modified `cleanup`:

```ts
const cleanup = () => {
  registryWatchStop();
  if (
    "terminate" in infra.embeddings &&
    typeof infra.embeddings.terminate === "function"
  ) {
    void (infra.embeddings as { terminate: () => Promise<void> }).terminate();
  }
  if (infra.embeddedRelease) {
    infra.embeddedRelease();
  }
};
```

Rationale: `cleanup` is the only `AppContext` field whose JSDoc reads "Graceful
shutdown" (line 49) — adding the watcher-stop to it keeps the public surface
unchanged. The MCP entrypoint already calls `cleanup` on SIGINT/SIGTERM; the CLI
test path that uses `createAppContext` without an MCP server transport also
calls it on exit. CLI command entry points (`src/cli/commands/*.ts`) construct a
fresh `CollectionRegistry` themselves and never call `startWatching` — confirmed
via `grep -rn 'startWatching\|new CollectionRegistry' src/cli/` (only
short-lived constructors, no watcher calls).

- [ ] **Step 6: Run tests to verify all pass**

Run: `npx vitest run tests/bootstrap/` Expected: PASS.

- [ ] **Step 7: Run full build + full vitest**

Run: `npm run build && npx vitest run` Expected: PASS — high-churn file, run the
whole suite to confirm nothing downstream regresses.

- [ ] **Step 8: Commit**

```bash
git add src/bootstrap/factory.ts tests/bootstrap/factory.test.ts
git commit -m "$(cat <<'EOF'
feat(bootstrap): start CollectionRegistry watcher for MCP server context

Call startWatching() once during createAppContext so external registry
writes (from CLI commands or pipeline indexing in another process)
invalidate the in-process cache. The stop handle is threaded into the
existing `cleanup` closure — no new AppContext surface. CLI command
entry points do not call startWatching — they construct fresh registry
instances and exit immediately, so cache invalidation is moot.

Closes audit #2 end-to-end (Task 7 added the primitive, this Task wires
it in).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Close beads task and the epic**

```bash
bd close $T8
bd close $EPIC --reason="PR1 complete — all 7 audit items closed (#1, #2, #3, #4, #9, #10, #11)"
```

---

## Done-criteria for the whole PR1

- `npm run build` passes.
- `npx vitest run` passes (all existing + new tests).
- Audit items #1, #2, #3, #4, #9, #10, #11 closed (each Task references the
  number in its commit message).
- `git diff main -- src/core/api/public/app.ts` empty (App surface
  byte-compatible).
- `git diff main -- src/core/infra/collection-name.ts` empty
  (`resolveCollection` signature untouched).
- `git diff main -- src/core/infra/registry/types.ts` shows no changes to
  `RegistryFileV1` shape — version still 1.
- No new top-level dependency added to `package.json`.
- 8 atomic commits, each on a meaningful audit-item scope.
- Worktree branch `worktree-project-registry-hardening` ready for PR creation
  via `dinopowers:requesting-code-review`.

PR2 (recovery + UX) and PR3 (polish) will have their own plans drafted after PR1
merges. Don't start them here.
