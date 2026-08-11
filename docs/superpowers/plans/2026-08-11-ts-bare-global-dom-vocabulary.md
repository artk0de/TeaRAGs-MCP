# TS bare ambient-global classification + DOM/BOM vocabulary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the ambient-global portion of `tea-rags-mcp-4008o` and give the
TS resolver's external classifier a DOM/BOM vocabulary, so `resolveSuccessRate`
stops silently misclassifying bare calls to JS/Node/browser ambient globals
(`parseInt`, `fetch`, `setTimeout`) and receiver-shaped DOM/BOM calls
(`window.*`, `document.*`, `new AbortController()`) as in-project misses.

**Architecture:** Two additive-only changes to existing, already-dispatched
machinery — no new interfaces, no new resolver methods, no
`resolution-runner.ts` changes. (1) A new case appended to the existing
`targetsExternalImport` function in `ts-external-call.ts`, covering bare
(no-receiver) calls to a new `BARE_GLOBAL_CALLABLES` vocabulary set. (2) Three
vocabulary extensions to `ecmascript-globals.ts` (DOM/BOM names into the two
existing receiver-shaped sets, browser-ambient names into the new bare-call
set), which the ALREADY-EXISTING cases 1 and 3 of `targetsExternalImport`
consume automatically — no code change needed for those two, only data.

**Tech Stack:** TypeScript, vitest.

## Global Constraints

- Design doc:
  `docs/superpowers/specs/2026-08-11-ts-core-ambiguous-member-dom-globals-design.md`
  (committed `20a62c29`) — this plan implements it verbatim; do not deviate
  without updating the design doc first.
- TDD mandatory (project `.claude/CLAUDE.md`): failing test → verify red →
  minimal implementation → verify green → commit, one Task at a time.
- Never lower coverage thresholds, never add `eslint-disable` (project feedback
  memory).
- Commit messages: conventional, scope `contracts` region maps to
  `domains/language` → use `fix(language)` (bug-fix framing: a real call was
  being miscounted) per `.claude/rules/commit-rules.md` scope table (no
  `language` scope listed explicitly — closest analytical fit is a `fix` under
  the default unscoped/`api` bucket; use `fix(language)` matching this epic's
  existing commit history, e.g.
  `7fce8b12 fix(language): checker-backed receiver arm for the TS external-call guard`).
- Header ≤100 chars, commitlint-enforced.

---

## File Structure

| File                                                                                    | Change                                                                                                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/domains/language/shared/ecmascript-globals.ts`                                | Add `BARE_GLOBAL_CALLABLES` (new export), extend `ECMASCRIPT_GLOBALS` and `ECMASCRIPT_BUILTIN_TYPES` (existing exports) with DOM/BOM names |
| `src/core/domains/language/typescript/resolver/ts-external-call.ts`                     | Add case 7 to `targetsExternalImport`; import `BARE_GLOBAL_CALLABLES`                                                                      |
| `tests/core/domains/language/typescript/resolver/ts-bare-global-callable-guard.test.ts` | New — case 7 behavioral tests                                                                                                              |
| `tests/core/domains/language/typescript/resolver/ts-dom-global-receiver-guard.test.ts`  | New — DOM/BOM vocabulary behavioral tests                                                                                                  |

Two new test files (not additions to the existing
`ts-builtin-receiver-guard.test.ts`) to match this suite's established
one-file-per-guard-addition pattern (see
`ts-annotated-external-receiver-guard.test.ts`,
`ts-checker-backed-receiver-guard.test.ts`,
`ts-const-arrow-short-name-collision.test.ts`, etc. — each landed as its own
file).

---

## Task 1: Bare ambient-global callable classification (case 7)

**Files:**

- Modify: `src/core/domains/language/shared/ecmascript-globals.ts` (add
  `BARE_GLOBAL_CALLABLES`)
- Modify:
  `src/core/domains/language/typescript/resolver/ts-external-call.ts:79-110`
  (add case 7 inside `targetsExternalImport`)
- Test:
  `tests/core/domains/language/typescript/resolver/ts-bare-global-callable-guard.test.ts`

**Interfaces:**

- Consumes:
  `CallRef { callText: string; receiver: string | null; member: string; startLine: number }`,
  `CallContext` (both from `src/core/contracts/types/codegraph.ts`),
  `TSCallResolver`
  (`src/core/domains/language/typescript/resolver/ts-resolver.ts`) constructed
  as `new TSCallResolver({ baseUrl: ".", paths: {} })`,
  `InMemoryGlobalSymbolTable`
  (`src/core/domains/trajectory/codegraph/symbols/symbol-table.ts`).
- Produces: `BARE_GLOBAL_CALLABLES: ReadonlySet<string>` exported from
  `ecmascript-globals.ts`, consumed by `targetsExternalImport` in
  `ts-external-call.ts`. `resolver.targetsExternalImport(call, ctx)` returns
  `true` for a bare call whose `member` is in this set.

- [ ] **Step 1: Write the failing tests**

Create
`tests/core/domains/language/typescript/resolver/ts-bare-global-callable-guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  type CallContext,
  type CallRef,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ctx = (
  over: Partial<CallContext> & Pick<CallContext, "symbolTable">,
): CallContext => ({
  callerFile: "src/caller.ts",
  callerScope: [],
  imports: [],
  ...over,
});

