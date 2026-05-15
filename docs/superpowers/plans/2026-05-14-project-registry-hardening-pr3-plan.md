# Project Registry Hardening — PR3 (Polish) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `dinopowers:executing-plans`
> (NOT `superpowers:executing-plans`) and `dinopowers:test-driven-development`
> (NOT `superpowers:test-driven-development`) for the failing-test-first phases.
> If running via subagents, use `superpowers:subagent-driven-development` (that
> one is NOT wrapped). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close audit items #5, #13, #15 by replacing `process.exit(1)` calls
inside `applyProjectDefaults` with typed errors thrown to the caller, fixing the
empty-string `??` truthy bug in the same helper, and surfacing
symlink-vs-realpath mismatches in `projects info` output.

**Architecture:** `applyProjectDefaults` becomes a pure library function that
throws `ProjectNotRegisteredError` or `ProjectPathMissingError` (both
`InputValidationError` subclasses already defined in PR1+PR2). Its single
consumer (`tune.ts:99`) wraps the call in a try/catch that catches
`InputValidationError`, prints `message\nHint: hint` to stderr, and exits 1. The
`??` empty-string poisoning is fixed by coalescing `""` to `undefined` before
nullish-coalesce. `runInfo` adds an optional `realpath:` line when
`realpathSync(entry.path)` diverges from the stored path.

**Tech Stack:** TypeScript (strict), vitest, lint-staged (prettier + tsc
pre-commit), yargs for CLI handler dispatch.

**Spec:**
`docs/superpowers/specs/2026-05-13-project-registry-hardening-design.md` (commit
`bd78bd46`). Read it before drafting any change.

**Predecessor:** PR1 + PR2 + 3 hotfixes landed on this branch (25 commits ending
at `a5bf55a5`). `ProjectNotRegisteredError` and `ProjectPathMissingError`
already exist in `src/core/api/errors.ts`.

---

## Affected Files (tea-rags impact enrichment, rerank: imports+churn+ownership)

| File                                  | Owner                 | Churn         | Age              | Bugs | Tasks |
| ------------------------------------- | --------------------- | ------------- | ---------------- | ---- | ----- |
| `src/cli/registry-resolver.ts`        | Arthur 100% deep-silo | low           | recent (PR1)     | —    | 1     |
| `src/cli/commands/tune.ts`            | Arthur 100% deep-silo | 2 commits low | 39d              | n/a  | 2     |
| `src/cli/commands/projects.ts`        | Arthur 100% deep-silo | low           | recent (PR1+PR2) | —    | 3     |
| `tests/cli/registry-resolver.test.ts` | (existing)            | —             | —                | —    | 1     |
| `tests/cli/commands/tune.test.ts`     | (existing)            | —             | —                | —    | 2     |
| `tests/cli/commands/projects.test.ts` | (existing)            | —             | —                | —    | 3     |

**Coordinated change candidates:** none — greenfield polish, no shared taskIds.

**High-blast-radius files:** none. `applyProjectDefaults` has exactly ONE
consumer (`tune.ts:99`) per `grep -rn 'applyProjectDefaults' src/`. The
refactor's blast radius is bounded by that single call site.

---

## Out of scope (do NOT modify)

- `src/core/infra/collection-name.ts:resolveCollection` signature — main risk
  node, untouched in PR1+PR2 and stays that way here.
- `RegistryFileV1` shape — version stays 1, no field additions.
- `src/core/api/errors.ts` — both required typed errors already exist
  (`ProjectNotRegisteredError` from PR1, `ProjectPathMissingError` from PR2-T1
  `f063c22d`). Do NOT add new error classes.
- `applyProjectDefaults` exported signature — same type parameter `A`, same
  return shape. Only the error path changes (throw, not `process.exit`).
- `tea-rags doctor`, `tea-rags projects orphans`, `unregister --purge` — those
  are PR2 surfaces, untouched here.

---

## Beads Epic — create FIRST (TBD until beads server reachable)

