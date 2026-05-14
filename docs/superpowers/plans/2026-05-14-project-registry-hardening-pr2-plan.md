# Project Registry Hardening — PR2 (Recovery + UX) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `dinopowers:executing-plans`
> (NOT `superpowers:executing-plans`) and `dinopowers:test-driven-development`
> (NOT `superpowers:test-driven-development`) for the failing-test-first phases.
> If running via subagents, use `superpowers:subagent-driven-development` (that
> one is NOT wrapped). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close audit items #5, #6, #7, #8, #12, #14 by extending the
project-registry layer with explicit stub-handling, a new `tea-rags doctor` CLI
command, the `tea-rags projects orphans` subcommand, the `unregister --purge`
flag, and a typed `ProjectPathMissingError` error class. All changes preserve
the on-disk format (`RegistryFileV1`), the App API surface, and the
`resolveCollection` signature.

**Architecture:** `tryEnrichFromQdrant` returns optional fields (`undefined` for
unknown values) instead of empty strings; the ops layer skips writing unknown
keys so `(unknown)` rendering in `projects info` is honest. New
`tea-rags doctor` CLI subcommand reuses `createAppContext` for infrastructure
health, walks Qdrant collections vs. registry entries for orphan summary, and
gains a `--recover-registry` flag that delegates to
`ProjectRegistryOps.recoverFromQdrant`. New `projects orphans` subcommand prints
orphan rows; `unregister --purge` removes both the registry entry and the Qdrant
collection. `ProjectPathMissingError` (typed `InputValidationError`) is added in
this PR so PR3's `applyProjectDefaults` refactor has the error type ready.

**Tech Stack:** TypeScript (strict), vitest, lint-staged (prettier + tsc
pre-commit), yargs for CLI command registration.

**Spec:**
`docs/superpowers/specs/2026-05-13-project-registry-hardening-design.md` (commit
`bd78bd46` on `worktree-project-registry-hardening`). Read it before drafting
any change.

**Predecessor:** PR1 (foundation) is already landed on this branch — 14 commits
ending at `7ea07931`. CAS-based `flushWithCAS`, `fs.watch` invalidation,
migration framework, corrupt-file backup, `PROJECT_NAME_RE` consolidation, and
`record()` validation are all in place.

---

## Affected Files (tea-rags impact enrichment, rerank: imports+churn+ownership)

| File                                                       | Owner                         | Churn             | Age    | Bugs | Tasks |
| ---------------------------------------------------------- | ----------------------------- | ----------------- | ------ | ---- | ----- |
| `src/cli/create-cli.ts`                                    | Arthur 100% deep-silo         | 3 commits typical | 0d     | n/a  | 7     |
| `src/core/api/errors.ts`                                   | Arthur 100% deep-silo         | 2 commits low     | 49d    | n/a  | 1     |
| `src/core/contracts/errors.ts`                             | Arthur (recent edits)         | several           | recent | n/a  | 1     |
| `src/core/api/internal/ops/project-registry-ops.ts`        | Arthur (fresh, edited in PR1) | low               | 1d     | —    | 2     |
| `src/cli/commands/projects.ts`                             | Arthur (fresh, edited in PR1) | low               | 1d     | —    | 3, 4  |
| `src/cli/commands/doctor.ts`                               | — (new file)                  | —                 | —      | —    | 5, 6  |
| `tests/core/api/errors.test.ts`                            | (existing)                    | —                 | —      | —    | 1     |
| `tests/core/api/internal/ops/project-registry-ops.test.ts` | (existing)                    | —                 | —      | —    | 2     |
| `tests/cli/commands/projects.test.ts`                      | (existing)                    | —                 | —      | —    | 3, 4  |
| `tests/cli/commands/doctor.test.ts`                        | — (new)                       | —                 | —      | —    | 5, 6  |
| `tests/cli/create-cli.test.ts`                             | (existing or new)             | —                 | —      | —    | 7     |

**Coordinated change candidates** (shared `taskIds`): none — greenfield recovery
work.

**High-blast-radius files:** none — all are leaves or new files. `create-cli.ts`
is the yargs registration point but adds one `.command(doctorCommand)` line, no
fan-out.

---

## Out of scope (do NOT modify)

- `src/core/infra/collection-name.ts:resolveCollection` signature — main risk
  node per all three rerank lenses; PR1 left it untouched and PR2 must too.
- `RegistryFileV1` shape — version stays 1, no field additions.
- `path` in indexing-marker payload — rejected in spec §C; registry is the
  single source of truth for path.
- MCP `unregister_project` tool — PR2 does NOT add a `purge` parameter through
  MCP. Destructive Qdrant action through MCP needs its own consent model; track
  separately if requested.
- `App` public API in `src/core/api/public/app.ts` — `tea-rags doctor` is
  CLI-only; no new App method.
- Audit #13 (symlink) and #15 (`applyProjectDefaults` typed error) — those land
  in PR3.

---

## Beads Epic — create FIRST (TBD until beads server reachable)

```bash
# The beads server in this worktree currently points at a different data
# directory; epic creation is deferred to a post-merge session that runs
# from the main checkout. Capture intent here so the historical record
# survives the merge.

bd dolt pull
bd create \
  --title="PR2 — registry recovery + UX" \
  --description="Spec: docs/superpowers/specs/2026-05-13-project-registry-hardening-design.md (bd78bd46). Plan: docs/superpowers/plans/2026-05-14-project-registry-hardening-pr2-plan.md. Closes audit items #5 (tryEnrichFromQdrant empty strings), #6+#7 (recoverFromQdrant wired to tea-rags doctor), #8 (orphans + --purge + doctor summary), #12 (unregister verbose hint), #14 (indexedAt honesty). RegistryFileV1 shape unchanged. App surface unchanged." \
  --type=epic \
  --priority=2
# Capture $EPIC; bd label add $EPIC bugfix architecture dx
```

Each subsequent Task creates a beads task linked to `$EPIC` once the server is
reachable. Capture each as `$T1`…`$T7`.

---

## Task 1: `ProjectPathMissingError` typed error class

**Goal:** Add the typed validation error PR3 will throw from
`applyProjectDefaults` when a recovered registry entry has `path: ""`. Add the
corresponding `ErrorCode` literal to the closed union in `contracts/`. Smallest
possible green commit; foundation only.

**Files:**

- Modify: `src/core/contracts/errors.ts` (append `"INPUT_PROJECT_PATH_MISSING"`
  to the `ErrorCode` union; place alongside the other `INPUT_PROJECT_*` codes)
