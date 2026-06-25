# `index-codebase --name <alias>` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. When executing, use
> **dinopowers:executing-plans** (not raw superpowers:executing-plans) per
> project routing.

**Goal:** Add a `--name <alias>` flag to `tea-rags index-codebase` that
registers the resolved path under `<alias>` in the collection-registry
**before** forking the indexing worker, so a new project gets its alias at first
index in one command.

**Architecture:** Insert a registration step into the existing
`indexCodebaseCommand` handler, reusing `ProjectRegistryOps.register` (the same
unit `tea-rags projects register` uses). Registration runs after env resolution
and before `forkWorker`; a typed-error renders (text or JSON) and exits before
any worker spawns. `--name` is mutually exclusive with `--project` (write-mode
vs read-mode). Then update the `tea-rags:index` skill (primary consumer) and
`test-self-reindex` skill to use the single command, and annotate the
`worktree create` hint.

**Tech Stack:** TypeScript, yargs (CLI), vitest (tests), `ProjectRegistryOps` +
`CollectionRegistry` from `core/api/public`.

## Global Constraints

- **Consumer-surface rule:** `cli/` imports `core` ONLY through
  `core/api/public/index.js`. `ProjectRegistryOps`, `CollectionRegistry`,
  `InputValidationError` are all re-exported there — import from that barrel,
  never from `api/internal`.
- **Reuse, do not duplicate:** registration logic stays in
  `ProjectRegistryOps.register`. Call it directly; do NOT call `runRegister` (it
  does `process.exit(1)` + plain stderr, which breaks `--json`). Do NOT add name
  validation in the CLI — `register` enforces `PROJECT_NAME_RE`, length, and
  path existence.
- **Typed errors:** registration throws `InputValidationError` subclasses
  (`ProjectNameInvalidError`, `ProjectNameNotUniqueError`,
  `PathDoesNotExistError`). Each carries `.code` (an `InputErrorCode`) and
  `.message`. Non-`InputValidationError` throws must propagate (programming
  errors).
- **Handler ordering is load-bearing:** resolve `registryEnv` (via
  `pickRegistryEntry`) BEFORE register, else the fresh stub entry (chunksCount
  0, empty embedding config) shadows the most-recently-indexed embedding
  fallback for a brand-new project.
- **Deep-silo note:** `project-registry-ops.ts` and `api/errors.ts` are
  deep-silo, but this plan does NOT modify them (consumed read-only) — no
  silo-pairing `Why:` line needed. `index-codebase.ts` is not deep-silo.
- **Test golden rule:** do not rewrite existing passing tests. New tests go in a
  new file `tests/cli/commands/index-codebase-name-flag.test.ts`.
- **Plugin versioning:** editing `.claude-plugin/tea-rags/skills/index/SKILL.md`
  requires a **patch** bump of
  `.claude-plugin/tea-rags/.claude-plugin/plugin.json`.
  `.claude/skills/test-self-reindex/SKILL.md` is project-local — no plugin bump.
- **Commit scope:** `feat(api)` → minor (additive, no BREAKING). Test-only
  commits use `test(...)`; skill/doc commits use `docs(...)` or `improve(dx)`.
- **Worktree base:** this branch is rebased onto local `main` (worktree CLI
  present). Build/link/reindex are user-gated — do NOT run them as part of
  execution; stop at green `npx vitest run`.

---

### Task 1: `--name` flag + register-before-fork (happy path) + `--project` conflict

**Files:**

- Modify: `src/cli/commands/index-codebase.ts` (interface, builder, handler)
- Test: `tests/cli/commands/index-codebase-name-flag.test.ts` (new)

**Interfaces:**

- Consumes: `ProjectRegistryOps`
  (`new ProjectRegistryOps({ registry }).register({ path, name }): Promise<{ collectionName; alreadyIndexed }>`),
  `CollectionRegistry` (already imported).
- Produces: a `--name` CLI option; handler that registers `path → name` before
  `forkWorker` and sets `projectName` from `argv.name`.

