# Ruby Honest Resolve Denominator — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reclassify unresolved Ruby calls into external / unresolvable /
internal-miss so the codegraph `resolveSuccessRate` measures real
project-internal resolver capability, and resolve `send(:literal)` / `&:sym`
shorthands.

**Architecture:** Phase 1 extends the resolver's `targetsExternalImport` with
catalogue-derived + curated Rails-runtime external classification
(resolver-only). Phase 2 adds walker send/symbol-proc handling (rewrite literal
targets to resolvable CallRefs; tag dynamic send) plus a new `callsUnresolvable`
counter threaded through the run-stats path, with the denominator subtracting
it.

**Tech Stack:** TypeScript (ESM, `.js` suffixes), tree-sitter-ruby, DuckDB
(cg_run_stats), vitest.

## Global Constraints

- Spec:
  `docs/superpowers/specs/2026-06-22-ruby-honest-resolve-denominator-design.md`
  (committed `130eff1c`).
- Worktree `.claude/worktrees/ruby-dsl-decomposition`, branch
  `worktree-ruby-dsl-decomposition`, base local main `2b5e3460`.
- Tests: `npx vitest run`. Type check: `npm run build` (tsc must be 0).
  Pre-commit runs tests + coverage + type-check.
- `resolveSuccessRate = callsResolved / max(1, callsAttempted − callsExternalSkipped − callsUnresolvable)`.
  Unresolvable is a NEW exclusion alongside externalSkipped (ykj7).
- ykj7 chain-order invariant: `targetsExternalImport` is reached ONLY by calls
  the strategy chain left unresolved, so a project method shadowing a framework
  name resolves first and is never mis-marked external.
- `CallResolver` contract (5 languages) is NOT touched. `CallRef.dynamicSend?`
  is additive and codegraph-internal; the walker sets it.
- Domain rule: `resolver/ → dsl/` import is same-domain, allowed.
  `domains/language/` is a leaf (imports only contracts/infra).
- Business-logic tests immutable (move OK, rewrite NO). New tests freely added.
- Conventional commits: `improve(trajectory)` / `feat(trajectory)`; header ≤ 100
  chars; silo-pairing `Why:` line (ruby-resolver.ts hub fanIn 9; walker.ts
  god-function; status-module deep-silo). Co-Authored-By trailer.
- Each phase = its own commit + beads task under `cai0`/`duzy`. Live-validate
  each phase ALONE on huginn, attribute deltas via byReceiverKind.

## Current state (ground truth)

- `ruby-resolver.ts:124` `targetsExternalImport`:
  `if (receiver === null) return RUBY_KERNEL_BUILTINS.has(call.member); if (!/^[A-Z]/.test(receiver)) return false; return resolveConstant(receiver, ctx) === null;`
- `kernel-builtins.ts`:
  `export const RUBY_KERNEL_BUILTINS = new Set<string>([... 81 names ...]);`
  (the pattern to mirror).
- `CallRef` (`contracts/types/codegraph.ts:451`):
  `{ callText, receiver: string|null, member, startLine, dispatch?, dispatchArgs? }`
  — NO call arguments.
- `ResolveRunStatsRow` (`codegraph.ts:985`):
  `{ language, receiverKind, attempted, resolved, externalSkipped }`.
- `status-module.ts:37`
  `resolveRate(attempted, resolved, externalSkipped) = attempted===0 ? 0 : resolved / Math.max(1, attempted - externalSkipped)`.
  `ResolveTally` (`:45`) = `{ attempted, resolved, externalSkipped }`.
  `buildByReceiverKind` (`:55`) + the byLanguage aggregation (`:97-131`)
  accumulate `externalSkipped`. `CodegraphResolveKindRow` is the DTO (in
  `src/core/types.ts`).
- Provider run-stats:
  `byLanguageKind: Map<lang, Record<ReceiverKind, ReceiverKindTally>>`
  accumulated in `provider.ts` and persisted as `ResolveRunStatsRow[]` via
  `recordRunStats`. `ReceiverKindTally` mirrors
  `{ attempted, resolved, externalSkipped }`.

---

# PHASE 1 — External classification (resolver-only)

Beads: create task under `cai0`/`duzy`, in_progress.

### Task 1.1: RAILS_RUNTIME_BUILTINS list

**Files:**

