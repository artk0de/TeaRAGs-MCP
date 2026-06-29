# Ruby `super` Module-Method MRO Resolution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve `super` written inside a method of a MODULE that is
included/prepended into classes (the 80% unresolved-super shape) via a
reverse-consensus fallback — recovering ~330–380 super edges across the corpus
suite at precision 1.0.

**Architecture:** `resolveSuper` keeps the existing class-keyed walk FIRST
(byte-identical). On a FULL miss (the module case: `classAncestors[M]` has no
usable ancestor) a NEW fallback resolves via a reverse include-by index
(`includedBy[X] = {classes that include/prepend X}`) — for each including class
C it finds the first definer of `member` AFTER X in C's prepend-aware MRO, and
emits an edge ONLY when every including class agrees on the same target
(consensus → precision 1.0; disagreement/empty → DROP, GUARD discipline).

**Tech Stack:** TypeScript, Vitest, the existing Ruby resolver
(`SymbolResolutionStrategy` chain), the codegraph provider's run-global ancestor
maps (`runAncestors`/`runPrependedAncestors`).

**Spec:**
`docs/superpowers/specs/2026-06-29-super-module-mro-resolution-design.md`

## Global Constraints

- ADDITIVE recall feature (NOT a relocation). STANDARD TDD: write the failing
  test FIRST, watch it fail, then minimal impl.
- The existing class-keyed super path is BYTE-IDENTICAL — the reverse path runs
  ONLY on a full class-keyed miss. Existing super tests (class-direct, prepend,
  runtime-hook suppression, anonymous-module-external) stay GREEN UNTOUCHED —
  they are the byte-identity oracle.
- Precision 1.0 / GUARD (bd jsa0/lttd): consensus (target invariant across all
  including classes) → resolve; disagree or empty → DROP. Never emit a
  non-invariant edge. `RUBY_RUNTIME_HOOKS` suppression applies to the new path
  too.
- Universal fallback, NO module-vs-class flag (sound for classes via
  consensus-drop).
- `resolver-architecture.md`: no god-class, no new walker emission (the index is
  DERIVED by inverting the existing run-global ancestor maps); `shared.ts` isHub
  backbone (`resolveInstanceMethodInClassChain`/`collectAncestorChain`) is
  additive-only — add a new function, do not mutate.
- Domain boundaries: the index inversion is language-agnostic → lives in
  `provider.ts` (trajectory), NOT in `domains/language` (provider must not
  import a ruby-resolver util).
- Each Task = its own commit (conventional commits; header ≤100, body/footer
  lines ≤100 — use `git commit -F <wrapped-msg-file>`). Gate between Tasks:
  `npx vitest run` (full suite) + `npx tsc --noEmit` both clean.
- Live-validate at the END (user-gated build+link+reconnect+reindex): super
  `inProjectEdgeRecall` before/after on huginn (0.44) + graphql (0.51); on all 4
  corpora the per-kind `resolved` for `super` only goes UP, every OTHER receiver
  kind unchanged (no precision regression).

---

## File Structure