```bash
# Same caveat as PR1/PR2 — the beads server in this worktree currently
# points at a different data directory; epic creation deferred to a
# post-merge session.

bd dolt pull
bd create \
  --title="PR3 — registry polish" \
  --description="Spec: docs/superpowers/specs/2026-05-13-project-registry-hardening-design.md (bd78bd46). Plan: docs/superpowers/plans/2026-05-14-project-registry-hardening-pr3-plan.md. Closes audit items #5 (empty-string poisoning), #13 (symlink mismatch), #15 (process.exit in library). RegistryFileV1 shape unchanged. App surface unchanged. No new error classes." \
  --type=epic \
  --priority=2
# Capture $EPIC; bd label add $EPIC dx architecture
```

Each subsequent Task creates a beads task linked to `$EPIC` once the server is
reachable. Capture each as `$T1`…`$T3`.

---

## Task 1: `applyProjectDefaults` — typed errors + empty-string fallback

**Goal:** Replace `process.stderr.write + process.exit(1)` in
`src/cli/registry-resolver.ts` with `throw new ProjectNotRegisteredError(...)`.
Add `entry.path === ""` check that throws `ProjectPathMissingError(name, hint)`.
Coerce empty `embeddingModel` / `qdrantUrl` to `undefined` before the
nullish-coalesce so they fall through to CLI defaults instead of poisoning the
result.

**Files:**

- Modify: `src/cli/registry-resolver.ts:17-35`
- Modify: `tests/cli/registry-resolver.test.ts`

---

- [ ] **Step 1: Write the failing tests**

File: `tests/cli/registry-resolver.test.ts` (existing). Append at the end of the
file:

```ts
describe("applyProjectDefaults typed-error refactor (audit #5 + #15)", () => {
  it("throws ProjectNotRegisteredError when the alias is unknown (not process.exit)", async () => {
    const { applyProjectDefaults } =
      await import("../../src/cli/registry-resolver.js");
    const { ProjectNotRegisteredError } =
      await import("../../src/core/api/errors.js");
    process.env.TEA_RAGS_DATA_DIR = mkdtempSync(
      join(tmpdir(), "pr3-resolver-"),
    );
    try {
      expect(() => applyProjectDefaults({ project: "ghost" })).toThrow(
        ProjectNotRegisteredError,
      );
    } finally {
      rmSync(process.env.TEA_RAGS_DATA_DIR, { recursive: true, force: true });
      delete process.env.TEA_RAGS_DATA_DIR;
    }
  });

  it("throws ProjectPathMissingError when entry.path is empty (audit #6/#7 + #15)", async () => {
    const { applyProjectDefaults } =
      await import("../../src/cli/registry-resolver.js");
    const { ProjectPathMissingError } =
      await import("../../src/core/api/errors.js");
    const { CollectionRegistry } =
      await import("../../src/core/infra/registry/collection-registry.js");
    process.env.TEA_RAGS_DATA_DIR = mkdtempSync(
      join(tmpdir(), "pr3-resolver-"),
    );
    try {
      const reg = new CollectionRegistry(process.env.TEA_RAGS_DATA_DIR);
      // Recovered-stub style entry: name set, path empty.
      reg.record({
        collectionName: "code_recovered",
        path: "",
        embeddingModel: "",
        embeddingDimensions: 0,
        qdrantUrl: "",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      reg.setName("code_recovered", "rec");
      expect(() => applyProjectDefaults({ project: "rec" })).toThrow(
        ProjectPathMissingError,
      );
    } finally {
      rmSync(process.env.TEA_RAGS_DATA_DIR, { recursive: true, force: true });
      delete process.env.TEA_RAGS_DATA_DIR;
    }
  });

  it("returns undefined (not empty string) for missing embeddingModel and qdrantUrl (audit #5)", async () => {
    const { applyProjectDefaults } =
      await import("../../src/cli/registry-resolver.js");
    const { CollectionRegistry } =
      await import("../../src/core/infra/registry/collection-registry.js");
    const dir = mkdtempSync(join(tmpdir(), "pr3-resolver-"));
    process.env.TEA_RAGS_DATA_DIR = dir;
    try {
      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName: "code_stub",
        path: "/repo/known",
        embeddingModel: "", // stub from tryEnrichFromQdrant with no marker
        embeddingDimensions: 0,
        qdrantUrl: "", // stub
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      reg.setName("code_stub", "stub");
      const resolved = applyProjectDefaults({ project: "stub" });
      // Old code: empty strings poisoned the resolved argv.
      // New code: argv.model / argv["qdrant-url"] left undefined so CLI
      // defaults take over downstream.
      expect(resolved.model).toBeUndefined();
      expect(resolved["qdrant-url"]).toBeUndefined();
      expect(resolved.path).toBe("/repo/known");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.TEA_RAGS_DATA_DIR;
    }
  });

  it("preserves caller-provided argv values (does not overwrite explicit args)", async () => {
    const { applyProjectDefaults } =
      await import("../../src/cli/registry-resolver.js");
    const { CollectionRegistry } =
      await import("../../src/core/infra/registry/collection-registry.js");
    const dir = mkdtempSync(join(tmpdir(), "pr3-resolver-"));
    process.env.TEA_RAGS_DATA_DIR = dir;
    try {
      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName: "code_full",
        path: "/registry/path",
        embeddingModel: "registry-model",
        embeddingDimensions: 384,
        qdrantUrl: "http://registry-q",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      reg.setName("code_full", "full");
      const resolved = applyProjectDefaults({
        project: "full",
        path: "/explicit/path",
        model: "explicit-model",
      });
      expect(resolved.path).toBe("/explicit/path");
      expect(resolved.model).toBe("explicit-model");
      expect(resolved["qdrant-url"]).toBe("http://registry-q");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.TEA_RAGS_DATA_DIR;
    }
  });
});
```