- Create: `src/core/domains/language/ruby/resolver/rails-runtime-builtins.ts`
- Test:
  `tests/core/domains/language/ruby/resolver/rails-runtime-builtins.test.ts`

**Interfaces:**

- Produces: `export const RAILS_RUNTIME_BUILTINS: ReadonlySet<string>`.

- [ ] **Step 1: Write the failing test**

```ts
// rails-runtime-builtins.test.ts
import { describe, expect, it } from "vitest";

import { RAILS_RUNTIME_BUILTINS } from "../../../../../../src/core/domains/language/ruby/resolver/rails-runtime-builtins.js";

describe("RAILS_RUNTIME_BUILTINS", () => {
  it("contains representative controller / ActiveSupport instance helpers", () => {
    for (const m of [
      "params",
      "render",
      "redirect_to",
      "head",
      "respond_to",
      "t",
      "flash",
    ]) {
      expect(RAILS_RUNTIME_BUILTINS.has(m), m).toBe(true);
    }
  });
  it("does NOT contain DSL macro keywords (those are catalogue-derived) or project names", () => {
    for (const m of ["has_many", "validates", "create_event", "log"]) {
      expect(RAILS_RUNTIME_BUILTINS.has(m), m).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run, verify fail** —
      `npx vitest run tests/core/domains/language/ruby/resolver/rails-runtime-builtins.test.ts`
      → FAIL (module not found).

- [ ] **Step 3: Implement** (mirror `kernel-builtins.ts` shape + doc):

```ts
/**
 * Rails controller / ActiveSupport INSTANCE helper methods that exist on a
 * framework base class (ActionController::Base, ActiveSupport) with NO project
 * `def` — a no-receiver call to one of these is a framework runtime call, not a
 * project-internal miss. Consumed by `ruby-resolver.ts:targetsExternalImport`
 * to exclude such calls from the resolveSuccessRate denominator (bd cai0,
 * mirrors the ykj7 RUBY_KERNEL_BUILTINS pattern). DSL class-body MACROS
 * (has_many/validates/...) are classified separately via the RUBY_DSL catalogue
 * — they are NOT listed here.
 *
 * Chain-order safety: a project method that shadows one of these names resolves
 * first via the strategy chain and never reaches the external classifier, so
 * this set never mis-marks a real project method (bd 5os8y).
 */