- [ ] **Step 1: Write the failing test file**

Create `tests/cli/commands/index-codebase-name-flag.test.ts`:

```typescript
import { fork } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { indexCodebaseCommand } from "../../../src/cli/commands/index-codebase.js";
import { createCli } from "../../../src/cli/create-cli.js";
import { CollectionRegistry } from "../../../src/core/api/public/index.js";

// Worker fork + supervisor are stubbed so no real child process spawns.
vi.mock("node:child_process", () => ({ fork: vi.fn(() => ({})) }));
vi.mock("../../../src/cli/index-progress/supervisor.js", () => ({
  superviseIndexing: vi.fn(async () => 0),
}));

class ExitError extends Error {
  constructor(public readonly code?: number) {
    super(`process.exit(${code})`);
  }
}

type Handler = (argv: Record<string, unknown>) => Promise<void>;
const runHandler: Handler = (argv) =>
  (indexCodebaseCommand.handler as Handler)({
    force: false,
    json: false,
    "wait-enrichments": false,
    ...argv,
  });

describe("index-codebase --name", () => {
  let dataDir: string;
  let projPath: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "name-flag-data-"));
    projPath = mkdtempSync(join(tmpdir(), "name-flag-proj-"));
    process.env.TEA_RAGS_DATA_DIR = dataDir;
    vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
      throw new ExitError(c);
    }) as never);
    vi.mocked(fork).mockImplementation((() => ({})) as never);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(projPath, { recursive: true, force: true });
    delete process.env.TEA_RAGS_DATA_DIR;
    vi.restoreAllMocks();
    vi.mocked(fork).mockReset();
  });

  it("registers the alias in the registry BEFORE forking the worker", async () => {
    let nameAtForkTime: string | null = null;
    vi.mocked(fork).mockImplementation((() => {
      nameAtForkTime =
        new CollectionRegistry(dataDir).findByName("alpha")?.name ?? null;
      return {};
    }) as never);

    await expect(
      runHandler({ name: "alpha", path: projPath }),
    ).rejects.toBeInstanceOf(ExitError);

    expect(nameAtForkTime).toBe("alpha"); // registered before fork ran
    expect(vi.mocked(fork)).toHaveBeenCalledOnce();
    expect(new CollectionRegistry(dataDir).findByName("alpha")?.path).toBe(
      realpathSync(projPath),
    );
  });

  it("re-running --name on the same indexed path succeeds and still indexes", async () => {
    await expect(
      runHandler({ name: "alpha", path: projPath }),
    ).rejects.toBeInstanceOf(ExitError);
    vi.mocked(fork).mockClear();
    await expect(
      runHandler({ name: "alpha", path: projPath }),
    ).rejects.toBeInstanceOf(ExitError);
    expect(vi.mocked(fork)).toHaveBeenCalledOnce();
    expect(new CollectionRegistry(dataDir).findByName("alpha")).not.toBeNull();
  });

  it("rejects --name together with --project (mutually exclusive)", async () => {
    const failMsg = await new Promise<string>((resolve) => {
      createCli([])
        .exitProcess(false)
        .fail((msg: string) => resolve(msg))
        .parse(
          `index-codebase ${projPath} --name a --project b`,
          () => undefined,
        );
    });
    expect(failMsg).toMatch(/mutually exclusive/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/cli/commands/index-codebase-name-flag.test.ts`
Expected: FAIL — `--name` is unknown (registry has no entry; conflict not
enforced).

- [ ] **Step 3: Add `name` to `IndexCodebaseArgs` and import
      `ProjectRegistryOps`**

In `src/cli/commands/index-codebase.ts`, change the public-barrel import (line
7):

```typescript
import {
  CollectionRegistry,
  ProjectRegistryOps,
  type IndexOptions,
} from "../../core/api/public/index.js";
```

Add `name` to the interface (after `project?: string;`):