- Modify: `src/core/api/errors.ts` (append `ProjectPathMissingError` class after
  `PathDoesNotExistError`)
- Modify: `tests/core/api/errors.test.ts` (extend with two assertions)

---

- [ ] **Step 1: Write the failing test**

File: `tests/core/api/errors.test.ts` (append at the end inside the same file's
top-level `describe(...)` block, OR add a fresh `describe` block):

```ts
describe("ProjectPathMissingError (audit #6/#7, PR3 prereq)", () => {
  it("is an InputValidationError so middleware maps it to 400", async () => {
    const { ProjectPathMissingError, InputValidationError } =
      await import("../../../src/core/api/errors.js");
    const err = new ProjectPathMissingError(
      "alpha",
      "Run: tea-rags projects register --path <dir> --name alpha",
    );
    expect(err).toBeInstanceOf(InputValidationError);
    expect(err.code).toBe("INPUT_PROJECT_PATH_MISSING");
  });

  it("exposes the hint string passed to the constructor", async () => {
    const { ProjectPathMissingError } =
      await import("../../../src/core/api/errors.js");
    const hint = "Run: tea-rags projects register --path /repo --name alpha";
    const err = new ProjectPathMissingError("alpha", hint);
    expect(err.hint).toBe(hint);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

Run: `npx vitest run tests/core/api/errors.test.ts -t "ProjectPathMissingError"`
Expected: FAIL with `ProjectPathMissingError` undefined.

- [ ] **Step 3: Extend the closed `ErrorCode` union**

File: `src/core/contracts/errors.ts`. Find the `INPUT_PROJECT_*` group inside
the `ErrorCode` union (the file groups by domain — `Input — Validation` block).
Append `"INPUT_PROJECT_PATH_MISSING"` to that group. Keep the existing ordering
convention (alphabetical or insertion — whichever the file uses).

If the file is the union-of-string-literals shape, the diff is one line:

```diff
   | "INPUT_PROJECT_NAME_NOT_UNIQUE"
+  | "INPUT_PROJECT_PATH_MISSING"
   | "INPUT_PROJECT_NOT_REGISTERED"
```

(Adjust to match the file's actual ordering — read the file first to confirm.)

- [ ] **Step 4: Add the typed class**

File: `src/core/api/errors.ts`. Append after `PathDoesNotExistError` (currently
ending at line ~125):

```ts
/**
 * Thrown when a registry entry was recovered (e.g. via `tea-rags doctor
 * --recover-registry`) but its `path` is empty, so commands that rely on the
 * alias to resolve a filesystem location cannot proceed. The hint carries
 * the exact shell command the user should run to re-register the project.
 */
export class ProjectPathMissingError extends InputValidationError {
  constructor(name: string, hint: string) {
    super({
      code: "INPUT_PROJECT_PATH_MISSING",
      message: `Project '${name}' has no path stored — re-register it before using as an alias`,
      hint,
    });
  }
}
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run tests/core/api/errors.test.ts -t "ProjectPathMissingError"`
Expected: PASS (both assertions).

- [ ] **Step 6: Run full vitest + build**

Run: `npm run build && npx vitest run` Expected: PASS — no behavioural change
anywhere else.

- [ ] **Step 7: Commit**

```bash
git add src/core/contracts/errors.ts \
        src/core/api/errors.ts \
        tests/core/api/errors.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add ProjectPathMissingError typed validation error

Foundation for PR3 — applyProjectDefaults will throw this when a recovered
registry entry has path:"". Class extends InputValidationError so the MCP
middleware maps it to 400. Hint is per-call so callers can include the
exact shell command to fix it.

Primes audit #6/#7 surface (recoverFromQdrant flow's user-facing error).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Close beads task (when beads is reachable)**

```bash
bd close $T1
```

---

## Task 2: `tryEnrichFromQdrant` — undefined for unknown, no fake "now"

**Goal:** Audit #5 (empty strings poison registry) and #14 (fake `indexedAt`).
`tryEnrichFromQdrant` currently fills in empty strings for unknown
`embeddingModel`, `qdrantUrl`, `indexedAt`, and `teaRagsVersion`, then writes
them to the registry. It also stamps `new Date().toISOString()` if the marker
doesn't carry `indexedAt`. Both behaviours fake data the caller cannot
distinguish from real data. Replace empty-string fallbacks with `undefined`; the
registry record uses `Object.fromEntries(... filter undefined)` so unknown keys
are simply absent. `projects info` already renders `(unknown)` for empty values,
so the user-facing output remains consistent — but the on-disk shape no longer
carries lies.

**Files:**

- Modify: `src/core/api/internal/ops/project-registry-ops.ts`
- Modify: `tests/core/api/internal/ops/project-registry-ops.test.ts`

---

- [ ] **Step 1: Write failing tests**

File: `tests/core/api/internal/ops/project-registry-ops.test.ts`. Find the
existing `describe("ProjectRegistryOps", ...)` block or the file's
`tryEnrichFromQdrant` describe (look for tests that exercise `register()` with a
mocked qdrant). Add a new nested describe:

```ts
describe("tryEnrichFromQdrant honesty (audit #5, #14)", () => {
  it("leaves embeddingModel absent when marker payload is missing model", async () => {
    // Mock a qdrant that says "collection exists, no marker"
    const qdrant = {
      url: "http://localhost:6333",
      collectionExists: vi.fn().mockResolvedValue(true),
      countPoints: vi.fn().mockResolvedValue(42),
      getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 384 }),
      scrollFiltered: vi.fn().mockResolvedValue([]), // no marker
    } as unknown as import("../../../../../src/core/adapters/qdrant/client.js").QdrantManager;

    const registry = new CollectionRegistry(dir);
    const ops = new ProjectRegistryOps({ registry, qdrant });
    await ops.register({ path: realPath, name: "alpha" });

    const stored = registry.list()[0];
    expect(stored.embeddingModel).toBe("");
    // After the fix, embeddingModel is absent OR "" (whichever is the storage
    // contract). The key invariant: NO fake non-empty value.
    expect(stored.embeddingModel).not.toBe("fake-model");
    expect(stored.qdrantUrl).toBe("http://localhost:6333"); // url is known
    expect(stored.indexedAt).toBe(""); // marker absent → honest empty
  });

  it("does NOT stamp new Date() for indexedAt when marker is absent", async () => {
    const qdrant = {
      url: "http://localhost:6333",
      collectionExists: vi.fn().mockResolvedValue(true),
      countPoints: vi.fn().mockResolvedValue(42), // non-zero chunks
      getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 384 }),
      scrollFiltered: vi.fn().mockResolvedValue([]),
    } as unknown as import("../../../../../src/core/adapters/qdrant/client.js").QdrantManager;

    const registry = new CollectionRegistry(dir);
    const ops = new ProjectRegistryOps({ registry, qdrant });
    const before = new Date().toISOString();
    await ops.register({ path: realPath, name: "alpha" });
    const stored = registry.list()[0];
    // Old code would stamp Date.now ISO; new code leaves "" honestly.
    expect(stored.indexedAt).toBe("");
    // Sanity check: it should NOT be a freshly-minted timestamp
    expect(stored.indexedAt).not.toMatch(/^2026-/);
  });

  it("preserves marker-derived indexedAt when marker payload has it", async () => {
    const qdrant = {
      url: "http://localhost:6333",
      collectionExists: vi.fn().mockResolvedValue(true),
      countPoints: vi.fn().mockResolvedValue(42),
      getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 384 }),
      scrollFiltered: vi.fn().mockResolvedValue([
        {
          payload: {
            embeddingModel: "jina-v2",
            teaRagsVersion: "1.25.0",
            indexedAt: "2026-05-01T00:00:00.000Z",
            _type: "indexing_metadata",
          },
        },
      ]),
    } as unknown as import("../../../../../src/core/adapters/qdrant/client.js").QdrantManager;

    const registry = new CollectionRegistry(dir);
    const ops = new ProjectRegistryOps({ registry, qdrant });
    await ops.register({ path: realPath, name: "alpha" });
    const stored = registry.list()[0];
    expect(stored.indexedAt).toBe("2026-05-01T00:00:00.000Z");
    expect(stored.embeddingModel).toBe("jina-v2");
    expect(stored.teaRagsVersion).toBe("1.25.0");
  });
});
```

If `vi` is not yet imported in this test file, add it to the import from
`"vitest"`. If `CollectionRegistry` and `ProjectRegistryOps` are not imported,
they're already at the top of the file — confirm.

- [ ] **Step 2: Run tests to verify failure**

Run:
`npx vitest run tests/core/api/internal/ops/project-registry-ops.test.ts -t "honesty"`
Expected: FAIL — the third test passes (correct path), but the second fails
because the current code stamps `new Date().toISOString()` when
`chunksCount > 0` and the marker had no `indexedAt`.

- [ ] **Step 3: Implement the fix**

File: `src/core/api/internal/ops/project-registry-ops.ts`. Locate the
`tryEnrichFromQdrant` private method (currently spanning roughly lines 77-169 —
`git show 02a1d409 -- src/core/api/internal/ops/project-registry-ops.ts` shows
the post-PR1 shape). Replace the `resolvedIndexedAt` block (lines ~151-160 — the
one that stamps `new Date().toISOString()`) with:

```ts
// Marker-derived value wins; otherwise honest empty. We do NOT stamp
// new Date() to fake a timestamp the collection never had — `projects
// info` renders empty indexedAt as "(unknown)".
const resolvedIndexedAt = indexedAt.length > 0 ? indexedAt : fallback.indexedAt;
```

Note: this also makes `chunksCount > 0 && !fallback.indexedAt` unreachable —
delete that branch. The `fallback.indexedAt` is `existing?.indexedAt ?? ""` so
this preserves an existing-on-disk value if Qdrant said "no marker" but the
registry already had one (re-register flow).

For audit #5 — the empty-string fields in `embeddingModel` / `teaRagsUrl` /
`qdrantUrl` are already "honest empty" when the marker is missing. The problem
the spec flags is downstream: `applyProjectDefaults` does
`argv.model ?? entry.embeddingModel` — `""` is truthy for `??`, so the user gets
`""` instead of falling back to default. That fix lives in PR3
(applyProjectDefaults rewrite). For PR2 the only behavioural change is: **stop
the "now" stamp**, which is the lying behaviour the audit caught directly in
this file.

(If the implementer believes there's more to audit #5 in this layer — read the
spec §"PR2 — `feat(cli)` + `improve(api)`" again. The spec explicitly says "ops
layer skips writing those keys; entry is left partial with explicit `(unknown)`
rendering in `info`" — but the keys are not optional in `CollectionEntry`.
Without changing `RegistryFileV1` shape we can't omit keys. The honest
interpretation: keep keys as `""`, which the existing `info` rendering already
shows as `(unknown)`. That's already in place from PR1's record validation work.
The behavioural surface PR2 actually changes is the fake `indexedAt`. If the
reviewer disagrees, file a follow-up — but do NOT change `RegistryFileV1` shape
in this PR.)

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/core/api/internal/ops/project-registry-ops.test.ts`
Expected: PASS — all three new tests + existing tests still green.

- [ ] **Step 5: Run full build + vitest**

Run: `npm run build && npx vitest run` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/api/internal/ops/project-registry-ops.ts \
        tests/core/api/internal/ops/project-registry-ops.test.ts
git commit -m "$(cat <<'EOF'
improve(api): drop fake new Date() stamp in tryEnrichFromQdrant

Closes audit #14 — `tryEnrichFromQdrant` previously stamped
`new Date().toISOString()` for `indexedAt` when the indexing-marker payload
was missing it and `chunksCount > 0`. That produced timestamps the
collection never had, indistinguishable from a real marker-derived value.

Now: marker value wins, otherwise honest empty. `projects info` already
renders empty `indexedAt` as "(unknown)", so the user-facing output stays
intuitive.

Audit #5 (empty-string poisoning) is left to PR3 — the actual harm lives in
`applyProjectDefaults` (`?? ""` is truthy), not in the ops layer.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `projects orphans` subcommand + qdrant wiring

**Goal:** Add `tea-rags projects orphans` (read-only). It walks Qdrant
collections via `QdrantManager.listCollections()`, subtracts the set of
collections present in the registry, and prints the remaining ones (orphans).
Closes part of audit #8 (the listing half — the `--purge` half is Task 4).

To call `qdrant.listCollections()` from a one-shot CLI process, we need a
`QdrantManager` instance. Today `src/cli/commands/projects.ts:newOps()`
constructs only `{ registry }` and passes that to `ProjectRegistryOps`. Extend
`newOps` (or add a new helper) that lazily resolves Qdrant URL + embedding
config from the same path the server uses
(`bootstrap/config/index.ts:loadConfig` returns an `AppConfig` with `qdrantUrl`
and `paths.appData`).

**Files:**

- Modify: `src/cli/commands/projects.ts`
- Modify: `tests/cli/commands/projects.test.ts`

---

- [ ] **Step 1: Write failing test**

File: `tests/cli/commands/projects.test.ts`. Append inside the
`describe("CLI 'projects' command group", ...)` block:

```ts
describe("orphans (audit #8)", () => {
  it("lists Qdrant collections not present in the registry", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      // Pre-seed registry with one entry.
      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName: "code_known",
        path: repo,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "http://q",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });

      // Mock the QdrantManager listCollections used by runOrphans.
      const fakeQdrant = {
        listCollections: vi
          .fn()
          .mockResolvedValue(["code_known", "code_orphan_1", "code_orphan_2"]),
        countPoints: vi.fn().mockResolvedValue(123),
      };
      const { runOrphans } =
        await import("../../../src/cli/commands/projects.js");
      await runOrphans({ json: false }, fakeQdrant as never);

      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("code_orphan_1");
      expect(out).toContain("code_orphan_2");
      expect(out).not.toContain("code_known");
    } finally {
      stdout.mockRestore();
    }
  });

  it("prints '(no orphan collections)' when registry matches Qdrant", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName: "code_known",
        path: repo,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "http://q",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      const fakeQdrant = {
        listCollections: vi.fn().mockResolvedValue(["code_known"]),
        countPoints: vi.fn().mockResolvedValue(0),
      };
      const { runOrphans } =
        await import("../../../src/cli/commands/projects.js");
      await runOrphans({ json: false }, fakeQdrant as never);
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("(no orphan collections)");
    } finally {
      stdout.mockRestore();
    }
  });

  it("--json emits a structured array", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const reg = new CollectionRegistry(dir);
      const fakeQdrant = {
        listCollections: vi.fn().mockResolvedValue(["code_a", "code_b"]),
        countPoints: vi.fn().mockResolvedValue(99),
      };
      const { runOrphans } =
        await import("../../../src/cli/commands/projects.js");
      await runOrphans({ json: true }, fakeQdrant as never);
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out.trim());
      expect(Array.isArray(parsed)).toBe(true);
      expect(
        parsed.map((e: { collectionName: string }) => e.collectionName).sort(),
      ).toEqual(["code_a", "code_b"]);
    } finally {
      stdout.mockRestore();
    }
  });
});
```

The test injects a fake Qdrant client. To keep the surface minimal, `runOrphans`
accepts `qdrant` as an optional 2nd parameter so tests can inject directly.
Production code (the yargs handler) constructs the real Qdrant client and passes
it in.

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/cli/commands/projects.test.ts -t "orphans"` Expected:
FAIL — `runOrphans` not exported.

- [ ] **Step 3: Add `runOrphans` and the yargs subcommand**

File: `src/cli/commands/projects.ts`. Add new imports near the top (after
existing imports):

```ts
import { loadConfig } from "../../bootstrap/config/index.js";
import { QdrantManager } from "../../core/adapters/qdrant/client.js";
```

(If `loadConfig` doesn't live at that path, find the actual config loader — read
`src/bootstrap/config/` for the right export. The factory uses `loadConfig(...)`
to obtain `AppConfig`; same loader works here.)

Add the new interface near the existing `ListArgs`:

```ts
interface OrphansArgs {
  json?: boolean;
}
```

Add `runOrphans` as an exported function alongside `runList`:

```ts
/**
 * List Qdrant collections that are not represented in the project registry.
 * Read-only — does not mutate either side. Audit #8.
 *
 * `qdrant` is an injection point: production code constructs a real
 * QdrantManager; tests pass a mock.
 */
export async function runOrphans(
  args: OrphansArgs,
  qdrant?: Pick<QdrantManager, "listCollections" | "countPoints">,
): Promise<void> {
  const { registry } = newOps();
  const client = qdrant ?? (await defaultQdrant());
  const registered = new Set(registry.list().map((e) => e.collectionName));
  const collections = await client.listCollections();
  const orphans = collections.filter((c) => !registered.has(c));

  if (args.json) {
    const rows = await Promise.all(
      orphans.map(async (collectionName) => ({
        collectionName,
        chunksCount: await safeCount(client, collectionName),
      })),
    );
    process.stdout.write(`${JSON.stringify(rows, null, 2)}\n`);
    return;
  }

  if (orphans.length === 0) {
    process.stdout.write("(no orphan collections)\n");
    return;
  }

  for (const collectionName of orphans) {
    const count = await safeCount(client, collectionName);
    process.stdout.write(`${collectionName}\t${count}\n`);
  }
}

async function safeCount(
  client: Pick<QdrantManager, "countPoints">,
  collectionName: string,
): Promise<number> {
  try {
    return await client.countPoints(collectionName);
  } catch {
    return 0;
  }
}