export const RAILS_RUNTIME_BUILTINS: ReadonlySet<string> = new Set<string>([
  // ActionController request/response surface
  "params",
  "render",
  "redirect_to",
  "redirect_back",
  "head",
  "respond_to",
  "respond_with",
  "flash",
  "session",
  "cookies",
  "request",
  "response",
  "url_for",
  "polymorphic_url",
  "send_data",
  "send_file",
  // ActionController class-config callable as instance (rare) + view helpers
  "helper_method",
  "layout",
  "rescue_from",
  // ActiveSupport / i18n runtime
  "t",
  "l",
  "logger",
]);
```

- [ ] **Step 4: Run, verify pass** —
      `npx vitest run tests/core/domains/language/ruby/resolver/rails-runtime-builtins.test.ts`
      → PASS.

### Task 1.2: Extend targetsExternalImport (catalogue + rails-runtime)

**Files:**

- Modify: `src/core/domains/language/ruby/resolver/ruby-resolver.ts` (imports +
  `targetsExternalImport`)
- Test:
  `tests/core/domains/language/ruby/resolver/ruby-resolver-external-import.test.ts`

**Interfaces:**

- Consumes: `RAILS_RUNTIME_BUILTINS` (Task 1.1), `RUBY_DSL` (`../dsl/index.js`).

- [ ] **Step 1: Write the failing test** (append to the existing external-import
      test file — new cases, no rewrite of existing):

```ts
describe("targetsExternalImport — catalogue + rails-runtime external (cai0)", () => {
  const r = new RubyCallResolver();
  const ctx = makeCtx(); // reuse the file's existing context helper

  it("no-receiver DSL macro keyword is external (catalogue-derived)", () => {
    for (const m of [
      "has_many",
      "validates",
      "scope",
      "before_save",
      "delegate",
    ]) {
      expect(
        r.targetsExternalImport(
          { callText: m, receiver: null, member: m, startLine: 1 },
          ctx,
        ),
        m,
      ).toBe(true);
    }
  });
  it("no-receiver Rails runtime helper is external", () => {
    for (const m of ["params", "render", "redirect_to", "t"]) {
      expect(
        r.targetsExternalImport(
          { callText: m, receiver: null, member: m, startLine: 1 },
          ctx,
        ),
        m,
      ).toBe(true);
    }
  });
  it("no-receiver unknown project method is NOT external", () => {
    expect(
      r.targetsExternalImport(
        {
          callText: "do_work",
          receiver: null,
          member: "do_work",
          startLine: 1,
        },
        ctx,
      ),
    ).toBe(false);
  });
  it("receiver-qualified call is unaffected by the new branches", () => {
    // lowercase receiver → still false (project-internal candidate)
    expect(
      r.targetsExternalImport(
        {
          callText: "x.has_many",
          receiver: "x",
          member: "has_many",
          startLine: 1,
        },
        ctx,
      ),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run, verify fail** —
      `npx vitest run tests/core/domains/language/ruby/resolver/ruby-resolver-external-import.test.ts`
      → FAIL (DSL/rails names return false today).

- [ ] **Step 3: Implement** — add imports at top of `ruby-resolver.ts`:

```ts
import { RUBY_DSL } from "../dsl/index.js";
import { RAILS_RUNTIME_BUILTINS } from "./rails-runtime-builtins.js";
```

Replace the `receiver === null` line in `targetsExternalImport`:

```ts
// A bare (no-receiver) call is external if it is a Ruby core builtin (ykj7),
// a class-body DSL macro keyword (framework macro, catalogue-derived), or a
// curated Rails controller/ActiveSupport runtime helper. All three have zero
// project defs; a project method shadowing the name resolves first via the
// chain and never reaches this hook (bd 5os8y / cai0).
if (receiver === null) {
  return (
    RUBY_KERNEL_BUILTINS.has(call.member) ||
    call.member in RUBY_DSL ||
    RAILS_RUNTIME_BUILTINS.has(call.member)
  );
}
```

- [ ] **Step 4: Run, verify pass** —
      `npx vitest run tests/core/domains/language/ruby/resolver` → PASS.

- [ ] **Step 5: Build + full ruby/codegraph green** —
      `npm run build && npx vitest run tests/core/domains/language/ruby tests/core/domains/trajectory/codegraph`
      → tsc 0, all PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/language/ruby/resolver/rails-runtime-builtins.ts \
        src/core/domains/language/ruby/resolver/ruby-resolver.ts tests/core/domains/language/ruby/resolver/
git commit -m "improve(trajectory): classify ruby framework bareCalls (DSL macros + rails runtime) as external

Why: ~550-850 huginn bareCalls are framework methods with zero project defs
(has_many/validates/params/render) counted as project misses; reclassify them as
externalSkipped via the catalogue + a curated rails-runtime list (ykj7 pattern,
chain-order safe). Honest denominator, not new resolution.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 1.3: Phase 1 live validation (huginn)

- [ ] **Step 1: Build + link** — `npm run build && npm link` (global already
      points at this worktree).
- [ ] **Step 2: Kill stale procs** —
      `pkill -9 -f "tea-rags server"; pkill -9 -f "chunker/infra/worker.js"; pkill -9 -f "duckdb/daemon/entry"`
      (keep qdrant).
- [ ] **Step 3: Ask the user to `/mcp reconnect tea-rags`** (manual). Wait.
- [ ] **Step 4: Force-reindex + read** —
      `mcp__tea-rags__index_codebase project=huginn forceReindex=true`; wait for
      enrichment; `mcp__tea-rags__get_index_status project=huginn`.
- [ ] **Step 5: Record delta** — ruby `bareCall`: `externalSkipped` should jump
      from 269 by ~550-850; `resolveSuccessRate` bareCall ~0.539 → ~0.65-0.72.
      Confirm `resolved` is ~unchanged (this is denominator correction, not new
      resolution). Comment the before/after on the beads task.

Beads: close the Phase 1 task.

---

# PHASE 2 — send / symbol-proc + callsUnresolvable counter

Beads: create Phase 2 task under `cai0`/`duzy`, in_progress.

### Task 2.1: Additive contract — CallRef.dynamicSend + run-stats unresolvable

**Files:**

- Modify: `src/core/contracts/types/codegraph.ts` (`CallRef`,
  `ResolveRunStatsRow`)

**Interfaces:**

- Produces: `CallRef.dynamicSend?: boolean`;
  `ResolveRunStatsRow.unresolvable: number`.

- [ ] **Step 1: Add `dynamicSend` to `CallRef`** (after `dispatchArgs`):

```ts
  /**
   * Set by the walker when this call is a dynamic dispatch whose target is NOT a
   * statically-known literal — `send(var)` / `public_send(expr)` / `__send__(x)`
   * with a non-literal first argument. The codegraph counts an UNRESOLVED
   * dynamicSend as `callsUnresolvable` (statically undeterminable), excluded from
   * the resolveSuccessRate denominator — distinct from `externalSkipped`
   * (framework) and from a genuine internal miss (bd cai0).
   */
  dynamicSend?: boolean;
```

- [ ] **Step 2: Add `unresolvable` to `ResolveRunStatsRow`** (after
      `externalSkipped`):

```ts
/**
 * bd cai0 — of the `attempted − resolved` misses in this bucket, how many were
 * statically UNDETERMINABLE (dynamic `send(var)`), not resolver failures. Like
 * `externalSkipped`, excluded from the resolveSuccessRate denominator. Defaults
 * to 0 for pre-cai0 rows / languages without dynamic-send tagging.
 */
unresolvable: number;
```

- [ ] **Step 3: Build** — `npm run build`. Expect tsc errors at every
      `ResolveRunStatsRow` literal that now lacks `unresolvable` (provider,
      status-module, migrations, tests). These are fixed in Tasks 2.4/2.5 — note
      them; this task's deliverable is the contract.
- [ ] **Step 4: Commit** the contract additions once Tasks 2.4/2.5 compile
      (commit 2.1–2.5 together at 2.5; OR add `unresolvable: 0` defaults inline
      here to keep tsc green and commit standalone). PREFER: keep tsc green —
      add `unresolvable: 0` at each existing literal in this task, then 2.4/2.5
      set real values.

### Task 2.2: Walker 2a — resolve send-literal + &:sym

**Files:**

- Modify: `src/core/domains/language/ruby/walker/walker.ts` (`collectRubyCalls`)
- Test: `tests/core/domains/language/ruby/walker/ruby-walker.test.ts` (new
  cases)

**Interfaces:**

- Consumes: `CallRef` shape.

- [ ] **Step 1: Write failing tests** — parse a method body, assert the emitted
      CallRefs:

```ts
it("send(:foo) emits a CallRef member=foo (literal target, self receiver)", () => {
  const calls = collectCallsFromRuby(
    "class A\n  def go; send(:foo); end\nend\n",
  ); // reuse the file's call-extraction helper
  expect(calls.some((c) => c.receiver === null && c.member === "foo")).toBe(
    true,
  );
  expect(calls.some((c) => c.member === "send")).toBe(false); // send itself is replaced
});
it("obj.send(:bar) emits member=bar with receiver=obj", () => {
  const calls = collectCallsFromRuby(
    "class A\n  def go; obj.send(:bar); end\nend\n",
  );
  expect(calls.some((c) => c.receiver === "obj" && c.member === "bar")).toBe(
    true,
  );
});
it("x.map(&:name) emits a CallRef member=name", () => {
  const calls = collectCallsFromRuby(
    "class A\n  def go; x.map(&:name); end\nend\n",
  );
  expect(calls.some((c) => c.member === "name")).toBe(true);
});
```

- [ ] **Step 2: Run, verify fail** — those CallRefs are not emitted today.

- [ ] **Step 3: Implement** in `collectRubyCalls` — a SURGICAL branch where call
      expressions are turned into `CallRef`s. When the method name is
      `send`/`__send__`/`public_send` AND the first argument node is a literal
      `simple_symbol`/`string`, emit the CallRef with `member` = the literal
      name (strip `:`/quotes via the same `literalNameFromArg` helper used in
      macro-expansion), `receiver` = the send's own receiver (or `null`),
      instead of emitting a call to `send`. Separately, when scanning argument
      nodes, a `block_argument` / `&` symbol-to-proc (`&:name`) emits a CallRef
      `{ receiver: null, member: name, ... }`. Do NOT alter the existing
      collection of other calls.

> Read the existing `collectRubyCalls` call-emission site first; add the branch
> adjacent to where a normal `method`/`call` node becomes a `CallRef`. Keep one
> CallRef per send site.

- [ ] **Step 4: Run, verify pass** + regression —
      `npx vitest run tests/core/domains/language/ruby/walker tests/core/domains/trajectory/codegraph`.
      The existing walker call-set tests MUST stay green (only additive
      send/&:sym CallRefs appear).

### Task 2.3: Walker 2b — tag dynamic send

**Files:**

- Modify: `src/core/domains/language/ruby/walker/walker.ts` (`collectRubyCalls`)
- Test: same walker test file (new cases)

- [ ] **Step 1: Write failing tests**

```ts
it("send(var) is tagged dynamicSend (non-literal arg)", () => {
  const calls = collectCallsFromRuby(
    "class A\n  def go(m); send(m); end\nend\n",
  );
  const c = calls.find((c) => c.member === "send" || c.dynamicSend);
  expect(c?.dynamicSend).toBe(true);
});
it("send(:literal) is NOT tagged dynamicSend", () => {
  const calls = collectCallsFromRuby(
    "class A\n  def go; send(:foo); end\nend\n",
  );
  expect(calls.every((c) => !c.dynamicSend)).toBe(true);
});
```

- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — in the same send branch: when the first arg is
      NON-literal (identifier / call / interpolation), emit the CallRef for
      `send` with `dynamicSend: true` (keep `member: "send"`, no rewrite). The
      literal case (Task 2.2) and the dynamic case (here) are the two arms of
      the send branch.
- [ ] **Step 4: Run, verify pass** + regression green.
- [ ] **Step 5: Commit Tasks 2.2+2.3**

```bash
git add src/core/domains/language/ruby/walker/walker.ts tests/core/domains/language/ruby/walker/ src/core/contracts/types/codegraph.ts
git commit -m "feat(trajectory): ruby walker resolves send-literal/&:sym, tags dynamic send

Why: send(:foo)/x.map(&:name) reference a real method by literal name (now a
resolved edge, previously send∈Kernel externalSkipped); send(var) is statically
undeterminable, tagged CallRef.dynamicSend for the unresolvable counter (cai0).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2.4: Provider — accumulate callsUnresolvable

**Files:**

- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` (resolve
  loop + run-stats accumulation + `ReceiverKindTally`)
- Test: `tests/core/domains/trajectory/codegraph/symbols/provider*.test.ts` (new
  case)

**Interfaces:**

- Consumes: `CallRef.dynamicSend`, `ResolveRunStatsRow.unresolvable`.

- [ ] **Step 1: Write failing test** — a fixture with `send(var)` produces a
      run-stats row whose `unresolvable` ≥ 1 and is NOT counted as a miss
      (resolved unchanged).
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** — find where the resolve loop tallies `attempted` /
      `resolved` / `externalSkipped` per call. Add: after a call fails to
      resolve, if `call.dynamicSend === true`, increment the tally's
      `unresolvable` (mirror the `externalSkipped` branch). Add
      `unresolvable: number` to `ReceiverKindTally` and the per-language tally;
      thread it into the emitted `ResolveRunStatsRow` (set `unresolvable`
      alongside `externalSkipped`). A call that is both external and dynamicSend
      counts external first (externalSkipped wins; they are mutually exclusive
      in practice — `send` is a Kernel builtin only when
      unresolved-and-not-rewritten, but a dynamicSend keeps member=`send`;
      ensure the dynamicSend check precedes or is exclusive — order:
      external-import check, then dynamicSend).

> NOTE precedence: `send` ∈ RUBY_KERNEL_BUILTINS. A `dynamicSend` call keeps
> `member: "send"`, so `targetsExternalImport` would mark it external. To count
> it as `unresolvable` (the honest category), the provider MUST check
> `dynamicSend` BEFORE `targetsExternalImport` for the unresolved-miss
> classification. Document this order in the loop.

- [ ] **Step 4: Run, verify pass** + `npm run build` (tsc 0).

### Task 2.5: status-module surface + denominator

**Files:**

- Modify: `src/core/domains/ingest/pipeline/status-module.ts` (`resolveRate`,
  `ResolveTally`, `buildByReceiverKind`, byLanguage aggregation)
- Modify: `src/core/types.ts` (`CodegraphResolveKindRow` + summary DTO — add
  `unresolvable`)
- Test: `tests/core/domains/ingest/pipeline/status-module.test.ts` (new cases;
  this file is artk0de deep-silo — owner review)

- [ ] **Step 1: Write failing test** — a `ResolveRunStatsRow` with
      `unresolvable: 5` yields a byReceiverKind row carrying `unresolvable: 5`
      and
      `resolveSuccessRate = resolved / max(1, attempted − externalSkipped − unresolvable)`.

- [ ] **Step 2: Run, verify fail.**

- [ ] **Step 3: Implement**:

```ts
// resolveRate — subtract unresolvable too
function resolveRate(
  attempted: number,
  resolved: number,
  externalSkipped: number,
  unresolvable: number,
): number {
  return attempted === 0
    ? 0
    : resolved / Math.max(1, attempted - externalSkipped - unresolvable);
}
```

Add `unresolvable: number` to `ResolveTally`; accumulate
`t.unresolvable += r.unresolvable` everywhere `externalSkipped` is accumulated
(byLanguage + byReceiverKind + the top-level totals); pass `unresolvable` into
every `resolveRate(...)` call; add `unresolvable` to the
`CodegraphResolveKindRow` output and to the summary (`callsUnresolvable`
alongside `callsExternalSkipped`). Add `unresolvable` to
`CodegraphResolveKindRow` in `src/core/types.ts`.

- [ ] **Step 4: Run, verify pass** + full build/test —
      `npm run build && npx vitest run tests/core/domains/ingest/pipeline/status-module.test.ts tests/core/domains/trajectory/codegraph`
      → tsc 0, PASS.

- [ ] **Step 5: Commit Tasks 2.1+2.4+2.5**

```bash
git add src/core/contracts/types/codegraph.ts src/core/domains/trajectory/codegraph/symbols/provider.ts \
        src/core/domains/ingest/pipeline/status-module.ts src/core/types.ts tests/
git commit -m "feat(trajectory): callsUnresolvable counter for dynamic send (honest resolve denominator)

Why: dynamic send(var) is statically undeterminable, not a resolver miss; count it
as callsUnresolvable, excluded from the resolveSuccessRate denominator alongside
externalSkipped, surfaced per receiver-kind in get_index_status (cai0).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2.6: Phase 2 live validation (huginn)

- [ ] Same reindex flow as Task 1.3 (build, kill stale procs, user reconnect,
      force_reindex huginn, read byReceiverKind).
- [ ] **Attribute separately:** ruby `bareCall`/`dynamic` — `resolved` rises by
      the send-literal/&:sym edges (2a, real resolution); a NEW `unresolvable`
      count appears for dynamic send (2b); `resolveSuccessRate` reflects the new
      denominator. Record before/after per bucket on the beads task.

Beads: close Phase 2 task.

---

## Self-Review

- **Spec coverage:** External catalogue+rails (Task 1.1/1.2) ✓;
  send-literal/&:sym resolution (2.2) ✓; dynamic-send unresolvable (2.3) ✓; new
  counter contract (2.1) + provider (2.4) + status-module denominator (2.5) ✓;
  live-validation per phase (1.3, 2.6) ✓; Non-Goals (store_accessor,
  method_missing) not implemented ✓; CallResolver contract untouched ✓
  (dynamicSend on CallRef, walker sets it).
- **Type consistency:** `CallRef.dynamicSend?: boolean`,
  `ResolveRunStatsRow.unresolvable: number`, `ResolveTally.unresolvable`,
  `CodegraphResolveKindRow.unresolvable`,
  `resolveRate(attempted, resolved, externalSkipped, unresolvable)` — names
  consistent across 2.1→2.5. `RAILS_RUNTIME_BUILTINS` consistent 1.1→1.2.
- **Placeholder scan:** the walker edit (2.2/2.3) says "read the existing
  call-emission site, add the branch adjacent" — concrete location named
  (`collectRubyCalls` call→CallRef site), reusing the named `literalNameFromArg`
  helper; the provider edit (2.4) names the exact tally branch to mirror
  (`externalSkipped`) + the precedence order. No `TBD`.
- **Precedence flagged (2.4):** `dynamicSend` classification MUST precede
  `targetsExternalImport` (send ∈ Kernel) — explicit in the task.

## Execution Handoff

Plan saved to
`docs/superpowers/plans/2026-06-22-ruby-honest-resolve-denominator-plan.md`.