```typescript
export interface IndexCodebaseArgs {
  path?: string;
  project?: string;
  /** Register the resolved path under this alias before indexing (first index of a new project). */
  name?: string;
  "wait-enrichments"?: boolean;
  force?: boolean;
  json?: boolean;
  /** Hidden: marks the forked child as the detached indexing worker. */
  __worker?: boolean;
}
```

- [ ] **Step 4: Add the `--name` option + `.conflicts` to the builder**

In the `builder` chain, insert the `name` option after the `project` option and
add `.conflicts`:

```typescript
      .option("project", {
        type: "string",
        describe: "Project alias from the registry. Resolves --path from the registered entry.",
      })
      .option("name", {
        type: "string",
        describe:
          "Register the path under <alias> in the project registry, then index. Use for the first index of a new project.",
      })
      .conflicts("name", "project")
```

- [ ] **Step 5: Insert the register step + set `projectName` from `argv.name`**

In the handler, after `const registryEnv = ...` and before the `projectName`
line, insert the register block. Then change `projectName` to prefer
`argv.name`:

```typescript
const registryEnv = resolveRegistryEnv(
  pickRegistryEntry(registry, { project: argv.project, path }),
);

// --name: register this path under the alias BEFORE indexing so a new
// project gets its alias in one command. Env is already resolved above, so
// the fresh stub entry does not shadow the most-recently-indexed embedding
// fallback. No qdrant in deps — the collection does not exist yet.
if (argv.name) {
  await new ProjectRegistryOps({ registry }).register({
    path,
    name: argv.name,
  });
}

// Resolve the registered project alias for the status block.
const projectName =
  argv.name ?? argv.project ?? resolveProjectName(registry, path) ?? undefined;
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/cli/commands/index-codebase-name-flag.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Run typecheck + full CLI test suite**

Run: `npx tsc --noEmit && npx vitest run tests/cli/commands/` Expected: PASS, no
type errors.

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/index-codebase.ts tests/cli/commands/index-codebase-name-flag.test.ts
git commit -m "feat(api): add index-codebase --name to register alias before indexing

--name <alias> registers the resolved path via ProjectRegistryOps.register
before forking the worker, so a new project is aliased at first index.
Mutually exclusive with --project (write vs read mode)."
```

---

### Task 2: Register error handling — typed-error abort + text/JSON UX

**Files:**

- Modify: `src/cli/commands/index-codebase.ts` (wrap register in try/catch, add
  `renderRegisterError`)
- Test: `tests/cli/commands/index-codebase-name-flag.test.ts` (append two tests)

**Interfaces:**

- Consumes: `InputValidationError` (`.code`, `.message`) from `core/api/public`,
  `Colorizer` from `../infra/color.js`.
- Produces: `renderRegisterError(err, { json, colors })` — renders a typed
  register error (text via `colors.alert`, JSON as
  `{ error: { code, message } }`) and lets the handler exit; rethrows non-typed
  errors.

- [ ] **Step 1: Append the failing tests**

Append to `tests/cli/commands/index-codebase-name-flag.test.ts`, inside the
`describe` block:

```typescript
it("aborts before forking when the alias is invalid (exit 1, no worker)", async () => {
  const err = await runHandler({ name: "Bad Name", path: projPath }).catch(
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ExitError);
  expect((err as ExitError).code).toBe(1);
  expect(vi.mocked(fork)).not.toHaveBeenCalled();
});

it("emits a parseable {error} object in --json mode on register failure", async () => {
  const out: string[] = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((s: string) => {
    out.push(String(s));
    return true;
  }) as never);

  await runHandler({ name: "Bad Name", path: projPath, json: true }).catch(
    () => undefined,
  );

  const parsed = JSON.parse(out.join("")) as {
    error: { code: string; message: string };
  };
  expect(parsed.error.code).toBe("INPUT_PROJECT_NAME_INVALID");
  expect(parsed.error.message).toMatch(/invalid/i);
  expect(vi.mocked(fork)).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run:
`npx vitest run tests/cli/commands/index-codebase-name-flag.test.ts -t "register failure" -t "aborts before forking"`
Expected: FAIL — without try/catch, the thrown `ProjectNameInvalidError`
propagates as a raw rejection (not an `ExitError`), and no `{error}` JSON is
written.

- [ ] **Step 3: Add the error imports**

In `src/cli/commands/index-codebase.ts`, extend the two imports:

```typescript
import {
  CollectionRegistry,
  InputValidationError,
  ProjectRegistryOps,
  type IndexOptions,
} from "../../core/api/public/index.js";
import { createColorizer, type Colorizer } from "../infra/color.js";
```

- [ ] **Step 4: Add the `renderRegisterError` helper**

Add this module-level function (near `resolveProjectName`):

```typescript
/**
 * Render a typed registration failure and let the handler exit(1) before any
 * worker is forked. JSON mode emits a parseable { error } object on stdout;
 * text mode writes a colorized one-liner to stderr. Non-typed errors (program
 * bugs) propagate unchanged.
 */