/**
 * bd tea-rags-mcp-4008o — a bare call to a JS/Node/browser ambient global
 * (`parseInt`, `fetch`, `setTimeout`) has no receiver, so it never reaches
 * `ECMASCRIPT_GLOBALS`' receiver-text check (case 1) or `ECMASCRIPT_BUILTIN_TYPES`'
 * receiver-type check (case 3). `calleeIsExternalLocalBinding` (case 6) only
 * classifies identifiers whose TS declaration is a local Parameter /
 * BindingElement / function-body-local VariableDeclaration — an ambient
 * global's declaration lives in `lib.es5.d.ts` / `lib.dom.d.ts` at global
 * scope, so case 6 never fires either. Before this case, these calls were
 * excluded from `resolveSuccessRate`'s denominator only when no project
 * symbol happened to share the name (lexical accident) — the day one does,
 * they silently become permanent misses. This test pins the fix: excluded by
 * CLASSIFICATION, unconditionally.
 */
describe("TSCallResolver.targetsExternalImport — bare ambient-global callable (bd tea-rags-mcp-4008o)", () => {
  const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });

  it("flags a bare call to a Node/ES ambient global (parseInt(x))", () => {
    const call: CallRef = {
      callText: "parseInt(x)",
      receiver: null,
      member: "parseInt",
      startLine: 9,
    };
    expect(
      resolver.targetsExternalImport(
        call,
        ctx({ symbolTable: new InMemoryGlobalSymbolTable() }),
      ),
    ).toBe(true);
  });

  it("flags a bare call to a browser ambient global (fetch(url))", () => {
    const call: CallRef = {
      callText: "fetch(url)",
      receiver: null,
      member: "fetch",
      startLine: 9,
    };
    expect(
      resolver.targetsExternalImport(
        call,
        ctx({ symbolTable: new InMemoryGlobalSymbolTable() }),
      ),
    ).toBe(true);
  });

  it("flags a bare call to a timer ambient global (setTimeout(fn, ms))", () => {
    const call: CallRef = {
      callText: "setTimeout(fn, ms)",
      receiver: null,
      member: "setTimeout",
      startLine: 9,
    };
    expect(
      resolver.targetsExternalImport(
        call,
        ctx({ symbolTable: new InMemoryGlobalSymbolTable() }),
      ),
    ).toBe(true);
  });

  it("flags a bare converter-style call (String(x))", () => {
    const call: CallRef = {
      callText: "String(x)",
      receiver: null,
      member: "String",
      startLine: 9,
    };
    expect(
      resolver.targetsExternalImport(
        call,
        ctx({ symbolTable: new InMemoryGlobalSymbolTable() }),
      ),
    ).toBe(true);
  });

  it("does NOT flag a bare call whose member is not in the ambient vocabulary (handle(req))", () => {
    const call: CallRef = {
      callText: "handle(req)",
      receiver: null,
      member: "handle",
      startLine: 9,
    };
    expect(
      resolver.targetsExternalImport(
        call,
        ctx({ symbolTable: new InMemoryGlobalSymbolTable() }),
      ),
    ).toBe(false);
  });

  it("does NOT flag a RECEIVER-bearing call sharing an ambient-vocabulary member name (obj.fetch())", () => {
    const call: CallRef = {
      callText: "obj.fetch()",
      receiver: "obj",
      member: "fetch",
      startLine: 9,
    };
    expect(
      resolver.targetsExternalImport(
        call,
        ctx({ symbolTable: new InMemoryGlobalSymbolTable() }),
      ),
    ).toBe(false);
  });

  it("still resolves a bare call to a real project function sharing no ambient name (loadConfig())", () => {
    const call: CallRef = {
      callText: "loadConfig()",
      receiver: null,
      member: "loadConfig",
      startLine: 9,
    };
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/config.ts", [
      {
        symbolId: "loadConfig",
        fqName: "loadConfig",
        shortName: "loadConfig",
        relPath: "src/config.ts",
        scope: [],
      },
    ]);
    expect(resolver.resolve(call, ctx({ symbolTable }))).toEqual({
      targetRelPath: "src/config.ts",
      targetSymbolId: "loadConfig",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/language/typescript/resolver/ts-bare-global-callable-guard.test.ts`
Expected: FAIL — `BARE_GLOBAL_CALLABLES` not yet exported / case 7 not yet
present, so the first four `it`s (which expect `true`) fail their assertion
(`targetsExternalImport` currently returns `false` for all of them). The last
three (`handle`, `obj.fetch()`, `loadConfig()`) already pass — that's expected,
they pin pre-existing behavior this change must not disturb.

- [ ] **Step 3: Implement `BARE_GLOBAL_CALLABLES` in `ecmascript-globals.ts`**

Append to `src/core/domains/language/shared/ecmascript-globals.ts` (after the
existing `ECMASCRIPT_CONTAINER_PROTOTYPE_METHODS` export at the end of the
file):

```ts
/**
 * bd tea-rags-mcp-4008o — JS/Node/browser ambient globals callable with NO
 * receiver at all (`parseInt(x)`, `fetch(url)`, `setTimeout(fn, ms)`). Distinct
 * from {@link ECMASCRIPT_GLOBALS}, which matches receiver TEXT for
 * namespace-style calls (`Math.max`) — this set matches the bare call's
 * `member` directly, since a free call carries no receiver for that set to
 * match against.
 *
 * `ts-external-call.ts`'s `targetsExternalImport` case 6
 * (`calleeIsExternalLocalBinding`) only classifies identifiers whose TS
 * declaration is a local `Parameter` / `BindingElement` / function-body-local
 * `VariableDeclaration` (closures, hook returns) — never a true ambient global,
 * whose declaration lives in `lib.es5.d.ts` / `lib.dom.d.ts` at the global
 * scope. Before this set existed, these names left the `resolveSuccessRate`
 * denominator only when no project symbol happened to share them (lexical
 * accident, tea-rags-mcp-4008o) — this set excludes them by classification,
 * unconditionally.
 *
 * `String` / `Number` / `Boolean` appear here in their BARE CONVERTER-CALL
 * shape (`String(x)`), distinct from their entries in {@link ECMASCRIPT_GLOBALS}
 * which match the receiver-text namespace-call shape (`String.fromCharCode(c)`).
 */
export const BARE_GLOBAL_CALLABLES: ReadonlySet<string> = new Set([
  // Numeric / string conversion
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "String",
  "Number",
  "Boolean",
  // Timers
  "setTimeout",
  "clearTimeout",
  "setInterval",
  "clearInterval",
  "requestAnimationFrame",
  "cancelAnimationFrame",
  "queueMicrotask",
  // Networking / encoding
  "fetch",
  "encodeURIComponent",
  "decodeURIComponent",
  "encodeURI",
  "decodeURI",
  "btoa",
  "atob",
  "structuredClone",
  // User-interaction ambient globals (browser)
  "alert",
  "confirm",
  "prompt",
]);
```

- [ ] **Step 4: Implement case 7 in `ts-external-call.ts`**

Modify `src/core/domains/language/typescript/resolver/ts-external-call.ts`:

Add `BARE_GLOBAL_CALLABLES` to the existing import from
`../../shared/ecmascript-globals.js` (around line 26-31):

```ts
import {
  BARE_GLOBAL_CALLABLES,
  ECMASCRIPT_BUILTIN_PROTOTYPE_METHODS,
  ECMASCRIPT_BUILTIN_TYPES,
  ECMASCRIPT_CONTAINER_PROTOTYPE_METHODS,
  ECMASCRIPT_GLOBALS,
} from "../../shared/ecmascript-globals.js";
```

Add the new case right after case 1's check, inside `targetsExternalImport`
(around line 88-89):

```ts
const receiver = call.receiver ?? null;
if (receiver !== null && ECMASCRIPT_GLOBALS.has(receiver)) return true;
// case 7: a bare call to a known ambient global function/constructor —
// parseInt(x), fetch(url), setTimeout(fn) — no receiver, so cases 1-5 never
// see it, and case 6 only covers LOCAL value bindings (closures, hook
// returns), never a true ambient declared outside any file this project
// owns (bd tea-rags-mcp-4008o).
if (receiver === null && BARE_GLOBAL_CALLABLES.has(call.member)) return true;
```

Also update the function's docblock (lines 38-77) to add a 7th numbered case
matching the existing style, right after case 6's description:

```
 *   7. there is NO receiver, and the member name is a JS/Node/browser ambient
 *      global callable with no project-local declaration possible — see
 *      {@link BARE_GLOBAL_CALLABLES} (bd tea-rags-mcp-4008o).
```

- [ ] **Step 5: Run tests to verify they pass**

Run:
`npx vitest run tests/core/domains/language/typescript/resolver/ts-bare-global-callable-guard.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 6: Run the full resolver test suite to check for regressions**

Run: `npx vitest run tests/core/domains/language/typescript/resolver/` Expected:
PASS, no existing test broken (case 7 is additive-only, gated on
`receiver === null`, which cases 1-5 already short-circuit past).

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/language/shared/ecmascript-globals.ts \
        src/core/domains/language/typescript/resolver/ts-external-call.ts \
        tests/core/domains/language/typescript/resolver/ts-bare-global-callable-guard.test.ts
git commit -m "fix(language): classify bare ambient-global calls as external (tea-rags-mcp-4008o)"
```

---

## Task 2: DOM/BOM vocabulary extension

**Files:**

- Modify: `src/core/domains/language/shared/ecmascript-globals.ts` (extend
  `ECMASCRIPT_GLOBALS` and `ECMASCRIPT_BUILTIN_TYPES`; extend
  `BARE_GLOBAL_CALLABLES` — already covered by Task 1's set, DOM additions below
  are new entries appended to it)
- Test:
  `tests/core/domains/language/typescript/resolver/ts-dom-global-receiver-guard.test.ts`

**Interfaces:**

- Consumes: same as Task 1 (`TSCallResolver`, `CallRef`, `CallContext`,
  `InMemoryGlobalSymbolTable`), plus `localBindings` on `CallContext` for the
  typed-instance test (`{ [name]: [{ line: number; type: string }] }`, same
  shape used in `ts-builtin-receiver-guard.test.ts`).
- Produces: no new exports — extends the three sets `Task 1` and the
  pre-existing file already define; consumed automatically by
  `targetsExternalImport` cases 1, 3, and 7 (no code change in
  `ts-external-call.ts` for this Task).

- [ ] **Step 1: Write the failing tests**

Create
`tests/core/domains/language/typescript/resolver/ts-dom-global-receiver-guard.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  type CallContext,
  type CallRef,
} from "../../../../../../src/core/contracts/types/codegraph.js";
import { TSCallResolver } from "../../../../../../src/core/domains/language/typescript/resolver/ts-resolver.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

const ctx = (
  over: Partial<CallContext> & Pick<CallContext, "symbolTable">,
): CallContext => ({
  callerFile: "src/caller.ts",
  callerScope: [],
  imports: [],
  ...over,
});

/**
 * bd tea-rags-mcp-4008o (taxdome follow-up) — `ecmascript-globals.ts` covered
 * Node/ECMAScript core only, zero DOM/BOM names. A React/browser codebase
 * calls `window.*`, `document.*`, `localStorage.*`, `fetch(...)` constantly;
 * before this change every one of them fell through to a genuine resolver
 * miss (or, worse, a phantom edge to a same-named project symbol) — this is
 * the single largest measured contributor to taxdome's degraded
 * resolveSuccessRate (bareCall 0.53 vs tea-rags-mcp's own 0.98; see
 * memory `project_taxdome_ts_resolve_rate_gap.md`).
 */
describe("TSCallResolver.targetsExternalImport — DOM/BOM vocabulary (bd tea-rags-mcp-4008o)", () => {
  const resolver = new TSCallResolver({ baseUrl: ".", paths: {} });

  it("flags a receiver-text call on the BOM global `window` (window.addEventListener(t, fn))", () => {
    const call: CallRef = {
      callText: "window.addEventListener(t, fn)",
      receiver: "window",
      member: "addEventListener",
      startLine: 9,
    };
    expect(
      resolver.targetsExternalImport(
        call,
        ctx({ symbolTable: new InMemoryGlobalSymbolTable() }),
      ),
    ).toBe(true);
  });

  it("flags a receiver-text call on the DOM global `document` (document.querySelector(sel))", () => {
    const call: CallRef = {
      callText: "document.querySelector(sel)",
      receiver: "document",
      member: "querySelector",
      startLine: 9,
    };
    expect(
      resolver.targetsExternalImport(
        call,
        ctx({ symbolTable: new InMemoryGlobalSymbolTable() }),
      ),
    ).toBe(true);
  });

  it("flags a receiver-text call on `localStorage` (localStorage.getItem(k))", () => {
    const call: CallRef = {
      callText: "localStorage.getItem(k)",
      receiver: "localStorage",
      member: "getItem",
      startLine: 9,
    };
    expect(
      resolver.targetsExternalImport(
        call,
        ctx({ symbolTable: new InMemoryGlobalSymbolTable() }),
      ),
    ).toBe(true);
  });

  it("flags a call on a receiver typed as a DOM builtin instance (const c = new AbortController(); c.abort())", () => {
    const call: CallRef = {
      callText: "c.abort()",
      receiver: "c",
      member: "abort",
      startLine: 9,
    };
    const context = ctx({
      symbolTable: new InMemoryGlobalSymbolTable(),
      localBindings: { c: [{ line: 2, type: "AbortController" }] },
    });
    expect(resolver.targetsExternalImport(call, context)).toBe(true);
  });

  it("does NOT flag a receiver whose text merely CONTAINS a DOM global name (myWindow.foo())", () => {
    const call: CallRef = {
      callText: "myWindow.foo()",
      receiver: "myWindow",
      member: "foo",
      startLine: 9,
    };
    expect(
      resolver.targetsExternalImport(
        call,
        ctx({ symbolTable: new InMemoryGlobalSymbolTable() }),
      ),
    ).toBe(false);
  });

  it("still resolves a project class instance sharing no DOM/BOM name (const svc = new UserService(); svc.find(id))", () => {
    const call: CallRef = {
      callText: "svc.find(id)",
      receiver: "svc",
      member: "find",
      startLine: 9,
    };
    const symbolTable = new InMemoryGlobalSymbolTable();
    symbolTable.upsertFile("src/user-service.ts", [
      {
        symbolId: "UserService#find",
        fqName: "UserService#find",
        shortName: "find",
        relPath: "src/user-service.ts",
        scope: ["UserService"],
      },
    ]);
    const context = ctx({
      symbolTable,
      localBindings: { svc: [{ line: 2, type: "UserService" }] },
    });
    expect(resolver.resolve(call, context)).toEqual({
      targetRelPath: "src/user-service.ts",
      targetSymbolId: "UserService#find",
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/language/typescript/resolver/ts-dom-global-receiver-guard.test.ts`
Expected: FAIL — the first four `it`s expect `true` but `window`/`document`/
`localStorage`/`AbortController` are not yet in the vocabulary sets, so
`targetsExternalImport` returns `false` for all of them. The last two already
pass (`myWindow` never matches `window` by exact-text `Set.has`; `svc.find`
resolves via `localBindings` type already) — expected, pins pre-existing
behavior.

- [ ] **Step 3: Extend the vocabulary sets**

Modify `src/core/domains/language/shared/ecmascript-globals.ts`:

In `ECMASCRIPT_GLOBALS` (after the existing `"TextDecoder",` entry, before the
closing `]);` at line 74-75):

```ts
  // DOM / BOM ambient (bd tea-rags-mcp-4008o — taxdome React measurement)
  "window",
  "document",
  "navigator",
  "localStorage",
  "sessionStorage",
  "history",
  "location",
  "screen",
  "crypto",
  "performance",
```

In `ECMASCRIPT_BUILTIN_TYPES` (after the existing `"Buffer",` entry, before the
closing `]);` at line 161-162):

```ts
  // DOM / BOM instance types (bd tea-rags-mcp-4008o — taxdome React measurement)
  "Event",
  "CustomEvent",
  "FormData",
  "Blob",
  "File",
  "FileReader",
  "AbortController",
  "Headers",
  "Request",
  "Response",
  "IntersectionObserver",
  "MutationObserver",
  "ResizeObserver",
  "WebSocket",
  "Image",
  "Audio",
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
`npx vitest run tests/core/domains/language/typescript/resolver/ts-dom-global-receiver-guard.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 5: Run the full resolver + shared test suite to check for
      regressions**

Run:
`npx vitest run tests/core/domains/language/typescript/resolver/ tests/core/domains/language/`
Expected: PASS, no existing test broken (additive-only Set entries; no test in
the repo asserts a closed/finite `ECMASCRIPT_GLOBALS`/`ECMASCRIPT_BUILTIN_TYPES`
membership list — confirmed by the absence of a dedicated
`ecmascript-globals.test.ts` file in the repo).

- [ ] **Step 6: Run the full project test suite + coverage gate**

Run: `npm run test:coverage` Expected: PASS, coverage at or above the current
threshold (additive code paths with direct tests; no uncovered branches
introduced).

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/language/shared/ecmascript-globals.ts \
        tests/core/domains/language/typescript/resolver/ts-dom-global-receiver-guard.test.ts
git commit -m "fix(language): add DOM/BOM vocabulary to the TS external-call guard"
```

---

## Beads (create BEFORE executing Task 1, per `.claude/rules/.local/plan-beads-sync.md`)

```bash
# Task 1 — closes the ambient-global portion of 4008o (do NOT close 4008o
# itself yet if its put-style residual is being left open; see note below)
bd update tea-rags-mcp-4008o --claim

# Task 2 — new bead, DOM/BOM vocabulary, linked under the same epic
bd create --title="TS external-call guard: DOM/BOM vocabulary (taxdome gap)" \
  --description="Extend ecmascript-globals.ts with DOM/BOM names (window, document, localStorage, AbortController, ...) so the TS resolver's targetsExternalImport correctly classifies browser-ambient calls as external. Motivated by the measured taxdome TS/React resolveSuccessRate gap (bareCall 0.53 vs tea-rags-mcp's own 0.98)." \
  --type=task --priority=2
bd label add <new-id> api
bd dep add <new-id> tea-rags-mcp-nl93h
```

After Task 1 lands: close `tea-rags-mcp-4008o` with a reason citing the case-7
commit and explicitly noting the `put`-style local-closure-homonym residual is
NOT closed (per the design doc's "does not close" section) — either leave a
comment on 4008o pointing at a fresh follow-up bead if the residual is worth
tracking separately, or close it as "ambient-global portion resolved;
local-closure-homonym residual is option 2, filed separately if pursued" per
this project's `worktree-beads-lifecycle.md` split-partial-work rule.

After Task 2 lands: close the new DOM/BOM bead citing its commit. Do NOT close
it on unit-test evidence claiming the taxdome gap is fixed — that requires the
live oracle re-measurement (user-gated, tracked as a separate follow-up per the
design doc's Sequencing section), not part of this plan.

---

## Self-Review Notes

- **Spec coverage:** Task 1 = design doc section "Revised mechanism" (case 7 +
  `BARE_GLOBAL_CALLABLES`). Task 2 = design doc section "DOM/BOM vocabulary
  extension". Sequencing section (wait for merge before oracle run) is respected
  — no Task in this plan touches taxdome or runs a reindex.
- **Placeholder scan:** none — every step has real code, real commands, real
  expected output.
- **Type consistency:** `CallRef.receiver: string | null` used consistently
  across both Tasks' tests, matching the existing
  `ts-builtin-receiver-guard.test.ts` fixtures read during planning.
  `BARE_GLOBAL_CALLABLES` name and shape (`ReadonlySet<string>`) consistent
  between Task 1's Step 3 (defines it) and Step 4 (imports and consumes it).