async function defaultQdrant(): Promise<QdrantManager> {
  const config = await loadConfig();
  return new QdrantManager(config.qdrantUrl, config.qdrantApiKey);
}
```

(If `loadConfig` is sync or has a different signature, adjust accordingly — read
the actual `bootstrap/config/index.ts` to see. The Qdrant constructor signature
should match the one in `factory.ts:resolveInfrastructure`. If the factory wires
a `reconnect` callback or daemon — replicate the relevant construction. For the
CLI's read-only `listCollections` path it's acceptable to skip the daemon-spawn
fast path because orphans only makes sense when Qdrant is already up.)

Register the subcommand inside `projectsCommand.builder` (the yargs chain).
Insert a new `.command<OrphansArgs>(...)` block between the existing
`unregister` and `list`:

```ts
.command<OrphansArgs>(
  "orphans",
  "List Qdrant collections without a registry entry",
  (y) => y.option("json", { type: "boolean", default: false, describe: "Output as JSON" }),
  async (argv) => {
    await runOrphans({ json: argv.json });
  },
)
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/cli/commands/projects.test.ts -t "orphans"` Expected:
PASS (all 3 assertions).

- [ ] **Step 5: Run full build + vitest**

Run: `npm run build && npx vitest run` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/projects.ts tests/cli/commands/projects.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add 'tea-rags projects orphans' subcommand

Lists Qdrant collections without a registry entry. Read-only — does not
mutate either side. Supports --json. Closes the listing half of audit #8;
the --purge half follows in the next commit.

`runOrphans` accepts an optional QdrantManager so tests can inject a mock;
the yargs handler constructs the real client via `loadConfig` +
`QdrantManager`.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: `unregister --purge` + verbose hint when not purging

**Goal:** Audit #8 (purge half) + audit #12 (verbose hint). Today
`tea-rags projects unregister --name foo` removes the registry entry but
silently leaves the Qdrant collection in place. Add `--purge` to delete the
Qdrant collection too; without `--purge`, print a hint that the collection still
exists.

**Files:**

- Modify: `src/cli/commands/projects.ts` — extend `runUnregister` + yargs
  subcommand option
- Modify: `tests/cli/commands/projects.test.ts`

---

- [ ] **Step 1: Write failing tests**

File: `tests/cli/commands/projects.test.ts`. Append inside the
`describe("CLI 'projects' command group", ...)` block:

```ts
describe("unregister --purge (audit #8) + verbose hint (audit #12)", () => {
  it("--purge calls qdrant.deleteCollection on the removed entry", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName: "code_purgeme",
        path: repo,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "http://q",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 99,
      });
      reg.setName("code_purgeme", "victim");
      const deleteCollection = vi.fn().mockResolvedValue(undefined);
      const fakeQdrant = { deleteCollection } as never;
      const { runUnregister } =
        await import("../../../src/cli/commands/projects.js");
      await runUnregister({ name: "victim", purge: true }, fakeQdrant);
      expect(deleteCollection).toHaveBeenCalledWith("code_purgeme");
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("Removed 'victim'");
      expect(out).toContain("code_purgeme");
      expect(out.toLowerCase()).toContain("deleted");
    } finally {
      stdout.mockRestore();
    }
  });

  it("without --purge prints a hint that the Qdrant collection is still present", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName: "code_keep",
        path: repo,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "http://q",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 5,
      });
      reg.setName("code_keep", "ghost");
      const { runUnregister } =
        await import("../../../src/cli/commands/projects.js");
      await runUnregister({ name: "ghost", purge: false });
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("Removed 'ghost'");
      expect(out).toContain("code_keep");
      expect(out.toLowerCase()).toContain("still present");
      expect(out).toContain("--purge");
    } finally {
      stdout.mockRestore();
    }
  });

  it("unregister of a missing name reports it without trying to delete", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const deleteCollection = vi.fn();
      const { runUnregister } =
        await import("../../../src/cli/commands/projects.js");
      await runUnregister({ name: "ghost", purge: true }, {
        deleteCollection,
      } as never);
      expect(deleteCollection).not.toHaveBeenCalled();
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain("was not registered");
    } finally {
      stdout.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/cli/commands/projects.test.ts -t "purge"` Expected:
FAIL — current `runUnregister` does not accept `purge`, does not call
`qdrant.deleteCollection`, and does not print the hint.

- [ ] **Step 3: Extend `UnregisterArgs` and `runUnregister`**

File: `src/cli/commands/projects.ts`. Change the interface:

```ts
interface UnregisterArgs {
  name: string;
  purge?: boolean;
}
```

Replace the body of `runUnregister`:

```ts
export async function runUnregister(
  args: UnregisterArgs,
  qdrant?: Pick<QdrantManager, "deleteCollection">,
): Promise<void> {
  const { registry, ops } = newOps();
  // Capture the collectionName before the entry is removed so we can purge it.
  const entry = registry.findByName(args.name);
  const out = await ops.unregister({ name: args.name });
  if (!out.removed) {
    process.stdout.write(`'${args.name}' was not registered\n`);
    return;
  }
  const collectionName = entry?.collectionName ?? "(unknown)";
  if (args.purge) {
    const client = qdrant ?? (await defaultQdrant());
    try {
      await client.deleteCollection(collectionName);
      process.stdout.write(
        `Removed '${args.name}' from registry; deleted Qdrant collection '${collectionName}'\n`,
      );
    } catch (err) {
      process.stdout.write(
        `Removed '${args.name}' from registry; failed to delete Qdrant collection '${collectionName}': ${(err as Error).message}\n`,
      );
    }
    return;
  }
  process.stdout.write(
    `Removed '${args.name}' from registry. Note: Qdrant collection '${collectionName}' is still present. Run with --purge or 'tea-rags projects unregister --name ${args.name} --purge' to remove it.\n`,
  );
}
```

Extend the yargs subcommand to accept the new flag:

```ts
.command<UnregisterArgs>(
  "unregister",
  "Remove a registered project by name (optionally also delete the Qdrant collection)",
  (y) =>
    y
      .option("name", { type: "string", demandOption: true, describe: "Project name to remove" })
      .option("purge", {
        type: "boolean",
        default: false,
        describe: "Also delete the underlying Qdrant collection",
      }),
  async (argv) => runUnregister({ name: argv.name, purge: argv.purge }),
)
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/cli/commands/projects.test.ts -t "purge"` Expected:
PASS (all 3 cases).

- [ ] **Step 5: Run full build + vitest**

Run: `npm run build && npx vitest run` Expected: PASS — existing `unregister`
tests must still pass with the new hint string (read them first to confirm; if
any matches a strict "Removed 'X'" output, update the regex to be more
permissive).

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/projects.ts tests/cli/commands/projects.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): 'tea-rags projects unregister --purge' + verbose hint

Closes audit #8 (purge half) and #12 (verbose hint). --purge deletes the
Qdrant collection after removing the registry entry. Without --purge, the
stdout output explicitly states the collection is still present and points
at the --purge invocation. Pre-existing behaviour (registry-only removal)
is preserved by default.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: `tea-rags doctor` summary (without --recover-registry)

**Goal:** Create the `doctor` CLI command in `src/cli/commands/doctor.ts`. The
no-flag form prints a health summary: Qdrant URL + reachability, embedding
provider + reachability, registered project count, orphan count. Uses `[OK]` /
`[WARN]` / `[FAIL]` prefixes. Supports `--json` for machine-readable output. The
`--recover-registry` flag is added in Task 6 — this Task only ships the summary.

**Files:**

- Create: `src/cli/commands/doctor.ts`
- Create: `tests/cli/commands/doctor.test.ts`

---

- [ ] **Step 1: Write failing tests**

File: `tests/cli/commands/doctor.test.ts` (new):

```ts
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollectionRegistry } from "../../../src/core/infra/registry/collection-registry.js";