function renderRegisterError(
  err: unknown,
  opts: { json: boolean; colors: Colorizer },
): void {
  if (!(err instanceof InputValidationError)) throw err;
  if (opts.json) {
    process.stdout.write(
      `${JSON.stringify({ error: { code: err.code, message: err.message } })}\n`,
    );
  } else {
    process.stderr.write(
      `${opts.colors.alert(`index-codebase: ${err.message}`)}\n`,
    );
  }
}
```

- [ ] **Step 5: Move `colors` above the register block and wrap register in
      try/catch**

The `colors` colorizer is currently built after `projectName`; move its
construction up so the register error can use it. Update the handler region to:

```typescript
const registryEnv = resolveRegistryEnv(
  pickRegistryEntry(registry, { project: argv.project, path }),
);

// JSON mode forces NO_COLOR semantics so the output is clean for parsing.
const colors = createColorizer(
  jsonMode ? { env: { NO_COLOR: "1" }, isTTY: false } : undefined,
);

// --name: register this path under the alias BEFORE indexing so a new
// project gets its alias in one command. Env is already resolved above, so
// the fresh stub entry does not shadow the most-recently-indexed embedding
// fallback. No qdrant in deps — the collection does not exist yet. A typed
// failure renders and exits before any worker is forked.
if (argv.name) {
  try {
    await new ProjectRegistryOps({ registry }).register({
      path,
      name: argv.name,
    });
  } catch (err) {
    renderRegisterError(err, { json: jsonMode, colors });
    process.exit(1);
  }
}

// Resolve the registered project alias for the status block.
const projectName =
  argv.name ?? argv.project ?? resolveProjectName(registry, path) ?? undefined;

const renderer = createRenderer({
  isTTY: Boolean(process.stderr.isTTY),
  colors,
  json: jsonMode,
});
```

Delete the now-duplicate `const colors = createColorizer(...)` line that
previously sat just above `createRenderer` (there must be exactly one `colors`
declaration).

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/cli/commands/index-codebase-name-flag.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Run typecheck + full CLI suite**

Run: `npx tsc --noEmit && npx vitest run tests/cli/commands/` Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/cli/commands/index-codebase.ts tests/cli/commands/index-codebase-name-flag.test.ts
git commit -m "feat(api): render index-codebase --name register errors (text/JSON), abort before fork

Typed InputValidationError from register is caught: --json emits a parseable
{error:{code,message}}, text mode a colorized stderr line; process.exit(1)
before any worker is forked. Non-typed errors propagate."
```

---

### Task 3: Wire the `tea-rags:index` skill to use `--name` for first index (primary)

**Files:**

- Modify: `.claude-plugin/tea-rags/skills/index/SKILL.md`
- Modify: `.claude-plugin/tea-rags/.claude-plugin/plugin.json` (patch bump)

**Interfaces:**

- Consumes: the new `tea-rags index-codebase <path> --name <alias>` command
  (Tasks 1–2).
- Produces: skill guidance that registers inline at first index.

- [ ] **Step 1: Replace the index-then-register-after flow**