Add to the imports at the top of the test file: `mkdtempSync`, `rmSync` from
`node:fs`; `tmpdir` from `node:os`; `join` from `node:path`. They may already be
imported — check the existing file and don't duplicate.

- [ ] **Step 2: Run tests to verify failure**

Run:
`npx vitest run tests/cli/registry-resolver.test.ts -t "typed-error refactor"`
Expected: FAIL — current code calls `process.exit(1)` (the test runner may
crash, or the `toThrow` assertion fails because no error escapes); the
empty-string assertion fails because current code populates the result with
`""`.

- [ ] **Step 3: Refactor `applyProjectDefaults`**

File: `src/cli/registry-resolver.ts`. Replace the entire file with:

```ts
import { homedir } from "node:os";
import { join } from "node:path";

import {
  ProjectNotRegisteredError,
  ProjectPathMissingError,
} from "../core/api/errors.js";
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

/**
 * Resolve --path / --qdrant-url / --model defaults from the project registry
 * when the caller passed --project. The function throws typed
 * InputValidationError subclasses (not process.exit) so callers can catch
 * and present the failure in their own UX (CLI, JSON, MCP).
 *
 * Empty-string values stored in the registry (recovered stubs from
 * `tea-rags doctor --recover-registry`) are coerced to undefined before
 * nullish-coalesce so downstream code falls through to its own defaults
 * instead of being poisoned with `""`. Audit #5.
 *
 * @throws ProjectNotRegisteredError when --project names an alias not in the
 *   registry.
 * @throws ProjectPathMissingError when the registry entry exists but its
 *   path field is empty (recovered stub awaiting re-registration).
 */
export function applyProjectDefaults<A extends ProjectAwareArgs>(argv: A): A {
  if (!argv.project) return argv;
  const registry = new CollectionRegistry(resolveDataDir());
  const entry = registry.findByName(argv.project);
  if (!entry) {
    const names = registry
      .list()
      .map((e) => e.name)
      .filter((n): n is string => n !== null);
    throw new ProjectNotRegisteredError(argv.project, names);
  }
  if (entry.path === "") {
    throw new ProjectPathMissingError(
      argv.project,
      `Run: tea-rags projects register --path <dir> --name ${argv.project}`,
    );
  }
  return {
    ...argv,
    path: argv.path ?? entry.path,
    "qdrant-url": argv["qdrant-url"] ?? (entry.qdrantUrl || undefined),
    model: argv.model ?? (entry.embeddingModel || undefined),
  };
}
```

Three behaviour changes vs the prior version:

1. `process.stderr.write` + `process.exit(1)` →
   `throw new ProjectNotRegisteredError(...)`.
2. New guard: `entry.path === ""` → `throw new ProjectPathMissingError(...)`.
3. Empty-string `embeddingModel` / `qdrantUrl` → coerced to `undefined` via
   `|| undefined`, so the `??` fallback works correctly.