| File                                                               | Responsibility                                                                                                | Task |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | ---- |
| `src/core/domains/trajectory/codegraph/symbols/provider.ts`        | pure `buildIncludedBy` inversion (lang-agnostic) + wire it into `resolveExtraction` + inject `ctx.includedBy` | 1, 4 |
| `src/core/domains/language/ruby/resolver/strategies/shared.ts`     | ADDITIVE `firstDefinerAfter` (first definer after X in C's prepend-aware MRO)                                 | 2    |
| `src/core/contracts/types/codegraph.ts`                            | `CallContext.includedBy` optional field                                                                       | 3    |
| `src/core/domains/language/ruby/resolver/strategies/ruby-super.ts` | reverse-consensus fallback in `resolveSuper`                                                                  | 3    |

Existing reused (NOT modified): `collectAncestorChain`,
`resolveInstanceMethodInClassChain`, `pickSingleCandidate` (shared.ts);
`RUBY_RUNTIME_HOOKS`, `SUPER_RECEIVER_SENTINEL` (ruby-super.ts / walker).

---

### Task 1: `buildIncludedBy` — pure reverse-ancestor inversion (provider)

**Files:**

- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` (add a
  module-level exported function near the top-level helpers, OUTSIDE the class)
- Test: `tests/core/domains/trajectory/codegraph/symbols/included-by.test.ts`
  (Create)

**Interfaces:**

- Produces:
  `export function buildIncludedBy(ancestors: Record<string, readonly string[]>, prepended: Record<string, readonly string[]>): Record<string, string[]>`
  — inverts both maps: for each child C and each ancestor A in `ancestors[C]` or
  `prepended[C]`, append C to `out[A]`. De-dups C per key. Used by Task 4.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/domains/trajectory/codegraph/symbols/included-by.test.ts
import { describe, expect, it } from "vitest";

import { buildIncludedBy } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/provider.js";

describe("buildIncludedBy — reverse include-by index (cai0/2oky5)", () => {
  it("inverts classAncestors: a module's including classes list it", () => {
    // PerfettoTrace included into two Trace subclasses; both list it.
    const ancestors = {
      "GraphQL::Tracing::PerfettoTraceA": [
        "PerfettoTrace",
        "GraphQL::Tracing::Trace",
      ],
      "GraphQL::Tracing::PerfettoTraceB": [
        "PerfettoTrace",
        "GraphQL::Tracing::Trace",
      ],
    };
    const out = buildIncludedBy(ancestors, {});
    expect(out["PerfettoTrace"]).toEqual([
      "GraphQL::Tracing::PerfettoTraceA",
      "GraphQL::Tracing::PerfettoTraceB",
    ]);
    expect(out["GraphQL::Tracing::Trace"]).toEqual([
      "GraphQL::Tracing::PerfettoTraceA",
      "GraphQL::Tracing::PerfettoTraceB",
    ]);
  });

  it("includes prepended modules (Wrapper prepended into Agent)", () => {
    const out = buildIncludedBy({}, { Agent: ["DryRunnable::Wrapper"] });
    expect(out["DryRunnable::Wrapper"]).toEqual(["Agent"]);
  });

  it("de-dups a child that lists the same ancestor via include AND prepend", () => {
    const out = buildIncludedBy({ C: ["M"] }, { C: ["M"] });
    expect(out["M"]).toEqual(["C"]);
  });

  it("returns an empty object for empty inputs", () => {
    expect(buildIncludedBy({}, {})).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/included-by.test.ts`
Expected: FAIL — `buildIncludedBy` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `provider.ts` as a module-level export (near other top-level helpers,
e.g. just above the `CodegraphEnrichmentProvider` class):

```ts
/**
 * Reverse include-by index (bd cai0/2oky5): invert the run-global ancestor maps
 * so `out[X]` lists every class that has X as a direct ancestor (via superclass,
 * include, or prepend). Language-agnostic — pure data inversion. Consumed by the
 * Ruby `super` module-method fallback to find the classes whose MRO a super call
 * inside module X dispatches through.
 */
export function buildIncludedBy(
  ancestors: Record<string, readonly string[]>,
  prepended: Record<string, readonly string[]>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (child: string, ancestor: string): void => {
    const list = (out[ancestor] ??= []);
    if (!list.includes(child)) list.push(child);
  };
  for (const [child, list] of Object.entries(ancestors))
    for (const a of list) add(child, a);
  for (const [child, list] of Object.entries(prepended))
    for (const a of list) add(child, a);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/included-by.test.ts`
Expected: PASS (4/4).

- [ ] **Step 5: Type-check + commit**

Run: `npx tsc --noEmit` → 0.

```bash
git add src/core/domains/trajectory/codegraph/symbols/provider.ts \
        tests/core/domains/trajectory/codegraph/symbols/included-by.test.ts
# commit message file (body ≤100/line) → git commit -F
git commit -F <msg>   # feat(trajectory): buildIncludedBy reverse-ancestor inversion (cai0/2oky5 Task 1)
```

---

### Task 2: `firstDefinerAfter` — first definer after X in C's prepend-aware MRO (shared.ts)

**Files:**

- Modify: `src/core/domains/language/ruby/resolver/strategies/shared.ts` (ADD a
  new exported function; do NOT touch `collectAncestorChain` /
  `resolveInstanceMethodInClassChain`)
- Test: `tests/core/domains/language/ruby/resolver/strategies/shared.test.ts`
  (Create if absent; else add a `describe`)

**Interfaces:**

- Consumes: `collectAncestorChain(klass, ctx, visited?)`,
  `resolveInstanceMethodInClassChain(klass, member, ctx, mode, visited)` (both
  existing in shared.ts), `pickSingleCandidate` (indirectly), `CallContext`,
  `SymbolResolutionTarget`, `AmbiguousResolveMode`.
- Produces:
  `export function firstDefinerAfter(startAfter: string, member: string, klass: string, ctx: CallContext, mode: AmbiguousResolveMode): SymbolResolutionTarget | null`
  — the first ancestor AFTER `startAfter` in `klass`'s prepend-aware MRO that
  defines `member` (method-level preferred, file-only fallback); `null` if
  `startAfter` is not in `klass`'s MRO or nothing after it defines `member`.
  Used by Task 3.

- [ ] **Step 1: Write the failing test**

```ts
// tests/core/domains/language/ruby/resolver/strategies/shared.test.ts
import { describe, expect, it } from "vitest";

import type { CallContext } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { firstDefinerAfter } from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/shared.js";
import { InMemoryGlobalSymbolTable } from "../../../../../../../src/core/domains/trajectory/codegraph/symbols/symbol-table.js";

// Minimal CallContext for resolver-strategy unit tests. classAncestors maps a
// class to its declaration-order ancestors; symbolTable resolves member defs.
function ctxOf(opts: {
  classAncestors?: Record<string, readonly string[]>;
  classPrependedAncestors?: Record<string, readonly string[]>;
  // fqClassName → relPath it is declared in (drives resolveConstant via fileScope)
  defs: { symbolId: string; relPath: string }[];
  fileScopes: Record<string, string[]>; // relPath → top-level constants it declares
}): CallContext {
  const symbolTable = new InMemoryGlobalSymbolTable();
  for (const d of opts.defs)
    symbolTable.add({ symbolId: d.symbolId, relPath: d.relPath } as never);
  for (const [relPath, scope] of Object.entries(opts.fileScopes)) {
    symbolTable.registerFileScope?.(relPath, scope);
  }
  return {
    callerFile: "caller.rb",
    callerScope: [],
    imports: [],
    symbolTable,
    classAncestors: opts.classAncestors,
    classPrependedAncestors: opts.classPrependedAncestors,
  } as unknown as CallContext;
}

describe("firstDefinerAfter — MRO after X (cai0/2oky5)", () => {
  it("finds the next definer after an INCLUDED module in C's ancestor chain", () => {
    // class C: ancestors [M, Base]; Base defines `m`. super from M#m → Base#m.
    const ctx = ctxOf({
      classAncestors: { C: ["M", "Base"] },
      defs: [{ symbolId: "Base#m", relPath: "base.rb" }],
      fileScopes: { "base.rb": ["Base"], "m.rb": ["M"], "c.rb": ["C"] },
    });
    const t = firstDefinerAfter("M", "m", "C", ctx, "strict");
    expect(t).toEqual({ targetRelPath: "base.rb", targetSymbolId: "Base#m" });
  });

  it("skips PAST a prepended module to the class itself (Wrapper → Agent)", () => {
    // Agent prepends Wrapper; Agent defines `save`. super from Wrapper#save → Agent#save.
    const ctx = ctxOf({
      classPrependedAncestors: { Agent: ["Wrapper"] },
      defs: [{ symbolId: "Agent#save", relPath: "agent.rb" }],
      fileScopes: { "agent.rb": ["Agent"], "wrapper.rb": ["Wrapper"] },
    });
    const t = firstDefinerAfter("Wrapper", "save", "Agent", ctx, "strict");
    expect(t).toEqual({
      targetRelPath: "agent.rb",
      targetSymbolId: "Agent#save",
    });
  });

  it("returns null when startAfter is not in klass's MRO", () => {
    const ctx = ctxOf({
      classAncestors: { C: ["Base"] },
      defs: [{ symbolId: "Base#m", relPath: "base.rb" }],
      fileScopes: { "base.rb": ["Base"], "c.rb": ["C"] },
    });
    expect(firstDefinerAfter("NotInChain", "m", "C", ctx, "strict")).toBeNull();
  });
});
```

> NOTE for the implementer: the exact `InMemoryGlobalSymbolTable` seeding API
> (`add` / `registerFileScope` / how `resolveConstant` maps a const to a file)
> must match the existing strategy tests — read
> `tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts` and
> mirror its `CallContext` + symbol-table construction. Adjust the `ctxOf`
> helper above to the real API; keep the three behavioral assertions
> (included-module next-definer, prepend-skip, not-in-chain→null) intact.

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/shared.test.ts`
Expected: FAIL — `firstDefinerAfter` is not exported.

- [ ] **Step 3: Write minimal implementation**

Add to `shared.ts` (new exported function; backbone untouched):

```ts
/**
 * The first ancestor AFTER `startAfter` in `klass`'s prepend-aware MRO that
 * defines `member` (bd cai0/2oky5). Linearizes `klass` as
 * `[reverse(prepended), klass, ...collectAncestorChain(klass)]`, finds
 * `startAfter`, and walks the remainder via `resolveInstanceMethodInClassChain`
 * with a `visited` set pre-seeded up to and including `startAfter` so nothing at
 * or before it is re-walked. Method-level pin wins; file-only is the fallback.
 * Returns `null` when `startAfter` is not in the MRO or nothing after it defines
 * `member`. Backbone-additive — reuses the existing chain walk, does not mutate it.
 */
export function firstDefinerAfter(
  startAfter: string,
  member: string,
  klass: string,
  ctx: CallContext,
  mode: AmbiguousResolveMode,
): SymbolResolutionTarget | null {
  const prepended = [...(ctx.classPrependedAncestors?.[klass] ?? [])].reverse();
  const mro = [...prepended, klass, ...collectAncestorChain(klass, ctx)];
  const idx = mro.indexOf(startAfter);
  if (idx === -1) return null;
  const visited = new Set<string>(mro.slice(0, idx + 1));
  let fileOnlyFallback: SymbolResolutionTarget | null = null;
  for (let i = idx + 1; i < mro.length; i++) {
    const t = resolveInstanceMethodInClassChain(
      mro[i],
      member,
      ctx,
      mode,
      visited,
    );
    if (t === null) continue;
    if (t.targetSymbolId !== null) return t;
    if (fileOnlyFallback === null) fileOnlyFallback = t;
  }
  return fileOnlyFallback;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/shared.test.ts`
Expected: PASS (3/3).

- [ ] **Step 5: Type-check + commit**

Run: `npx tsc --noEmit` → 0.

```bash
git add src/core/domains/language/ruby/resolver/strategies/shared.ts \
        tests/core/domains/language/ruby/resolver/strategies/shared.test.ts
git commit -F <msg>   # feat(trajectory): firstDefinerAfter MRO-after-X helper (cai0/2oky5 Task 2)
```

---

### Task 3: reverse-consensus fallback in `resolveSuper` + the `includedBy` field

**Files:**

- Modify: `src/core/contracts/types/codegraph.ts` (add `CallContext.includedBy`)
- Modify: `src/core/domains/language/ruby/resolver/strategies/ruby-super.ts`
  (add the fallback; the existing class-keyed walk stays byte-identical)
- Test:
  `tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts` (add
  a `describe` for the module-super reverse path; do NOT modify existing cases)

**Interfaces:**

- Consumes: `firstDefinerAfter` (Task 2), `ctx.includedBy` (the field added
  here, populated by Task 4), `RUBY_RUNTIME_HOOKS`.
- Produces: behavior only — `resolveSuper` resolves module-method super via
  consensus across `ctx.includedBy[enclosingClass]`.

- [ ] **Step 1: Add the field (contracts), no behavior yet**

In `codegraph.ts`, beside `classPrependedAncestors` (~line 807) add:

```ts
  /**
   * Optional reverse include-by index (bd cai0/2oky5): `fqName → classes that
   * have it as a direct ancestor` (superclass/include/prepend). Derived by the
   * provider from the run-global ancestor maps and injected for pass-2. The Ruby
   * `super` strategy reads `includedBy[M]` to resolve a `super` inside module
   * M's method against each including class's MRO-after-M (consensus). Plain
   * Record for NDJSON-spill parity with the other ancestor maps.
   */
  includedBy?: Record<string, readonly string[]>;
```

- [ ] **Step 2: Write the failing tests (the recall behavior)**

Add to `strategies.test.ts` a new `describe` (mirror the existing
`RubySuperSymbolResolutionStrategy` setup — read it first for the exact
`CallContext` + symbol-table construction and the `SUPER_RECEIVER_SENTINEL`
CallRef shape):

```ts
describe("RubySuperSymbolResolutionStrategy — module-method super (cai0/2oky5)", () => {
  // CONVERGENT multi-include: module M `def m; super; end` is included by two
  // classes A and B, both with the SAME next-after-M = Base#m → resolve Base#m.
  it("resolves module super to the consensus target when including classes agree", () => {
    // Build ctx: classAncestors A:[M,Base], B:[M,Base]; Base defines m;
    // includedBy M:[A,B]. classAncestors[M] empty → class-keyed walk misses.
    // super CallRef: receiver=SUPER_RECEIVER_SENTINEL, member="m", callerScope=["M"].
    // EXPECT resolved → Base#m.
  });

  // DIVERGENT: A's next-after-M = Base1#m, B's = Base2#m → DROP (precision guard).
  it("drops module super when including classes disagree on the target", () => {
    // includedBy M:[A,B]; A:[M,Base1], B:[M,Base2]; Base1#m and Base2#m distinct.
    // EXPECT DROP (outcome is DROP, no edge).
  });

  // No including class → DROP.
  it("drops module super when the module has no including class", () => {
    // includedBy M absent / empty. EXPECT DROP.
  });

  // PREPEND: Wrapper prepended into Agent, super from Wrapper#save → Agent#save.
  it("resolves prepended-module super to the prepending class", () => {
    // classPrependedAncestors Agent:[Wrapper]; includedBy Wrapper:[Agent];
    // Agent defines save. callerScope=["Wrapper"], member="save". EXPECT Agent#save.
  });
});
```

> Fill each test body using the EXISTING super-test harness in this file (the
> class-direct super tests already construct a `CallContext` + symbol table and
> call `new RubySuperSymbolResolutionStrategy(cfg).attempt(callRef, ctx)`).
> Assert on the returned `SymbolResolutionOutcome` (resolved target vs DROP) the
> same way the existing cases do.

- [ ] **Step 3: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts -t "module-method super"`
Expected: FAIL — the convergent/prepend cases DROP today (no fallback); confirm
the failure reason is "expected resolved, got DROP" (not a fixture error).

- [ ] **Step 4: Write minimal implementation**

In `ruby-super.ts`: import `firstDefinerAfter` from `./shared.js`. In
`resolveSuper`, AFTER the existing `for (const ancestor of ancestors)` loop and
BEFORE the runtime-hook tail, add the reverse-consensus fallback gated on a FULL
class-keyed miss (`fileOnlyFallback === null`). Add the private
`resolveViaIncludingClasses` method.

Replace the tail of `resolveSuper` (currently lines ~102–107) with:

```ts
    // Class-keyed walk fully missed — the module-method case: `super` lives in a
    // module M whose own ancestors don't define `member`. Resolve via the classes
    // that include/prepend M (ctx.includedBy), taking the target that is INVARIANT
    // across all of them (consensus → precision 1.0; disagreement → drop).
    // bd cai0/2oky5.
    if (fileOnlyFallback === null && !RUBY_RUNTIME_HOOKS.has(member)) {
      const consensus = this.resolveViaIncludingClasses(enclosingClass, member, ctx);
      if (consensus) return consensus;
    }
    if (fileOnlyFallback !== null && RUBY_RUNTIME_HOOKS.has(member)) return null;
    return fileOnlyFallback;
  }

  /**
   * Reverse-consensus resolution for `super` inside a MODULE method (bd cai0/2oky5).
   * For each class C that includes/prepends `moduleName`, find the first definer
   * of `member` AFTER `moduleName` in C's MRO. Emit an edge ONLY when every
   * including class agrees on the same target (precision 1.0); disagreement or an
   * empty set DROPs (returns null). Targets agree iff their `targetSymbolId` is
   * equal, or both are file-only with the same `targetRelPath`.
   */
  private resolveViaIncludingClasses(
    moduleName: string,
    member: string,
    ctx: CallContext,
  ): SymbolResolutionTarget | null {
    const including = ctx.includedBy?.[moduleName];
    if (!including || including.length === 0) return null;
    let agreed: SymbolResolutionTarget | null = null;
    for (const klass of including) {
      const t = firstDefinerAfter(moduleName, member, klass, ctx, this.cfg.mode);
      if (t === null) continue;
      if (agreed === null) {
        agreed = t;
        continue;
      }
      const same =
        agreed.targetSymbolId !== null || t.targetSymbolId !== null
          ? agreed.targetSymbolId === t.targetSymbolId
          : agreed.targetRelPath === t.targetRelPath;
      if (!same) return null; // including classes disagree → DROP (GUARD)
    }
    return agreed;
  }
```

Add the import at the top of `ruby-super.ts`:
`import { firstDefinerAfter, resolveInstanceMethodInClassChain, type ResolverConfig } from "./shared.js";`
(extend the existing `./shared.js` import — keep
`resolveInstanceMethodInClassChain`).

- [ ] **Step 5: Run the new + existing super tests**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts`
Expected: PASS — the 4 new module-super cases GREEN; ALL pre-existing
`RubySuperSymbolResolutionStrategy` cases still GREEN (byte-identity oracle).

- [ ] **Step 6: Full ruby resolver regression + type-check**

Run:
`npx vitest run tests/core/domains/language/ruby tests/core/domains/trajectory/codegraph`
Run: `npx tsc --noEmit` Expected: all green, tsc 0. (Existing super tests in
`ruby-resolver.test.ts` unchanged.)

- [ ] **Step 7: Commit**

```bash
git add src/core/contracts/types/codegraph.ts \
        src/core/domains/language/ruby/resolver/strategies/ruby-super.ts \
        tests/core/domains/language/ruby/resolver/strategies/strategies.test.ts
git commit -F <msg>   # feat(trajectory): reverse-consensus module-method super resolution (cai0/2oky5 Task 3)
```

---

### Task 4: wire `buildIncludedBy` into the provider + e2e validation

**Files:**

- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts`
  (`resolveExtraction`, ~line 1850–1934: derive `includedByForResolver` beside
  `ancestorsForResolver`; inject `includedBy` into BOTH per-call ctx sites at
  ~1883 and ~1921)
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/super-module-mro.test.ts`
  (Create)

**Interfaces:**

- Consumes: `buildIncludedBy` (Task 1), the existing `ancestorsForResolver` /
  `prependedAncestorsForResolver` locals in `resolveExtraction`.
- Produces: `ctx.includedBy` populated on every resolve call.

- [ ] **Step 1: Write the failing e2e test**

```ts
// tests/core/domains/trajectory/codegraph/symbols/super-module-mro.test.ts
// Mirror the beforeEach harness of resolve-regression-gate.test.ts /
// inproject-edge-recall.test.ts (DuckDbGraphClient + runMigrations +
// CodegraphEnrichmentProvider + buildTestCodegraphDeps([["ruby", new RubyCallResolver(...)]])).
// Fixture (real .rb files written to a tmp root):
//   base.rb:    class Base;     def m; end; end
//   tracer.rb:  module Tracer;  def m; super; end; end          # module-method super
//   a.rb:       class A < Base; include Tracer; end
//   b.rb:       class B < Base; include Tracer; end
// Expectation: Tracer#m's `super` resolves to Base#m (consensus across A and B);
// the cg_symbols super edge for Tracer#m has targetSymbolId "Base#m"
// (or, via getRunMetrics, the `super` receiverKind has resolved >= 1).
it("resolves a module-method super to the consensus base across including classes", async () => {
  // writeFixture(root); streamFileBatch + finalizeSignals;
  // assert via client.getRunStats() ruby `super` row: resolved >= 1
  // OR query the edge for Tracer#m and assert targetSymbolId === "Base#m".
});
```

> Use the SAME provider/fixture harness as `resolve-regression-gate.test.ts`.
> The assertion may read the persisted super edge or the per-kind `super` tally
> — pick whichever the existing codegraph e2e tests use for edge-level
> assertions and mirror it exactly.

- [ ] **Step 2: Run to verify it fails**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/super-module-mro.test.ts`
Expected: FAIL — `super` for `Tracer#m` is unresolved (ctx.includedBy is
undefined → the Task-3 fallback finds no including classes).

- [ ] **Step 3: Wire `buildIncludedBy` into `resolveExtraction`**

In `provider.ts` `resolveExtraction`, right after `ancestorsForResolver` and
`prependedAncestorsForResolver` are computed (~line 1853), add:

```ts
const includedByForResolver = buildIncludedBy(
  ancestorsForResolver,
  prependedAncestorsForResolver,
);
```

Then add `includedBy: includedByForResolver` to BOTH per-call `CallContext`
object literals (beside `classPrependedAncestors`) — the one at ~line 1883–1884
and the one at ~line 1921–1922:

```ts
      classAncestors: ancestorsForResolver,
      classPrependedAncestors: prependedAncestorsForResolver,
      includedBy: includedByForResolver,
```

No new provider field and no new reset site are required — `includedBy` is
DERIVED from `runAncestors`/`runPrependedAncestors`, which are already reset at
every existing reset site.

- [ ] **Step 4: Run the e2e + full codegraph suite**

Run:
`npx vitest run tests/core/domains/trajectory/codegraph/symbols/super-module-mro.test.ts`
Expected: PASS — `Tracer#m`'s super resolves to `Base#m`.

Run: `npx vitest run tests/core/domains/trajectory/codegraph` Expected: all
green (no regression on the existing resolve-regression-gate / run-stats /
recall suites).

- [ ] **Step 5: Type-check + commit**

Run: `npx tsc --noEmit` → 0.

```bash
git add src/core/domains/trajectory/codegraph/symbols/provider.ts \
        tests/core/domains/trajectory/codegraph/symbols/super-module-mro.test.ts
git commit -F <msg>   # feat(trajectory): inject reverse include-by index into resolve context (cai0/2oky5 Task 4)
```

---

## Final gate (after all 4 Tasks)

- [ ] `npx vitest run` (full suite) → all green.
- [ ] `npx tsc --noEmit` → 0.
- [ ] Whole-branch review (subagent-driven final review).
- [ ] **Live validation (USER-GATED — ask before build+reindex):**
      `npm run build && npm link`, ask for `/mcp reconnect`, reindex huginn +
      graphql-ruby, then `get_index_status`: `super` `inProjectEdgeRecall` UP
      from huginn 0.44 / graphql 0.51; on all 4 corpora the per-kind `resolved`
      for `super` only rises, every other receiver kind unchanged (no precision
      regression). Commit is auto-authorized once live validation succeeds.

## Notes / risks

- `ruby-super.ts` has bugFixRate 67 (critical) — keep the change SURGICAL (the
  fallback is a tail addition; the existing loop is untouched) and lean on the
  existing super tests as the byte-identity oracle.
- `shared.ts` is the isHub MRO backbone — `firstDefinerAfter` is a NEW function;
  `collectAncestorChain` / `resolveInstanceMethodInClassChain` are NOT modified.
- The reverse path fires ONLY on a full class-keyed miss → zero regression risk
  on the 20% class-direct super and on self/bareCall (which share the backbone).