In `.claude-plugin/tea-rags/skills/index/SKILL.md`, replace steps 2–4 (the
`mcp__tea-rags__index_codebase` call followed by the post-index registration
prompt) so that a **not-yet-registered** path is indexed with `--name` in one
command. Replace the body of `## Instructions` steps 2–4 with:

```markdown
2. Decide whether the path is already registered: call
   `mcp__tea-rags__list_projects` and look for an entry whose `path` matches the
   target path AND whose `name` is non-empty.

3. **Not registered yet (first index):** derive a default alias from the path —
   the final non-empty segment, lowercased, non-alphanumerics replaced by `-`,
   prefixed with `p-` if it would start with a digit; the regex
   `^[a-z0-9][a-z0-9_-]{0,63}$` MUST match (e.g. `/Users/me/Dev/Tea-RAGs MCP` →
   `tea-rags-mcp`). Present it and ask once: "Index and register this codebase
   as project `<alias>`? (recommended — lets MCP tools address it by name.)"
   Offer to override the alias. On confirmation, run the CLI in one step:

   `tea-rags index-codebase <path> --name <alias>`

   This registers the alias and indexes in a single command. If
   `[INPUT_PROJECT_NAME_NOT_UNIQUE]` is returned, suggest a numeric suffix
   (`<alias>-2`) and retry once. On decline, index without an alias via
   `mcp__tea-rags__index_codebase` (`path`) — the user can register later.

4. **Already registered:** incremental reindex via
   `mcp__tea-rags__index_codebase` with `project: <alias>` (or `path`). Do NOT
   re-register — the alias already exists.
```

Also update the frontmatter `description` line and the `## Do NOT` bullet that
says "Skip the registration prompt on first-time indexing" to reflect that
registration now happens **inline via `--name`**, not as a separate post-index
step. Keep the rest of `## Do NOT` intact.

- [ ] **Step 2: Patch-bump the tea-rags plugin version**

Edit `.claude-plugin/tea-rags/.claude-plugin/plugin.json`: increment the
`version` patch component (e.g. `0.X.Y` → `0.X.(Y+1)`).

Run: `git diff --cached --name-only | grep '^\.claude-plugin/tea-rags/'` (after
staging) to confirm the bump is needed.

- [ ] **Step 3: Verify the skill reads coherently**

Read the edited `SKILL.md` end-to-end. Confirm: first-index path uses `--name`;
already-registered path uses incremental reindex; no contradictory "register
after" instruction remains.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/tea-rags/skills/index/SKILL.md .claude-plugin/tea-rags/.claude-plugin/plugin.json
git commit -m "improve(dx): tea-rags:index registers alias inline via index-codebase --name