The `path` field stays as-is (no `|| undefined`) because `entry.path === ""` is
now caught explicitly by the guard above; reaching the return statement
guarantees `entry.path` is non-empty.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/cli/registry-resolver.test.ts` Expected: PASS — all 4
new tests + any existing tests still green. If an existing test expected
`process.exit` behaviour, adjust it to expect the typed throw instead.

- [ ] **Step 5: Run full build + vitest**

Run: `npm run build && npx vitest run` Expected: PASS — `tune.ts` (the sole
consumer) still compiles because the exported signature is unchanged. Its
runtime behaviour for unknown aliases will now throw instead of exiting — Task 2
adds the catch.

(Note: until Task 2 lands, an end-user `tea-rags tune --project ghost` will
crash with an unhandled `ProjectNotRegisteredError` traceback rather than the
friendly `process.exit(1)`. That's acceptable for an intermediate state since
Task 2 follows immediately.)

- [ ] **Step 6: Commit**

```bash
git add src/cli/registry-resolver.ts tests/cli/registry-resolver.test.ts
git commit -m "$(cat <<'EOF'
improve(cli): applyProjectDefaults throws typed errors and ignores empty-string registry stubs

Three changes in one refactor:

- Replace process.exit(1) inside the library function with throw
  ProjectNotRegisteredError so callers can catch and present the failure
  in their own UX. Closes audit #15 (process.exit in lib layer).

- Add ProjectPathMissingError guard for recovered registry stubs
  (path:"" from `tea-rags doctor --recover-registry`). Primes the
  recovery flow's user-facing error.

- Coerce empty embeddingModel/qdrantUrl to undefined before
  nullish-coalesce so downstream code falls through to its own defaults
  instead of being poisoned with "". Closes audit #5 (empty-string
  poisoning).

The exported function signature is unchanged. The sole consumer
(src/cli/commands/tune.ts:99) gains a try/catch in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Close beads task (when reachable)**

```bash
bd close $T1
```

---

## Task 2: `tune.ts` — catch `InputValidationError` and exit cleanly

**Goal:** Wrap the single `applyProjectDefaults` call in `tune.ts:99` with a
try/catch that catches `InputValidationError` (parent of both
`ProjectNotRegisteredError` and `ProjectPathMissingError`), writes
`${err.message}\nHint: ${err.hint}` to stderr, and exits 1. Other errors
rethrow.

**Files:**

- Modify: `src/cli/commands/tune.ts` (handler around line 98-107)
- Modify: `tests/cli/commands/tune.test.ts`

---

- [ ] **Step 1: Write the failing test**

File: `tests/cli/commands/tune.test.ts` (existing). Append:

```ts
describe("tune handler catches applyProjectDefaults typed errors (audit #15)", () => {
  it("writes message + hint to stderr and exits 1 on ProjectNotRegisteredError", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const tmp = mkdtempSync(join(tmpdir(), "pr3-tune-"));
    process.env.TEA_RAGS_DATA_DIR = tmp;
    try {
      const { tuneCommand } = await import("../../../src/cli/commands/tune.js");
      // yargs handler is async and calls process.exit; the mock above
      // converts that into a throw we can assert on.
      const handler = tuneCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await expect(
        handler({
          project: "ghost-alias",
          _: ["tune"],
          $0: "tea-rags",
        } as never),
      ).rejects.toThrow(/process\.exit\(1\)/);
      const errOut = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(errOut).toMatch(/not registered/i);
      expect(errOut.toLowerCase()).toContain("hint");
    } finally {
      stderr.mockRestore();
      exit.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
      delete process.env.TEA_RAGS_DATA_DIR;
    }
  });

  it("writes path-missing hint to stderr on ProjectPathMissingError", async () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const tmp = mkdtempSync(join(tmpdir(), "pr3-tune-"));
    process.env.TEA_RAGS_DATA_DIR = tmp;
    try {
      const { CollectionRegistry } =
        await import("../../../src/core/infra/registry/collection-registry.js");
      const reg = new CollectionRegistry(tmp);
      reg.record({
        collectionName: "code_recovered",
        path: "",
        embeddingModel: "",
        embeddingDimensions: 0,
        qdrantUrl: "",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      reg.setName("code_recovered", "rec");

      const { tuneCommand } = await import("../../../src/cli/commands/tune.js");
      const handler = tuneCommand.handler as (
        argv: Record<string, unknown>,
      ) => Promise<void>;
      await expect(
        handler({ project: "rec", _: ["tune"], $0: "tea-rags" } as never),
      ).rejects.toThrow(/process\.exit\(1\)/);
      const errOut = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(errOut.toLowerCase()).toContain("has no path stored");
      expect(errOut).toContain("tea-rags projects register");
    } finally {
      stderr.mockRestore();
      exit.mockRestore();
      rmSync(tmp, { recursive: true, force: true });
      delete process.env.TEA_RAGS_DATA_DIR;
    }
  });
});
```