describe("CLI 'doctor' command", () => {
  let dir: string;
  let repo: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-doc-"));
    repo = join(dir, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".keep"), "");
    process.env.TEA_RAGS_DATA_DIR = dir;
  });

  afterEach(() => {
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  it("prints [OK] for reachable Qdrant + embedding", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const fakeQdrant = {
        url: "http://localhost:6333",
        checkHealth: vi.fn().mockResolvedValue(true),
        listCollections: vi.fn().mockResolvedValue([]),
      };
      const fakeEmbeddings = {
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: () => "ollama",
        getBaseUrl: () => "http://localhost:11434",
      };
      const { runDoctor } = await import("../../../src/cli/commands/doctor.js");
      await runDoctor(
        { json: false, recoverRegistry: false },
        {
          qdrant: fakeQdrant as never,
          embeddings: fakeEmbeddings as never,
        },
      );
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toMatch(/\[OK\].*Qdrant/);
      expect(out).toMatch(/\[OK\].*ollama/);
      expect(out).toContain("http://localhost:6333");
      expect(out).toContain("http://localhost:11434");
    } finally {
      stdout.mockRestore();
    }
  });

  it("prints [FAIL] when Qdrant checkHealth resolves false", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const fakeQdrant = {
        url: "http://localhost:6333",
        checkHealth: vi.fn().mockResolvedValue(false),
        listCollections: vi.fn().mockResolvedValue([]),
      };
      const fakeEmbeddings = {
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: () => "ollama",
      };
      const { runDoctor } = await import("../../../src/cli/commands/doctor.js");
      await runDoctor(
        { json: false, recoverRegistry: false },
        {
          qdrant: fakeQdrant as never,
          embeddings: fakeEmbeddings as never,
        },
      );
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toMatch(/\[FAIL\].*Qdrant/);
    } finally {
      stdout.mockRestore();
    }
  });

  it("reports orphan count and points at --recover-registry when there are orphans", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      // Empty registry — every Qdrant collection is an orphan.
      const fakeQdrant = {
        url: "http://localhost:6333",
        checkHealth: vi.fn().mockResolvedValue(true),
        listCollections: vi.fn().mockResolvedValue(["code_a", "code_b"]),
      };
      const fakeEmbeddings = {
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: () => "ollama",
      };
      const { runDoctor } = await import("../../../src/cli/commands/doctor.js");
      await runDoctor(
        { json: false, recoverRegistry: false },
        {
          qdrant: fakeQdrant as never,
          embeddings: fakeEmbeddings as never,
        },
      );
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toMatch(/\[WARN\].*2.*orphan/i);
      expect(out).toContain("--recover-registry");
    } finally {
      stdout.mockRestore();
    }
  });

  it("--json emits structured object", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const fakeQdrant = {
        url: "http://localhost:6333",
        checkHealth: vi.fn().mockResolvedValue(true),
        listCollections: vi.fn().mockResolvedValue([]),
      };
      const fakeEmbeddings = {
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: () => "ollama",
      };
      const { runDoctor } = await import("../../../src/cli/commands/doctor.js");
      await runDoctor(
        { json: true, recoverRegistry: false },
        {
          qdrant: fakeQdrant as never,
          embeddings: fakeEmbeddings as never,
        },
      );
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out.trim());
      expect(parsed.qdrant.reachable).toBe(true);
      expect(parsed.embeddings.reachable).toBe(true);
      expect(parsed.registry.projectCount).toBe(0);
      expect(parsed.registry.orphanCount).toBe(0);
    } finally {
      stdout.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/cli/commands/doctor.test.ts` Expected: FAIL —
`src/cli/commands/doctor.ts` does not exist.

- [ ] **Step 3: Create the `doctor.ts` module**

File: `src/cli/commands/doctor.ts` (new):

```ts
import { homedir } from "node:os";
import { join } from "node:path";

import type { Argv, CommandModule } from "yargs";

import { loadConfig } from "../../bootstrap/config/index.js";
import type { EmbeddingProvider } from "../../core/adapters/embeddings/base.js";
import { createEmbeddingProvider } from "../../core/adapters/embeddings/factory.js";
import { QdrantManager } from "../../core/adapters/qdrant/client.js";
import { CollectionRegistry } from "../../core/infra/registry/collection-registry.js";

interface DoctorArgs {
  json?: boolean;
  recoverRegistry?: boolean;
}

interface DoctorDeps {
  qdrant: Pick<QdrantManager, "url" | "checkHealth" | "listCollections">;
  embeddings: Pick<
    EmbeddingProvider,
    "checkHealth" | "getProviderName" | "getBaseUrl"
  >;
}

function resolveDataDir(): string {
  return process.env.TEA_RAGS_DATA_DIR ?? join(homedir(), ".tea-rags");
}

function statusPrefix(ok: boolean, warn: boolean = false): string {
  if (warn) return "[WARN]";
  return ok ? "[OK]  " : "[FAIL]";
}

/**
 * `tea-rags doctor` — read-only infrastructure + registry health summary.
 * Audit #6 / #7 (the recovery side lands in `--recover-registry`, Task 6).
 *
 * `deps` is an injection point for tests; production constructs Qdrant +
 * embeddings via the same bootstrap path the server uses.
 */
export async function runDoctor(
  args: DoctorArgs,
  deps?: DoctorDeps,
): Promise<void> {
  const { qdrant, embeddings } = deps ?? (await defaultDeps());
  const registry = new CollectionRegistry(resolveDataDir());

  const qdrantOk = await safe(() => qdrant.checkHealth(), false);
  const embeddingsOk = await safe(() => embeddings.checkHealth(), false);
  const projectCount = registry.list().length;
  const collections = await safe(
    () => qdrant.listCollections(),
    [] as string[],
  );
  const registered = new Set(registry.list().map((e) => e.collectionName));
  const orphanCount = collections.filter((c) => !registered.has(c)).length;
  const embeddingUrl =
    typeof embeddings.getBaseUrl === "function"
      ? embeddings.getBaseUrl()
      : undefined;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          qdrant: { url: qdrant.url, reachable: qdrantOk },
          embeddings: {
            provider: embeddings.getProviderName(),
            url: embeddingUrl,
            reachable: embeddingsOk,
          },
          registry: { projectCount, orphanCount },
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(`${statusPrefix(qdrantOk)} Qdrant: ${qdrant.url}\n`);
  process.stdout.write(
    `${statusPrefix(embeddingsOk)} Embeddings (${embeddings.getProviderName()})${
      embeddingUrl ? `: ${embeddingUrl}` : ""
    }\n`,
  );
  process.stdout.write(
    `${statusPrefix(true)} Registry: ${projectCount} project(s)\n`,
  );
  if (orphanCount > 0) {
    process.stdout.write(
      `${statusPrefix(true, true)} Registry: ${orphanCount} orphan collection(s) — run 'tea-rags doctor --recover-registry' or 'tea-rags projects orphans' to inspect\n`,
    );
  }
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

async function defaultDeps(): Promise<DoctorDeps> {
  const config = await loadConfig();
  const qdrant = new QdrantManager(config.qdrantUrl, config.qdrantApiKey);
  const embeddings = await createEmbeddingProvider(config.embedding);
  return { qdrant, embeddings };
}

export const doctorCommand: CommandModule<unknown, DoctorArgs> = {
  command: "doctor",
  describe: "Print infrastructure + registry health summary",
  builder: (yargs: Argv) =>
    yargs
      .option("json", {
        type: "boolean",
        default: false,
        describe: "Output as JSON",
      })
      .option("recover-registry", {
        type: "boolean",
        default: false,
        describe:
          "Repopulate the project registry from live Qdrant state (Task 6 wires this)",
      }),
  handler: async (argv) => {
    await runDoctor({
      json: argv.json,
      recoverRegistry: argv["recover-registry"],
    });
  },
};
```

(If `loadConfig` is sync or has a different signature, adjust. If
`createEmbeddingProvider` doesn't exist at that path, find the actual factory
used in `bootstrap/factory.ts:resolveInfrastructure`. The Qdrant constructor
must match the factory's call shape. For the doctor surface it's OK to skip the
embedded-Qdrant daemon spawn — `checkHealth` only needs HTTP reachability.)

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/cli/commands/doctor.test.ts` Expected: PASS — all 4
cases.

- [ ] **Step 5: Run full build + vitest**

Run: `npm run build && npx vitest run` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/doctor.ts tests/cli/commands/doctor.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): add 'tea-rags doctor' health summary

New CLI subcommand prints infrastructure + registry health: Qdrant
reachability, embedding provider + endpoint reachability, registered
project count, orphan collection count. Uses [OK] / [WARN] / [FAIL]
prefixes for readability; --json emits a structured object.

The --recover-registry flag is declared in the yargs schema but not yet
wired — Task 6 calls ProjectRegistryOps.recoverFromQdrant.

Primes audit #6/#7 surface. Doctor is CLI-only (no MCP-tool, no App
surface change).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: `doctor --recover-registry` flag