First index of a new project now runs 'index-codebase <path> --name <alias>'
in one step instead of indexing then offering register_project after."
```

---

### Task 4: Collapse `test-self-reindex` to a single CLI command (secondary)

**Files:**

- Modify: `.claude/skills/test-self-reindex/SKILL.md`

**Interfaces:**

- Consumes:
  `tea-rags index-codebase <path> --name tea-rags-worktree --force --wait-enrichments --json`.
- Produces: a one-command register+reindex step replacing the two MCP calls.

- [ ] **Step 1: Replace Steps 2–3 (register_project + index_codebase) with one
      CLI call**

In `.claude/skills/test-self-reindex/SKILL.md`, replace the "Step 2 — Register
the worktree" and "Step 3 — Force reindex via the alias" sections with a single
step that runs the CLI. New combined step:

````markdown
### Step 2 — Register + force-reindex in one CLI command

`--name tea-rags-worktree` registers the worktree path under the static alias
(alias-rename semantics: a stale prior path is RE-POINTED, preserving the Qdrant
collection / snapshot / codegraph DB — no data dropped, no forced reindex from a
rename) and then indexes, all in one command. `--force` rebuilds from scratch;
`--wait-enrichments` stays attached until every provider finishes; `--json`
emits a parseable result.

```bash
tea-rags index-codebase <absolute-worktree-path> --name tea-rags-worktree --force --wait-enrichments --json
```
````

This exercises the chunker, all extraction walkers, symbol-table inserts, the
graph adapter (Tarjan SCC, PageRank), payload writers, and the enrichment
coordinator. Because `--wait-enrichments` blocks until completion, the command
returns only after enrichment settles — no polling needed.

````

Renumber the subsequent sections: the old "Step 4 — Wait for enrichment" polling step is now redundant (the CLI `--wait-enrichments` blocks until done) — remove it or fold its note into the new step. Keep "Step 5 — Verify all four enrichment levels reach `healthy`" (renumbered) using `mcp__tea-rags__get_index_status project: "tea-rags-worktree"`.

- [ ] **Step 2: Verify the skill reads coherently**

Read the edited skill. Confirm: one command registers + reindexes; the verify step still references the `tea-rags-worktree` alias; no dangling reference to the removed `register_project`/`index_codebase` MCP steps or the polling loop.

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/test-self-reindex/SKILL.md
git commit -m "improve(dx): test-self-reindex uses single index-codebase --name command

Replaces the register_project + index_codebase two-step (and the enrichment
polling loop) with 'index-codebase --name tea-rags-worktree --force
--wait-enrichments --json'."
````

---

### Task 5: Annotate the `worktree create` hint (minor)

**Files:**

- Modify: `src/cli/commands/worktree.ts` (comment only, near the `nextStep` line
  ~66–70)

**Interfaces:**

- Consumes: nothing new.
- Produces: a clarifying comment; no behavior change.

- [ ] **Step 1: Add the clarifying comment above `nextStep`**

In `runWorktreeCreate`, the hint stays `--project` (the alias is already
registered with worktree provenance). Add a comment clarifying why `--name` is
NOT used here:

```typescript
// Hint uses --project, NOT --name: createWorktree already registered the
// alias with worktree provenance. --name is for the first index of a fresh,
// unregistered project — using it here would create a second, provenance-less
// registration.
const nextStep = `tea-rags index-codebase --project ${res.alias}`;
```

- [ ] **Step 2: Typecheck (comment-only, no test)**

Run: `npx tsc --noEmit` Expected: PASS (no behavior change).

- [ ] **Step 3: Commit**

```bash
git add src/cli/commands/worktree.ts
git commit -m "docs(cli): note worktree-create hint uses --project (not --name) by design

--name would create a second provenance-less registration; the worktree alias
is already registered with provenance by createWorktree."
```

---

## Beads Tracking (plan-beads-sync — create BEFORE execution)

One epic, five 1:1 tasks (titles match plan Tasks). Labels: `api` + `dx`.

- Epic: "index-codebase --name register-then-index flag"
  - Task 1 → label `api` (CLI flag + handler register)
  - Task 2 → label `api` (register error UX)
  - Task 3 → labels `dx` (tea-rags:index skill wiring)
  - Task 4 → label `dx` (test-self-reindex single-command)
  - Task 5 → labels `dx` (worktree hint note)
- Dependencies: Task 2 depends on Task 1; Task 3, 4, 5 depend on Task 2.

## Self-Review

- **Spec coverage:** flag + handler ordering (Task 1, 2) ✓; reuse `register`
  (Task 1) ✓; `.conflicts` (Task 1) ✓; idempotency inherited (Task 1 test 2) ✓;
  error UX text/JSON + abort-before-fork (Task 2) ✓; primary wiring
  `tea-rags:index` (Task 3) ✓; secondary `test-self-reindex` (Task 4) ✓;
  worktree clarification (Task 5) ✓; versioning `feat(api)` (Task 1/2 commits)
  ✓; plugin bump (Task 3) ✓.
- **Placeholder scan:** all code/edits shown inline; no TBD. ✓
- **Type consistency:** `renderRegisterError(err, { json, colors })` defined in
  Task 2 and called in Task 2 Step 5;
  `ProjectRegistryOps`/`CollectionRegistry`/`InputValidationError`/`Colorizer`
  imports consistent across Tasks 1–2. ✓