Add imports if missing: `mkdtempSync`, `rmSync` from `node:fs`; `tmpdir` from
`node:os`; `join` from `node:path`; `vi` from `vitest`.

- [ ] **Step 2: Run tests to verify failure**

Run:
`npx vitest run tests/cli/commands/tune.test.ts -t "catches applyProjectDefaults"`
Expected: FAIL — tune handler currently lets the throw escape; the test expects
clean stderr + exit 1.

- [ ] **Step 3: Wrap the call in tune.ts**

File: `src/cli/commands/tune.ts`. Today line 8 imports `applyProjectDefaults`
from `../registry-resolver.js`. Add a sibling import for the parent error class:

```ts
import { InputValidationError } from "../../core/api/errors.js";
```

(Keep alphabetical order if the file's existing imports follow it.)

Replace the handler (currently lines 98-107):

```ts
  handler: async (argv) => {
    let resolved: TuneArgs;
    try {
      resolved = applyProjectDefaults(argv as TuneArgs);
    } catch (err) {
      if (err instanceof InputValidationError) {
        process.stderr.write(`${err.message}\nHint: ${err.hint}\n`);
        process.exit(1);
      }
      throw err;
    }
    const resolution = await resolveTuneQdrantUrl(resolved["qdrant-url"]);
    if (resolution.url) {
      resolved["qdrant-url"] = resolution.url;
    }
    const sub = argv.subcommand as string | undefined;
    const script = sub === "embeddings" ? "benchmark-embeddings.mjs" : "tune.mjs";
    runScript(script, resolved, resolution.release);
  },
```

The `let resolved: TuneArgs;` declaration with assignment inside the try is
deliberate — TypeScript's flow analysis recognises that either the assignment
succeeded or the function exited (via `process.exit` in the catch) or re-threw.
The `if (err instanceof InputValidationError)` block is the documented
happy-error path; anything else (programmer error, QdrantConnectionError, etc.)
propagates with its original stack.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/cli/commands/tune.test.ts` Expected: PASS.

- [ ] **Step 5: Run full build + vitest**

Run: `npm run build && npx vitest run` Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/tune.ts tests/cli/commands/tune.test.ts
git commit -m "$(cat <<'EOF'
improve(cli): tune handler catches InputValidationError from applyProjectDefaults

Wrap the single applyProjectDefaults call in src/cli/commands/tune.ts
in a try/catch. Catches the InputValidationError parent type (handles
both ProjectNotRegisteredError and ProjectPathMissingError), writes
`${err.message}\nHint: ${err.hint}` to stderr, and exits 1. Other
errors rethrow with their original stack.

Closes the consumer half of audit #15 (process.exit moved out of the
library, into the handler where it belongs).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: `runInfo` — surface symlink/realpath mismatch

**Goal:** When `realpathSync(entry.path)` diverges from the stored `entry.path`,
`tea-rags projects info` should say so. Text mode adds a `realpath:` line and a
one-line hint; JSON mode adds a `realpath` field (only when it differs, to keep
the contract small).

Stored path is already `realpath`'d at registration time (see
`src/core/infra/collection-name.ts:validatePath`). A future divergence happens
when the live `realpath` changes — e.g. mount point moved or a symlink was
retargeted on top of the resolved location. The hint nudges the user toward
re-registering.

If the path no longer exists on disk (registry survived a `rm -rf <repo>`), the
`realpathSync` call throws — caught and rendered as `(path missing on disk)`.

**Files:**

- Modify: `src/cli/commands/projects.ts:111-132` (`runInfo`)
- Modify: `tests/cli/commands/projects.test.ts`

---

- [ ] **Step 1: Write the failing tests**

File: `tests/cli/commands/projects.test.ts` (existing). Append inside the main
`describe("CLI 'projects' command group", ...)` block:

```ts
describe("info — symlink/realpath mismatch (audit #13)", () => {
  it("text mode adds a realpath line + hint when path diverges from realpathSync", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const realDir = join(dir, "real");
      const linkDir = join(dir, "link");
      mkdirSync(realDir);
      writeFileSync(join(realDir, ".keep"), "");
      symlinkSync(realDir, linkDir);

      const reg = new CollectionRegistry(dir);
      // Stash the LINK path (not the resolved realDir). In production the
      // registry stores realpath, but for this test we set up a mismatch
      // explicitly: register the symlink path so realpath(stored) === realDir.
      reg.record({
        collectionName: "code_link",
        path: linkDir,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "http://q",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      reg.setName("code_link", "linky");
      runInfo({ name: "linky" });
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).toContain(`path:                ${linkDir}`);
      expect(out).toContain(`realpath:            ${realDir}`);
      expect(out.toLowerCase()).toContain("symlink");
    } finally {
      stdout.mockRestore();
    }
  });

  it("text mode omits the realpath line when stored path already equals realpathSync", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName: "code_direct",
        path: repo, // repo is already a realpath (no symlink in the way)
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "http://q",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      reg.setName("code_direct", "direct");
      runInfo({ name: "direct" });
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out).not.toContain("realpath:");
    } finally {
      stdout.mockRestore();
    }
  });

  it("text mode reports '(missing on disk)' when realpathSync throws", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName: "code_gone",
        path: join(dir, "nonexistent-subdir"),
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "http://q",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      reg.setName("code_gone", "gone");
      runInfo({ name: "gone" });
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      expect(out.toLowerCase()).toContain("missing on disk");
    } finally {
      stdout.mockRestore();
    }
  });

  it("--json includes realpath only when it differs from stored path", async () => {
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      const realDir = join(dir, "real-json");
      const linkDir = join(dir, "link-json");
      mkdirSync(realDir);
      writeFileSync(join(realDir, ".keep"), "");
      symlinkSync(realDir, linkDir);

      const reg = new CollectionRegistry(dir);
      reg.record({
        collectionName: "code_jsonlink",
        path: linkDir,
        embeddingModel: "m",
        embeddingDimensions: 1,
        qdrantUrl: "http://q",
        indexedAt: "",
        teaRagsVersion: "",
        chunksCount: 0,
      });
      reg.setName("code_jsonlink", "jsonlink");
      runInfo({ name: "jsonlink", json: true });
      const out = stdout.mock.calls.map((c) => String(c[0])).join("");
      const parsed = JSON.parse(out.trim());
      expect(parsed.path).toBe(linkDir);
      expect(parsed.realpath).toBe(realDir);
    } finally {
      stdout.mockRestore();
    }
  });
});
```

Add to the test file's imports if missing: `symlinkSync` from `node:fs`,
`runInfo` from `../../../src/cli/commands/projects.js` (might already be there).

- [ ] **Step 2: Run tests to verify failure**

Run: `npx vitest run tests/cli/commands/projects.test.ts -t "realpath mismatch"`
Expected: FAIL — `runInfo` does not yet emit `realpath:` line.

- [ ] **Step 3: Add the realpath check to `runInfo`**

File: `src/cli/commands/projects.ts`. Add to the imports at the top:

```ts
import { realpathSync } from "node:fs";
```

(The file already imports from `node:fs` in some other place — group with
existing imports.)

Replace the `runInfo` body (currently lines 111-132):

```ts
export function runInfo(args: InfoArgs): void {
  const { registry } = newOps();
  const entry: CollectionEntry | null = registry.findByName(args.name);
  if (!entry) {
    process.stderr.write(`'${args.name}' was not registered\n`);
    process.exit(1);
    return;
  }

  // Compute the live realpath. Missing on disk → null sentinel rendered as
  // "(missing on disk)" in text mode and omitted from JSON.
  let realpath: string | null;
  try {
    realpath = realpathSync(entry.path);
  } catch {
    realpath = null;
  }
  const realpathDiffers = realpath !== null && realpath !== entry.path;

  if (args.json) {
    const payload: Record<string, unknown> = { ...entry };
    if (realpathDiffers) {
      payload.realpath = realpath;
    }
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  process.stdout.write(`name:                ${entry.name ?? "(no name)"}\n`);
  process.stdout.write(`collectionName:      ${entry.collectionName}\n`);
  process.stdout.write(`path:                ${entry.path}\n`);
  if (realpath === null) {
    process.stdout.write(`realpath:            (missing on disk)\n`);
  } else if (realpathDiffers) {
    process.stdout.write(`realpath:            ${realpath}\n`);
    process.stdout.write(
      `                     (symlink or moved mount — re-register to refresh)\n`,
    );
  }
  process.stdout.write(`qdrantUrl:           ${entry.qdrantUrl || "(none)"}\n`);
  process.stdout.write(
    `embeddingModel:      ${entry.embeddingModel || "(none)"}\n`,
  );
  process.stdout.write(
    `embeddingDimensions: ${entry.embeddingDimensions || 0}\n`,
  );
  process.stdout.write(`chunksCount:         ${entry.chunksCount}\n`);
  process.stdout.write(
    `indexedAt:           ${entry.indexedAt || "(never)"}\n`,
  );
  process.stdout.write(
    `teaRagsVersion:      ${entry.teaRagsVersion || "(unknown)"}\n`,
  );
}
```

Three changes vs the previous version:

1. Compute `realpath` once with try/catch; `null` when the path no longer
   exists.
2. JSON output gains an optional `realpath` field only when it differs.
3. Text output adds a `realpath:` line (with a clarifying hint) when there's a
   mismatch; or `(missing on disk)` when the path is gone entirely.

- [ ] **Step 4: Run tests to verify pass**

Run: `npx vitest run tests/cli/commands/projects.test.ts -t "realpath mismatch"`
Expected: PASS (all 4 new tests).

- [ ] **Step 5: Run full build + vitest**

Run: `npm run build && npx vitest run` Expected: PASS — existing `info` tests
still pass; the realpath line only appears in the mismatch / missing cases, so
any test that registered a plain realpath'd directory continues to see the same
output.

- [ ] **Step 6: Commit**

```bash
git add src/cli/commands/projects.ts tests/cli/commands/projects.test.ts
git commit -m "$(cat <<'EOF'
improve(cli): 'projects info' surfaces realpath divergence and missing-on-disk

Closes audit #13. When the live realpathSync of the stored path differs
from the stored value (symlink retargeted, mount moved), the text
output adds a `realpath:` line plus a hint that the user should
re-register. When the path is gone entirely, the output reads
`(missing on disk)`.

--json gains an optional `realpath` field that appears only when it
differs from the stored path — keeps the on-the-wire shape minimal
for the common case.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 7: Close beads task + epic (when reachable)**

```bash
bd close $T3
bd close $EPIC --reason="PR3 complete — 3 audit items closed (#5, #13, #15). Tasks 1-3 landed atomically."
```

---

## Done-criteria for the whole PR3

- `npm run build` passes.
- `npx vitest run` passes.
- 3 audit items closed (#5, #13, #15) — each Task's commit references the
  numbers.
- `git diff main -- src/core/api/public/app.ts` empty (App API surface
  byte-compatible).
- `git diff main -- src/core/infra/registry/types.ts` empty (`RegistryFileV1`
  shape untouched).
- `git diff main -- src/core/infra/collection-name.ts` empty
  (`resolveCollection` unchanged).
- `git diff main -- src/core/api/errors.ts` shows only the additions from
  PR1+PR2 — PR3 adds no new error classes here.
- 3 atomic commits, all on `improve(cli)` scope.
- Manual smoke: `tea-rags tune --project ghost` (any unknown alias) prints
  `Project 'ghost' is not registered.\nHint: ...` to stderr and exits 1 (no
  traceback). `tea-rags projects info --name <symlinked-alias>` shows both
  `path:` and `realpath:` lines.

PR3 is the final PR in the project-registry-hardening series. After this ships,
all 15 audit items from the 2026-05-13 audit are closed.