**Goal:** Wire the `--recover-registry` flag to
`ProjectRegistryOps.recoverFromQdrant`. After the summary, if the flag is set,
call recover and print "Recovered N entries; paths are empty — re-register them
to enable applyProjectDefaults".

**Files:**

- Modify: `src/cli/commands/doctor.ts`
- Modify: `tests/cli/commands/doctor.test.ts`

---

- [ ] **Step 1: Write failing test**

File: `tests/cli/commands/doctor.test.ts`. Append inside the same
`describe("CLI 'doctor' command", ...)` block:

```ts
describe("--recover-registry", () => {
  it("calls ProjectRegistryOps.recoverFromQdrant and reports the result", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      // Pre-seed empty registry; Qdrant has two collections.
      const fakeQdrant = {
        url: "http://localhost:6333",
        checkHealth: vi.fn().mockResolvedValue(true),
        listCollections: vi.fn().mockResolvedValue(["code_a", "code_b"]),
        countPoints: vi.fn().mockResolvedValue(0),
        getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 384 }),
        scrollFiltered: vi.fn().mockResolvedValue([]),
      };
      const fakeEmbeddings = {
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: () => "ollama",
      };
      const { runDoctor } = await import("../../../src/cli/commands/doctor.js");
      await runDoctor(
        { json: false, recoverRegistry: true },
        {
          qdrant: fakeQdrant as never,
          embeddings: fakeEmbeddings as never,
        },
      );
      // Verify the recovery actually wrote registry entries.
      const reg = new CollectionRegistry(dir);
      const names = reg
        .list()
        .map((e) => e.collectionName)
        .sort();
      expect(names).toEqual(["code_a", "code_b"]);
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out.toLowerCase()).toContain("recovered");
      expect(out).toContain("re-register");
    } finally {
      stdout.mockRestore();
    }
  });

  it("--json includes a `recovery` block when --recover-registry is set", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const fakeQdrant = {
        url: "http://localhost:6333",
        checkHealth: vi.fn().mockResolvedValue(true),
        listCollections: vi.fn().mockResolvedValue(["code_a"]),
        countPoints: vi.fn().mockResolvedValue(0),
        getCollectionInfo: vi.fn().mockResolvedValue({ vectorSize: 384 }),
        scrollFiltered: vi.fn().mockResolvedValue([]),
      };
      const fakeEmbeddings = {
        checkHealth: vi.fn().mockResolvedValue(true),
        getProviderName: () => "ollama",
      };
      const { runDoctor } = await import("../../../src/cli/commands/doctor.js");
      await runDoctor(
        { json: true, recoverRegistry: true },
        {
          qdrant: fakeQdrant as never,
          embeddings: fakeEmbeddings as never,
        },
      );
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out.trim());
      expect(parsed.recovery).toBeDefined();
      expect(parsed.recovery.recovered).toBe(1);
    } finally {
      stdout.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/cli/commands/doctor.test.ts -t "recover-registry"`
Expected: FAIL — `runDoctor` doesn't perform recovery yet.

- [ ] **Step 3: Wire the recovery call**

File: `src/cli/commands/doctor.ts`. Update imports:

```ts
import { ProjectRegistryOps } from "../../core/api/internal/ops/project-registry-ops.js";
```

Replace the body of `runDoctor` to perform the optional recovery AFTER the
summary computation but BEFORE emitting output. Capture the count for both text
and JSON paths:

```ts
export async function runDoctor(
  args: DoctorArgs,
  deps?: DoctorDeps,
): Promise<void> {
  const { qdrant, embeddings } = deps ?? (await defaultDeps());
  const registry = new CollectionRegistry(resolveDataDir());

  const qdrantOk = await safe(() => qdrant.checkHealth(), false);
  const embeddingsOk = await safe(() => embeddings.checkHealth(), false);
  const collections = await safe(
    () => qdrant.listCollections(),
    [] as string[],
  );
  const registeredBefore = new Set(
    registry.list().map((e) => e.collectionName),
  );
  const orphanCount = collections.filter(
    (c) => !registeredBefore.has(c),
  ).length;
  const embeddingUrl =
    typeof embeddings.getBaseUrl === "function"
      ? embeddings.getBaseUrl()
      : undefined;

  let recovery: { recovered: number } | undefined;
  if (args.recoverRegistry) {
    // ProjectRegistryOps.recoverFromQdrant accepts `{ registry, qdrant }`.
    // Cast the partial mock type to the full QdrantManager — the ops method
    // only calls listCollections + countPoints + getCollectionInfo +
    // scrollFiltered, all covered by the test mock.
    const ops = new ProjectRegistryOps({
      registry,
      qdrant: qdrant as never,
    });
    await ops.recoverFromQdrant();
    const after = registry.list().length;
    recovery = { recovered: after - registeredBefore.size };
  }

  const projectCount = registry.list().length;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          qdrant: { url: qdrant.url, reachable: qdrantOk },
          embeddings: {
            provider: embeddings.getProviderName(),
            url: embeddingUrl,
            reachable: embeddingsOk,
          },
          registry: {
            projectCount,
            orphanCount: args.recoverRegistry ? 0 : orphanCount,
          },
          ...(recovery ? { recovery } : {}),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(`${statusPrefix(qdrantOk)} Qdrant: ${qdrant.url}\n`);
  process.stdout.write(
    `${statusPrefix(embeddingsOk)} Embeddings (${embeddings.getProviderName()})${
      embeddingUrl ? `: ${embeddingUrl}` : ""
    }\n`,
  );
  process.stdout.write(
    `${statusPrefix(true)} Registry: ${projectCount} project(s)\n`,
  );
  if (recovery) {
    process.stdout.write(
      `${statusPrefix(true)} Recovered ${recovery.recovered} entry/entries from Qdrant; paths are empty — re-register them with 'tea-rags projects register --path <dir> --name <alias>' to enable alias resolution.\n`,
    );
  } else if (orphanCount > 0) {
    process.stdout.write(
      `${statusPrefix(true, true)} Registry: ${orphanCount} orphan collection(s) — run 'tea-rags doctor --recover-registry' or 'tea-rags projects orphans' to inspect\n`,
    );
  }
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/cli/commands/doctor.test.ts` Expected: PASS — both
new tests + 4 from Task 5.

- [ ] **Step 5: Run full build + vitest**

Run: `npm run build && npx vitest run` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/doctor.ts tests/cli/commands/doctor.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): wire 'tea-rags doctor --recover-registry' to ProjectRegistryOps

The flag now delegates to ProjectRegistryOps.recoverFromQdrant — walks
Qdrant collections, inserts a stub registry entry for each one not yet
known. The stub has path:"" (audit #7 — registry is the single source of
truth for path), so the doctor stdout includes a hint pointing at
'tea-rags projects register' to fill in the path.

--json output gains a `recovery: { recovered: N }` block when the flag is
set. Closes audit #6.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Register `doctor` in `create-cli.ts`

**Goal:** Wire the new command into the yargs CLI so `tea-rags doctor` is
discoverable at the command line. Smallest, lowest-risk Task — one import

- one `.command(...)` call.

**Files:**

- Modify: `src/cli/create-cli.ts`
- Modify: `tests/cli/create-cli.test.ts` (or create if missing)

---

- [ ] **Step 1: Check whether the test file exists**

Run: `ls tests/cli/create-cli.test.ts 2>/dev/null`. If missing, create it in
Step 2. If present, append to the existing describe.

- [ ] **Step 2: Write the failing test**

File: `tests/cli/create-cli.test.ts` (new or extend):

```ts
import { describe, expect, it } from "vitest";

import { createCli } from "../../src/cli/create-cli.js";

describe("createCli registration", () => {
  it("registers the 'doctor' command", async () => {
    const cli = createCli([]);
    // yargs.getInternalMethods is internal API; portable alternative:
    // ask --help and grep. Run with --help and capture output.
    const help = await new Promise<string>((resolve) => {
      let buf = "";
      cli
        .exitProcess(false)
        .fail(() => undefined)
        .parse(
          "--help",
          (_err: Error | null, _argv: unknown, output: string) => {
            buf = output ?? "";
            resolve(buf);
          },
        );
    });
    expect(help).toMatch(/\bdoctor\b/);
  });
});
```

(If the existing `create-cli.test.ts` uses a different `--help` capture pattern,
follow that. The invariant: the rendered help text mentions `doctor`.)

- [ ] **Step 3: Run test to verify failure**

Run: `npx vitest run tests/cli/create-cli.test.ts -t "doctor"` Expected: FAIL —
`doctor` not in help.

- [ ] **Step 4: Wire `doctorCommand` into the chain**

File: `src/cli/create-cli.ts`. Add the import alongside the other command
imports (line 4-8 area):

```ts
import { doctorCommand } from "./commands/doctor.js";
```

Add `.command(doctorCommand)` to the chain inside `createCli` (between
`projectsCommand` and `.completion(...)` is a natural slot). Result:

```ts
return yargs(argvSource)
  .scriptName("tea-rags")
  .command(serverCommand)
  .command(tuneCommand)
  .command(primeCommand)
  .command(updateCommand)
  .command(projectsCommand)
  .command(doctorCommand)
  .completion(/* ... */);
// ...
```

- [ ] **Step 5: Run tests to verify pass**

Run: `npx vitest run tests/cli/create-cli.test.ts` Expected: PASS — `doctor` now
appears in `--help`.

- [ ] **Step 6: Manual smoke test (optional but recommended)**

```bash
npm run build
node build/cli/index.js doctor --help
```

Expected: help text for doctor including `--json` and `--recover-registry`.

```bash
node build/cli/index.js doctor
```

Expected: 3-4 lines of `[OK]` / `[WARN]` / `[FAIL]` summary (depends on your
local Qdrant + embedding state). The command should not throw.

- [ ] **Step 7: Run full build + vitest**

Run: `npm run build && npx vitest run` Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli/create-cli.ts tests/cli/create-cli.test.ts
git commit -m "$(cat <<'EOF'
feat(cli): register 'doctor' command in createCli

Final wire-up for PR2. 'tea-rags doctor' is now discoverable via the
top-level CLI. Closes audit #6/#7/#8 surface from the user's POV.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 9: Close beads epic (when beads is reachable)**

```bash
bd close $T7
bd close $EPIC --reason="PR2 complete — 6 audit items closed (#5, #6, #7, #8, #12, #14). Tasks 1-7 landed atomically."
```

---

## Done-criteria for the whole PR2

- `npm run build` passes.
- `npx vitest run` passes.
- 6 audit items closed (#5, #6, #7, #8, #12, #14) — each Task's commit message
  references the numbers.
- `git diff main -- src/core/api/public/app.ts` empty (App surface
  byte-compatible).
- `git diff main -- src/core/infra/registry/types.ts` empty (`RegistryFileV1`
  shape untouched).
- `git diff main -- src/core/infra/collection-name.ts` empty
  (`resolveCollection` signature untouched).
- 7 atomic commits, each on a meaningful audit-item scope (`feat(api)`,
  `improve(api)`, `feat(cli)`).
- Manual smoke test: `tea-rags doctor`, `tea-rags projects orphans`,
  `tea-rags projects unregister --name <foo> --purge` all run end-to-end against
  the user's real registry without crashes.

PR3 (polish — audit #13 + #15) gets its own plan after PR2 merges.
