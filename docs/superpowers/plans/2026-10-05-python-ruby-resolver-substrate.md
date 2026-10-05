# Python ↔ Ruby resolver substrate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> (wraps superpowers:subagent-driven-development / executing-plans) to implement
> this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Lift the call-resolution mechanics Python and Ruby share into
`src/core/domains/language/kernel/` as engine + ports contracts, keep Ruby
byte-identical through the lift, then give Python every Ruby-parity mechanism
plus the Python-only mechanics that close the django oracle gap (676 rows).

**Architecture:** The kernel owns engines: step order, folds, declines, caps. A
language supplies ports (how to type a receiver, how to find a member on a type)
and data (vocabularies, gates, patterns). The central port is
`TypeMemberLookup`. Every lift is gated by an identity harness: the edge set and
the per-receiver-kind counters stay byte-identical on the Ruby and Python
corpora. Every Python increment is gated by the jedi oracle.

**Tech Stack:** TypeScript (strict), vitest, tree-sitter walkers, the offline
harnesses `scripts/codegraph-chain-tally.ts` and
`scripts/py-codegraph-jedi-oracle.ts`.

**Spec:**
`docs/superpowers/specs/2026-10-05-python-ruby-resolver-substrate-design.md`

## Global Constraints

- Base: `main` at or after `6d73a1197` (integration/arch-fixes landed).
  Integration branch: `integration/py-ruby-substrate`.
- Concurrency: at most **3 Opus subagents at a time**, each in its own worktree
  branched from `integration/py-ruby-substrate`. The orchestrator merges each
  agent branch into the integration branch with `--no-ff` after validating it.
- Tests per agent: **only related tests**:
  `npx vitest run <touched test files>`,
  `npx vitest related <touched src files> --run`, `npx tsc --noEmit`,
  `npx eslint <touched files>`, and the task's gate harness. The full suite runs
  only on the integration branch at the checkpoints marked **CHECKPOINT**.
- Self-review, **after the task**: once the task is implemented and its related
  tests are green, run the MCP tool `review_changes` with
  `changes: { base: "integration/py-ruby-substrate" }` and
  `path: <agent worktree>`, all sections. Fix every finding in your own diff,
  then re-run the related tests.
- Findings outside your diff:
  - non-Python → `bd create` a task, `bd dep add <new> tea-rags-mcp-0qaht`,
    label `architecture` or `dx`;
  - Python, outside your task → `bd create` a follow-up task under this
    program's epic (id in the Beads section).

  Name both in your report. Follow-ups are mandatory work, not backlog.

- Ruby business-logic tests are moved with their code and never rewritten. A
  lift that changes any Ruby edge or counter is a defect: revert it and report.
- Naming: `.claude/rules/naming.md`. Every new exported name is checked with
  `get_naming_lexicon` (`names: [{name, kind:"type", path}]`) before it lands.
  `MISFIT` → take the suggestion.
- Commits: conventional, scope `trajectory`, `refactor` for lifts and `feat` for
  new Python mechanics. Deep-silo files (all of `language/**`) need a `Why:`
  line (`silo-pairing.md`). Commit footer:
  `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Never `--no-verify`. Never push. Never reindex — wave 4 is user-gated.
- Fresh worktree: run `npm install`, `npx husky`, and `npm run build` once
  (unlinked) before the first vitest run. The chunker pool forks the compiled
  worker.
- Harness env: prefix commands with `NODE_OPTIONS=`, or the fish universal heap
  flag overrides worker ceilings.

---

## Gate definitions (referenced by tasks)

**G-RB (Ruby identity).** For each corpus in
`~/Dev/OpenSource/codegraph-test/{sinatra,octokit.rb,huginn}`:

```bash
NODE_OPTIONS= npx tsx scripts/codegraph-chain-tally.ts --corpus <corpus> --lang ruby \
  --time-only --kind-stats --quiet --dump-edges /tmp/sub-$(basename <corpus>)-after.tsv
diff <(sort ~/.tea-rags/bench/substrate-baseline/ruby-$(basename <corpus>).tsv) \
     <(sort /tmp/sub-$(basename <corpus>)-after.tsv)
```

Expected: empty diff. The kind-stats block is also part of the dump.

**G-PY-ID (Python identity, wave 1 only).** Same command with `--lang python`
(no `--time-only`) over `flask`, `httpx`, `ugnest`, `netbox`, `polar` (paths in
`scripts/lib/codegraph-corpora.json`) and django
(`/Users/Shared/swe-lite-ab/repos/django__django-11039`). Expected: empty diff
and `chain drift vs production resolver: 0`.

**G-TS-ID (TypeScript identity, Task 1 only).**
`npx tsx scripts/ts-codegraph-typechecker-oracle.ts` on the tea-rags self tree.
Expected: `CHAIN OUTPUT` block identical to baseline.

**G-PY-ORACLE (Python increment).**

```bash
NODE_OPTIONS= PYTHONHASHSEED=0 npx tsx scripts/py-codegraph-jedi-oracle.ts --corpus <name-or-path> \
  --samples 2000 --quiet --json /tmp/oracle-<name>.json
```

Run over django
(`--environment ~/Dev/Tools/tea-rags-bench/venvs/flask/bin/python --roots .`)
and the five manifest corpora. Pass conditions:

- **Precision:** fabricated + wrongFile ≤ 2% of edges, and phantom ≤ baseline.
- **No losses:** `lost` = 0 versus the pre-task tally.
- **Recall:** the task's receiver kind gains ≥ 50% of the task's predicted
  residual on django.

Record the numbers in the commit body.

---

## Wave 0 — outside this plan's tasks

- **Fan-out divergence bead** (django prod 0.602 vs offline 0.725; only
  same-file `super` edges persist). It is filed and run in parallel with wave 1.
  Diagnose `ExtractionFanoutDispatcher` / `extractFileBatch` for Python context
  the unpinned worker lacks. The recompute is user-gated.

---

## Wave 1A — serial foundation (one agent at a time)

### Task 0: Identity harness — `--dump-edges` and baselines

**Files:**

- Modify: `scripts/codegraph-chain-tally.ts` (`parseArgs`, the per-site loop in
  `main`)
- Create: `scripts/lib/tally-edge-dump.ts`
- Test: `tests/scripts/tally-edge-dump.test.ts`

**Interfaces:**

- Produces:
  `formatTallyEdgeDump(rows: TallyEdgeDumpRow[], kindStats: string): string`,
  where
  `TallyEdgeDumpRow = { relPath: string; line: number; callText: string; receiverKind: string; targetRelPath: string | null; targetSymbolId: string | null; edgeKind: string }`.
  Output is one TSV line per row (sorted by relPath, line, callText), followed
  by `#kind-stats` and the verbatim kind-stats block.
- Produces: baseline files
  `~/.tea-rags/bench/substrate-baseline/{ruby,python}-<corpus>.tsv`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest";

import { formatTallyEdgeDump } from "../../scripts/lib/tally-edge-dump.js";

describe("formatTallyEdgeDump", () => {
  it("sorts rows and appends the kind-stats block verbatim", () => {
    const out = formatTallyEdgeDump(
      [
        {
          relPath: "b.rb",
          line: 2,
          callText: "x.y",
          receiverKind: "dynamic",
          targetRelPath: null,
          targetSymbolId: null,
          edgeKind: "none",
        },
        {
          relPath: "a.rb",
          line: 9,
          callText: "foo",
          receiverKind: "bareCall",
          targetRelPath: "a.rb",
          targetSymbolId: "A#foo",
          edgeKind: "exact",
        },
      ],
      "bareCall 1.000 1/1",
    );
    expect(out.split("\n")).toEqual([
      "a.rb\t9\tfoo\tbareCall\ta.rb\tA#foo\texact",
      "b.rb\t2\tx.y\tdynamic\t-\t-\tnone",
      "#kind-stats",
      "bareCall 1.000 1/1",
      "",
    ]);
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/scripts/tally-edge-dump.test.ts`.
      Expected: FAIL (module missing).
- [ ] **Step 3: Implement.** `formatTallyEdgeDump` (null → `-`, tabs inside
      `callText` replaced by spaces). Then wire it into the tally:
  - `parseArgs` reads `--dump-edges <path>`;
  - the per-site loop collects a `TallyEdgeDumpRow` from the production
    resolver's outcome (`--time-only`) or the baseline chain's outcome (default
    mode);
  - after the kind-stats block is rendered,
    `writeFileSync(path, formatTallyEdgeDump(rows, kindStatsText))`.
- [ ] **Step 4:** Re-run the test. Expected: PASS. Run the dump on sinatra
      twice; `diff` of the two files is empty (determinism).
- [ ] **Step 5: Record baselines** on the integration branch tip before any
      `src/` change. Commands: G-RB for 3 Ruby corpora, G-PY-ID for 6 Python
      corpora, written to `~/.tea-rags/bench/substrate-baseline/`. Also save the
      oracle JSONs: G-PY-ORACLE outputs →
      `~/.tea-rags/bench/substrate-baseline/oracle-<name>.json`.
- [ ] **Step 6:** `review_changes` → fix → commit
      `chore(scripts): tally --dump-edges for substrate identity gates`.

### Task 1: `TypeRef` tuple form (T)

**Files:**

- Modify: `src/core/contracts/types/language.ts` (`TypeRef` union)
- Modify: `src/core/domains/language/kernel/type-ref.ts` (`typeRefEquals`,
  `typeRefNonNilArms`, `typeRefReceiverForm`)
- Modify: every exhaustive `switch`/`if` chain over `TypeRef["form"]`.
  `npx tsc --noEmit` lists them once the union widens; expect ts / swift / go /
  ruby / python sites.
- Test: `tests/core/domains/language/kernel/type-ref.test.ts`

**Interfaces:**

- Produces: `TypeRef` gains `{ form: "tuple"; elements: readonly TypeRef[] }`;
  `typeRefTupleElement(ref: TypeRef, index: number): TypeRef | null`.

- [ ] **Step 1: Failing tests:**
  - `typeRefEquals` on two equal tuples is true, and on different lengths is
    false;
  - `typeRefTupleElement({form:"tuple",elements:[A,B]},1)` equals B;
    out-of-range → null; non-tuple → null;
  - `typeRefReceiverForm` on a tuple → `null` (a tuple is not a member
    receiver).
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Widen the union and implement the helpers. Fix each `tsc`
      error by treating `tuple` exactly as today's code treats an unknown or
      declined form: return `null` / `CONTINUE`, never a new behavior.
- [ ] **Step 4:** Tests PASS. `npx tsc --noEmit` clean. **Gates:** G-RB,
      G-PY-ID, G-TS-ID all empty diffs.
- [ ] **Step 5:** `review_changes` → fix → commit
      `refactor(trajectory): TypeRef tuple form in the kernel`.

### Task 2: `TypeMemberLookup` port

**Files:**

- Create: `src/core/domains/language/kernel/type-member-lookup.ts`
- Modify: `src/core/domains/language/kernel/index.ts` (export)
- Create: `src/core/domains/language/ruby/resolver/ruby-type-member-lookup.ts`.
  It wraps `resolveTypeStaticMethod` / `resolveTypeInstanceMethod` from
  `ruby/resolver/strategies/shared.ts`.
- Create:
  `src/core/domains/language/python/resolver/python-type-member-lookup.ts`. It
  wraps `resolvePythonMemberOnType` / `resolvePythonMemberOnTypeThroughMro` from
  `python/resolver/strategies/shared.ts`.
- Test: `tests/core/domains/language/kernel/type-member-lookup.test.ts`,
  `tests/core/domains/language/ruby/resolver/ruby-type-member-lookup.test.ts`,
  `tests/core/domains/language/python/resolver/python-type-member-lookup.test.ts`

**Interfaces:**

- Produces:

```ts
export interface TypeMemberLookup {
  /** Member `member` on `type`, MRO / ancestor walk included. `class` form = static
   *  member, `instance` form = instance member. Union / tuple / container / nil → null:
   *  callers fan unions out themselves (K2). */
  findMember: (
    type: TypeRef,
    member: string,
    ctx: CallContext,
  ) => SymbolResolutionTarget | null;
}
export function createRubyTypeMemberLookup(): TypeMemberLookup; // ruby side
export function createPythonTypeMemberLookup(
  mapper: PythonImportFileMapper,
  linearizers: PythonAncestorLinearizerCache,
): TypeMemberLookup; // python side
```

- [ ] **Step 1: Failing tests:**
  - **Kernel:** a fake lookup is called only for `class` / `instance` forms
    (`lookupDefinedFor(form)` helper returns false for union / tuple / container
    / nil).
  - **Ruby:** on the symbol-table fixture pattern from
    `tests/core/domains/language/java/resolver/strategies/strategies.test.ts`
    (build a `GlobalSymbolTable` with `class A; def foo` and `class B < A`),
    `findMember({form:"instance",name:"B"},"foo",ctx)` → target `A#foo`.
  - **Python:** the same with `class A: def foo(self)` / `class B(A)` → `A#foo`;
    `{form:"class",name:"B"}` + classmethod `make` → `B.make`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the wrappers by delegating to the existing
      functions. No strategy changes yet.
- [ ] **Step 4:** PASS. Gates G-RB, G-PY-ID (trivially empty, since nothing
      consumes the port yet).
- [ ] **Step 5:** `review_changes` → fix → commit
      `refactor(trajectory): TypeMemberLookup port with Ruby and Python implementations`.

### Task 3: K4 kernel skeletons (chain-type, local-binding, convention-receiver)

**Files:**

- Create: `src/core/domains/language/kernel/receiver-typed-strategies.ts`
- Modify:
  `ruby/resolver/strategies/{ruby-chain-type,ruby-local-type,ruby-convention-receiver}.ts`,
  `ruby/resolver/ruby-resolver.ts` (construction)
- Modify:
  `python/resolver/strategies/{python-chain-type,python-local-binding,python-naming-convention}.ts`,
  `python/resolver/python-chain-factory.ts`
- Test: `tests/core/domains/language/kernel/receiver-typed-strategies.test.ts`;
  existing Ruby/Python strategy tests stay untouched and must pass.

**Interfaces:**

- Consumes: `TypeMemberLookup` (Task 2).
- Produces:

```ts
export interface ReceiverTypingPorts {
  /** Receiver → TypeRef, or null when the language cannot type it. */
  typeOfReceiver: (call: CallRef, ctx: CallContext) => TypeRef | null;
}
export class ChainTypeSymbolResolutionStrategy implements SymbolResolutionStrategy {
  constructor(
    name: string,
    typing: ReceiverTypingPorts,
    lookup: TypeMemberLookup,
    opts: { dropOnTypedMiss: boolean },
  );
}
export class LocalBindingSymbolResolutionStrategy implements SymbolResolutionStrategy {
  constructor(
    name: string,
    typing: ReceiverTypingPorts,
    lookup: TypeMemberLookup,
    opts: { dropOnTypedMiss: boolean },
  );
}
export class ConventionReceiverSymbolResolutionStrategy implements SymbolResolutionStrategy {
  constructor(
    name: string,
    typing: ReceiverTypingPorts & {
      isTypedElsewhere: (call: CallRef, ctx: CallContext) => boolean;
    },
    lookup: TypeMemberLookup,
  );
}
```

The `name` strings stay exactly as today, because chain-tally `--defer` and the
oracle `answeredBy` columns key on them.

- [ ] **Step 1: Failing kernel tests** with fake ports:
  - typed + member found → `resolved(target)`;
  - typed + member missing + `dropOnTypedMiss` → `DROP`;
  - untyped → `CONTINUE`;
  - convention: `isTypedElsewhere` → `CONTINUE`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the skeletons. Rewrite the six language strategies
      as thin factories returning kernel instances with language ports. Each
      language's own receiver typing (Ruby `typeOfReceiver`, Python
      receiver-type ports) moves into its port object verbatim. Keep the
      exported class names of the language strategies as
      `export const RubyChainTypeSymbolResolutionStrategy = …` factories only
      when an external import needs them. Otherwise update the importers.
- [ ] **Step 4:** Kernel tests PASS; existing Ruby/Python strategy tests PASS
      unmodified. Gates **G-RB** and **G-PY-ID** empty.
- [ ] **Step 5:** `review_changes` → fix → commit
      `refactor(trajectory): kernel receiver-typed strategy skeletons for Ruby and Python`.

---

## Wave 1B — parallel lifts (≤ 3 agents at a time)

Lanes (no file overlap inside a lane batch):

- batch A = Tasks 4, 5, 6
- batch B = Tasks 7, 8, 9
- batch C = Tasks 10, 11
- then Task 12 alone (hotspot)

### Task 4: K9 `readResolverConfig`

**Files:** Create `kernel/resolver-config.ts`. Modify
`ruby/resolver/ruby-resolver.ts`, `ruby/resolver/strategies/shared.ts`
(`ResolverConfig`, `CONE_MAX_DEFAULT`, `resolveConeMax`),
`python/resolver/python-resolver.ts`, `python/resolver/strategies/shared.ts`.
Test `tests/core/domains/language/kernel/resolver-config.test.ts`.

**Interfaces:**
`readResolverConfig(env: NodeJS.ProcessEnv, prefix: "CODEGRAPH_RB" | "CODEGRAPH_PY"): ResolverConfig`
with
`ResolverConfig = { mode: AmbiguousResolveMode; coneMax: number; dynamicReceiverConfidence?: number }`;
`CONE_MAX_DEFAULT = 8`.

- [ ] Failing tests: an unset env gives the default `coneMax` of 8;
      `CODEGRAPH_PY_CONE_MAX=3` → 3; an invalid value falls back to 8; the
      prefix isolates Ruby from Python.
- [ ] Implement, delete the two local copies, re-point importers.
- [ ] PASS; G-RB + G-PY-ID empty.
- [ ] `review_changes` → fix → commit
      `refactor(trajectory): shared resolver config reader`.

### Task 5: K10 `AncestorLinearizerCache` for Ruby

**Files:** Modify `kernel/ancestor-walk.ts` (add `AncestorLinearizerCache<TCtx>`
on `RunScopedMemo`, keyed by `ctx.classAncestors` identity, stamped with the
table size — the semantics `PythonAncestorLinearizerCache` already proves).
Modify `python/resolver/python-ancestor-policy.ts`
(`PythonAncestorLinearizerCache` becomes an instance) and
`ruby/resolver/ancestor-linearization.ts` (`linearizeAncestors` reads through
the cache). Ruby member-in-MRO walks (`resolveInstanceMethodInClassChain`,
`collectResolvedAncestorChain`, `firstDefinerAfter`) route through
`findMemberInAncestorChain`. Test
`tests/core/domains/language/kernel/ancestor-linearizer-cache.test.ts`.

- [ ] Failing tests:
  - same `classAncestors` object + same size → linearizer built once;
  - a new `classAncestors` object → rebuilt;
  - the same object with a grown size → rebuilt (the cross-run cache lesson from
    the Python program).
- [ ] Implement.
- [ ] PASS; G-RB + G-PY-ID empty. Report sinatra/huginn tally wall-time before
      vs after.
- [ ] `review_changes` → fix → commit
      `perf(trajectory): run-scoped ancestor linearizer cache shared by Ruby and Python`.

### Task 6: K8 `FrameworkVocabularyRegistry` + Gemfile as a manifest

**Files:**

- Create `kernel/framework-vocabulary.ts`.
- Modify `ruby/dsl/catalogue.ts` (`filterActiveFrameworks`, `catalogueFor`) and
  `ruby/gemfile.ts` (add `RUBY_DEPENDENCY_MANIFEST: DependencyManifestSource`
  that parses `Gemfile`/`Gemfile.lock` gem names; `catalogueForGemfile` stays as
  the adapter).
- Modify `ruby/index.ts` (`dependencyManifest`),
  `python/vocabulary/frameworks/index.ts`, and the `CallContext` builders that
  set `gemfileContent` (find with `hybrid_search` "gemfileContent").
- Test `tests/core/domains/language/kernel/framework-vocabulary.test.ts`.

**Interfaces:**

```ts
export interface FrameworkVocabularyDescriptor {
  framework: string;
  activatedBy?: readonly string[];
}
export class FrameworkVocabularyRegistry<
  V extends FrameworkVocabularyDescriptor,
> {
  constructor(all: readonly V[]);
  active(declared: ReadonlySet<string>): readonly V[]; // memoised per declared-set identity
}
```

- [ ] Failing tests:
  - `activatedBy` absent → always active;
  - `["django"]` active only when declared;
  - the same `declared` Set instance → same array instance (memo).
- [ ] Implement. Ruby activation reads `ctx.declaredDependencies` filled by
      `RUBY_DEPENDENCY_MANIFEST`. Remove the `gemfileContent` channel once every
      reader is migrated. `tsc` proves no reader remains.
- [ ] PASS; G-RB + G-PY-ID empty.
- [ ] `review_changes` → fix → commit
      `refactor(trajectory): framework vocabulary registry; Gemfile as a dependency manifest`.

### Task 7: K3 `TableDispatchResolver`

**Files:** Create `kernel/table-dispatch.ts`. Modify
`ruby/resolver/strategies/ruby-table-dispatch.ts` and
`python/resolver/dispatch/python-table-dispatch.ts` (each becomes ports). Test
`tests/core/domains/language/kernel/table-dispatch.test.ts`.

**Interfaces:**

```ts
export interface TableDispatchPorts {
  selectTableDef: (call: CallRef, ctx: CallContext) => DispatchTableDef | null;
  resolveEntry: (
    entry: DispatchTableEntry,
    call: CallRef,
    ctx: CallContext,
  ) => SymbolResolutionTarget | null;
}
export class TableDispatchResolver implements DispatchResolverComponent {
  constructor(ports: TableDispatchPorts);
}
```

The `exact` vs `registry` 1/N edge-kind rule is copied verbatim from
`RubyTableDispatchResolver`. Python's current rule must already match it. If it
does not, stop and report it as a behavior difference.

- [ ] Failing tests with fake ports:
  - literal key → one `exact` edge;
  - non-literal key over 3 entries → 3 `registry` edges, confidence 1/3;
  - no table → empty outcome.
- [ ] Implement; PASS; G-RB + G-PY-ID empty.
- [ ] `review_changes` → fix → commit
      `refactor(trajectory): kernel table dispatch resolver`.

### Task 8: K2 `UnionDispatchResolver` (Ruby lift)

**Files:** Create `kernel/union-dispatch.ts`. Modify
`ruby/resolver/strategies/ruby-union-dispatch.ts`. Test
`tests/core/domains/language/kernel/union-dispatch.test.ts`.

**Interfaces:**

```ts
export interface UnionDispatchPorts extends ReceiverTypingPorts {
  ownsPath: (relPath: string) => boolean; // language population filter (Ruby: isRubyPath)
}
export class UnionDispatchResolver implements DispatchResolverComponent {
  constructor(
    ports: UnionDispatchPorts,
    lookup: TypeMemberLookup,
    coneMax: number,
  );
}
```

- [ ] Failing tests:
  - union of 2 arms both defining the member → 2 `cone` edges at 1/2;
  - an arm with no definer is skipped;
  - arms > `coneMax` → empty;
  - non-union receiver → empty.
- [ ] Implement; Ruby becomes ports + `createRubyTypeMemberLookup()`. PASS; G-RB
      empty.
- [ ] `review_changes` → fix → commit
      `refactor(trajectory): kernel union dispatch resolver`.

### Task 9: K5 `ReceiverPatternDropSymbolResolutionStrategy`

**Files:** Create `kernel/receiver-pattern-drop.ts`. Modify
`ruby-receiver-set-drop.ts` and `ruby-ar-relation-guard.ts`. Test
`tests/core/domains/language/kernel/receiver-pattern-drop.test.ts`.

**Interfaces:**

```ts
export interface ReceiverPatternDropRule {
  name: string;
  matches: (call: CallRef, ctx: CallContext) => boolean;
}
export class ReceiverPatternDropSymbolResolutionStrategy implements SymbolResolutionStrategy {
  constructor(name: string, rules: readonly ReceiverPatternDropRule[]);
}
```

- [ ] Failing tests: the first matching rule → `DROP`; none → `CONTINUE`; rule
      order preserved.
- [ ] Ruby `receiverSetDrop` = rule `receiver !== null`; `arRelationGuard` =
      rule over `receiverLooksLikeArRelationChain`. Strategy `name`s unchanged.
      PASS; G-RB empty.
- [ ] `review_changes` → fix → commit
      `refactor(trajectory): kernel receiver-pattern drop strategy`.

### Task 10: K6 `MemberReturnTypeResolver` + unified `callResultBindings`

**Files:**

- Create `kernel/member-return-type.ts`.
- Modify `contracts/types/codegraph-resolution.ts` (`localCallBindings` folded
  into `callResultBindings`, one shape).
- Modify the Ruby files
  `ruby/resolver/{ruby-member-return-types,ruby-return-facts,ruby-bound-call-return-types}.ts`
  and the Ruby walker producer of `localCallBindings`.
- Modify the Python files `python/resolver/strategies/shared.ts`
  (`pythonInheritedMemberType`, `pythonCallBindingType`) — extract them into
  `python/resolver/python-member-return-types.ts` while there, cutting the hub.
- Test `tests/core/domains/language/kernel/member-return-type.test.ts`.

**Interfaces:**

```ts
export interface MemberReturnTypePorts {
  declaredReturnType: (
    owner: TypeRef,
    member: string,
    ctx: CallContext,
  ) => TypeRef | null;
  ancestorsOf: (owner: TypeRef, ctx: CallContext) => readonly string[]; // linearized, owner excluded
  flatReturnType: (member: string, ctx: CallContext) => TypeRef | null; // gated by caller: ≤1 def
  frameworkReturnType?: (
    owner: TypeRef,
    member: string,
    ctx: CallContext,
  ) => TypeRef | null;
}
export class MemberReturnTypeResolver {
  constructor(ports: MemberReturnTypePorts);
  returnTypeOf(
    owner: TypeRef,
    member: string,
    ctx: CallContext,
  ): TypeRef | null;
}
```

Order: declared on owner → declared on each ancestor → framework hook → flat.
Ruby's union fold ("all arms agree") and container-element arms stay in the Ruby
port, because they precede the kernel call in today's `returnTypeOf`.

- [ ] Failing tests with fake ports covering each fallthrough step and the
      "first non-null wins" order.
- [ ] Implement; migrate both languages; rename the channel. PASS; G-RB +
      G-PY-ID empty.
- [ ] `review_changes` → fix → commit
      `refactor(trajectory): kernel member return-type resolver, one call-result channel`.

### Task 11: type-ref equality into contracts; param-type fold stays language-agnostic (re-scoped)

The original plan moved `call-arg-param-types.ts` into the kernel behind a
`ClassFieldKeyPort`. That was wrong. `.claude/rules/domain-boundaries.md`
forbids `trajectory/** -> domains/language/**`, and the fold's consumers
(`run-state.ts`, `resolution-runner.ts`) are trajectory. The fold is also a
run-level join over the complete method-definition index of every language, so
it belongs to trajectory. The only language-specific part is the spelling of
`classKey`, which the walker already writes: the fold joins
`<classKey>#<method>` and `<classKey>|<field>` whatever `classKey` is. A port
would re-spell keys the language already wrote (YAGNI).

**Files:**

- Create `src/core/contracts/type-ref-equals.ts` (pure `typeRefEquals` over the
  contract `TypeRef`; precedent `contracts/identifier-record.ts`).
- `kernel/type-ref.ts` re-exports it; the kernel API is unchanged.
- Delete the private copy in
  `trajectory/codegraph/symbols/call-arg-param-types.ts`.
- Document the key contract on `KnownTargetCallArgs` / `ClassFieldParamLink` in
  `contracts/types/codegraph-extraction.ts`.

- [x] Characterization test (added, passes immediately): Python-shaped
      `"pkg/a.py::A"` keys through `deriveClassFieldTypesFromParams`.
- [x] Existing tests unmodified; G-RB + G-PY-ID empty.
- [x] Commit
      `refactor(trajectory): type-ref equality moves to contracts; param-type fold stays language-agnostic`.

### Task 12: K1 `DynamicDispatchResolver` + `ExactChainAnswerProbe`

**Files:**

- Create `kernel/dynamic-dispatch.ts`.
- Modify `ruby/resolver/strategies/ruby-dynamic-dispatch.ts` and
  `ruby-dynamic-fanout-gates.ts` (gate order verbatim).
- Modify
  `python/resolver/dispatch/{python-dynamic-dispatch,python-chain-probe,python-dispatch-gates}.ts`.
- Test `tests/core/domains/language/kernel/dynamic-dispatch.test.ts`.

**Interfaces:**

```ts
export interface ExactChainAnswerProbe {
  answers: (call: CallRef, ctx: CallContext) => boolean;
}
export interface DynamicDispatchPorts {
  suppressed: (call: CallRef, ctx: CallContext) => boolean; // language gate runner, order preserved
  lookupByShortName: (
    member: string,
    ctx: CallContext,
  ) => readonly SymbolDefinition[];
  cascade: DispatchCascadeOptions;
  discount: number;
  population: DispatchFanoutPopulation;
  cap: number;
}
export class DynamicDispatchResolver implements DispatchResolverComponent {
  constructor(ports: DynamicDispatchPorts);
}
```

- [ ] Failing tests with fake ports: suppressed → empty; candidates narrowed by
      the cascade; above cap → `ambiguous`; the discount applied to confidence.
- [ ] Implement. Ruby `exactPassAnswersReceiver` and Python
      `PythonChainAnswerProbe` both implement `ExactChainAnswerProbe`. Python
      stays behind `CODEGRAPH_PY_DYNAMIC_DISPATCH` (off). PASS; G-RB + G-PY-ID
      empty, and G-PY-ID once more with `CODEGRAPH_PY_DYNAMIC_DISPATCH=1`
      against a flag-on baseline captured in this task before editing.
- [ ] `review_changes` → fix → commit
      `refactor(trajectory): kernel dynamic dispatch resolver and exact-chain probe`.

### CHECKPOINT W1 (orchestrator)

- [ ] On `integration/py-ruby-substrate`: run `npm run build` and
      `npx vitest run` (full suite), then G-RB + G-PY-ID + G-TS-ID once more on
      the merged tip.
- [ ] Fix commits for anything red land on the integration branch, never inside
      agent branches.

---

## Wave 2 — Python consumption (≤ 3 agents; lanes avoid `python/walker/walker.ts` overlap)

Lane rule:

- Tasks 13, 15, 16, 17, 18 all touch the walker. They run one at a time, in that
  order, in the **walker lane**.
- Tasks 14, 19, 20, 21, 22, 23 run in the two **resolver lanes** beside it.

Predicted residuals (django oracle, sample-based) are in each task's gate line.

### Task 13: P4 module-level values (walker lane)

**Files:**

- Modify `python/walker/walker.ts` (module-scope assignment visitor) and
  `python/walker/passes/python-type-channels.ts` (new channel
  `moduleValueTypes`).
- Modify `kernel/type-fact-store.ts` (channel),
  `contracts/types/codegraph-extraction.ts` + `codegraph-resolution.ts`
  (`moduleValueTypes: Record<string, TypeRef>` keyed `relPath::name`).
- Modify `python/resolver/strategies/python-imported-name.ts` (imported value →
  `moduleValueTypes` → `TypeMemberLookup`), and the dynamic / same-file module
  variable path via `ReceiverTypingPorts`.
- Test `tests/core/domains/language/python/walker/module-value-types.test.ts`
  and
  `tests/core/domains/language/python/resolver/module-value-receiver.test.ts`.

- [ ] Failing tests:
  - walker: `apps = Apps(installed_apps=None)` at module scope in
    `django/apps/registry.py` → fact `django/apps/registry.py::apps` = instance
    `Apps`;
  - walker: a function-local assignment emits nothing;
  - resolver: `from django.apps import apps; apps.populate(x)` →
    `Apps#populate`;
  - resolver: same-file `connections = ConnectionHandler(); connections.all()` →
    `ConnectionHandler#all`.
- [ ] Implement behind `CODEGRAPH_PY_MODULE_VALUES` (default on only after the
      gate).
- [ ] **Gate:** G-PY-ORACLE, kind `dynamic`, predicted ≈ 130. Then flip the
      default and re-run the six corpora.
- [ ] `review_changes` → fix → commit
      `feat(trajectory): Python module-level value types type imported singletons`.

### Task 14: K6 Python — return type through call chains (resolver lane)

**Files:**

- Modify `python/resolver/python-member-return-types.ts` (Task 10 output) and
  `python/resolver/python-receiver-type-ports.ts` (`memberTypeOf` →
  `MemberReturnTypeResolver`).
- Narrow namesake callees (`a7NamesakeCallee`, 37 rows) by the caller's import
  binding before reading the return fact.
- Test `tests/core/domains/language/python/resolver/chain-return-types.test.ts`.

- [ ] Failing tests:
  - `query.get_compiler(using).execute_sql(x)`, where
    `Query#get_compiler -> SQLCompiler`, → `SQLCompiler#execute_sql`;
  - `qs = self.get_dated_queryset(); qs.none()` with a `-> QuerySet` annotation
    → `QuerySet#none`;
  - two namesake `get_runner` defs plus an import binding to one → the bound
    one's return.
- [ ] Implement.
- [ ] **Gate:** G-PY-ORACLE, kinds `chain` and `dynamic`, predicted ≈ 115.
- [ ] `review_changes` → fix → commit
      `feat(trajectory): Python member return types through call chains`.

### Task 15: K7 Python walker feed — params and fields (walker lane)

> Key contract: the Python walker emits `<classKey>#<method>` /
> `<classKey>|<field>` with its file-qualified class key, spelled identically
> across all four channels. No port exists.

**Files:**

- Create `python/walker/passes/python-param-arg-types.ts`, emitting
  `knownTargetCallArgs`, `classFieldParamLinks`, and `paramNames` in
  `python-def-signatures.ts`.
- Wire it in `python/walker/passes.ts`.
- `PYTHON_CLASS_FIELD_KEY_PORT` in `python/resolver/strategies/shared.ts` (or
  the class-keys module if Task 10 split it).
- Test `tests/core/domains/language/python/walker/param-arg-types.test.ts`.

- [ ] Failing tests:
  - `def __init__(self, request): self.request = request` + a call site
    `View(HttpRequest())` → field `View.request` = `HttpRequest`;
  - two call sites with disagreeing argument types → no fact;
  - resolver: `self.request.is_secure()` → `HttpRequest#is_secure`.
- [ ] Implement.
- [ ] **Gate:** G-PY-ORACLE, kinds `dynamic` / `chain` / `selfMember`, predicted
      ≈ 98.
- [ ] `review_changes` → fix → commit
      `feat(trajectory): Python call-argument types flow into params and fields`.

### Task 16: P1 iteration / context / unpack / except bindings (walker lane)

**Files:**

- Modify `contracts/types/codegraph-local-binding.ts` (`LocalBinding.valueKind`:
  `iterationElement`, `contextEnter`, `tupleElement`, `exceptionInstance`).
- Modify `kernel/receiver-type-propagation.ts` (port
  `elementTypeOf?: (container: TypeRef, ctx: CallContext) => TypeRef | null` on
  `ReceiverTypePorts`).
- Modify `python/walker/walker.ts` (for / comprehension / with / except /
  tuple-target visitors).
- Create `python/resolver/python-iteration-types.ts` (built-in container table:
  `dict.values/items/keys`, `list`, `set`, `tuple`, `enumerate`, `zip`,
  `reversed`, `sorted`; plus `__iter__` → `__next__` and `__enter__` via
  `MemberReturnTypeResolver`).
- Test `tests/core/domains/language/python/resolver/iteration-bindings.test.ts`.

- [ ] Failing tests:
  - `for app_config in self.app_configs.values(): app_config.get_models()`, with
    `self.app_configs: dict[str, AppConfig]` → `AppConfig#get_models`;
  - `for i, op in enumerate(ops)` with `ops: list[Operation]` → `op.reduce` →
    `Operation#reduce`;
  - `with Lock() as l` where `__enter__` returns `self` → `l.release` →
    `Lock#release`;
  - `except ValidationError as e: e.update_error_dict()` →
    `ValidationError#update_error_dict`;
  - `a, b = make_pair()` with `-> tuple[A, B]` → `b.x` → `B#x`.
- [ ] Implement.
- [ ] **Gate:** G-PY-ORACLE, kinds `dynamic` / `localVar`, predicted ≈ 85.
- [ ] `review_changes` → fix → commit
      `feat(trajectory): Python iteration, context-manager, unpacking and except bindings`.

### Task 17: P2 callable-value flow (walker lane)

**Files:**

- Modify `python/walker/passes/python-dispatch-tables.ts`
  (`collectPythonCallbackParams` generalized: any call passing a function
  reference into a param; a decorator `@d def f` emits an implicit `d(f)`).
- Modify `python/resolver/strategies/python-cls-member.ts` (`cls(...)`,
  `type(self)(...)`, `self.__class__(...)` → enclosing-class constructor).
- Create `python/resolver/strategies/python-callable-param.ts`: one source →
  exact; several → fan under `dispatchFanoutPolicyFor`, edge kind `cone`.
- Test `tests/core/domains/language/python/resolver/callable-params.test.ts`.

- [ ] Failing tests:
  - `def csrf_exempt(view_func): def wrapped(*a): return view_func(*a)` +
    `@csrf_exempt def v()` → `view_func(...)` → `v`;
  - the same decorator on 3 functions → 3 fan edges, not exact;
  - `@classmethod def create(cls, e): return cls(e)` → `AppConfig#__init__`.
- [ ] Implement.
- [ ] **Gate:** G-PY-ORACLE, kind `bareCall`, predicted ≈ 80; phantom must not
      rise.
- [ ] `review_changes` → fix → commit
      `feat(trajectory): Python callable-value flow through params and decorators`.

### Task 18: P3 descriptors (walker lane)

**Files:**

- Modify `python/walker/passes/python-def-signatures.ts`
  (`isAttributeDescriptor` when a decorator is in the descriptor vocabulary).
- Create `python/vocabulary/descriptors.ts` (`property`,
  `functools.cached_property`; frameworks contribute through K8 facets).
- Modify `python/resolver/python-receiver-type-ports.ts` (`memberTypeOf` treats
  descriptor members as attributes).
- Test `tests/core/domains/language/python/resolver/descriptors.test.ts`.

- [ ] Failing tests:
  - `@cached_property def output_field(self) -> Field` +
    `self.output_field.db_type(c)` → `Field#db_type`;
  - a `django.utils.functional.cached_property` import → same (with Task 19
    facet, or a fixture-declared vocabulary);
  - a plain method accessed without a call is not typed.
- [ ] Implement.
- [ ] **Gate:** G-PY-ORACLE, kind `chain`, predicted ≈ 50.
- [ ] `review_changes` → fix → commit
      `feat(trajectory): Python descriptor members type attribute access`.

### Task 19: P5 Django facets + self-package activation (resolver lane)

**Files:**

- Modify `python/vocabulary/frameworks/{types,django}.ts`: facets
  `relationReturning`, `instanceReturning`, `modelAttributes` (`objects`,
  `_default_manager`, `_base_manager` → Manager; `_meta` → `Options`),
  `associationFields` (`ForeignKey`, `OneToOneField` → instance of the first
  argument), `descriptorDecorators` (`django.utils.functional.cached_property`).
- Modify `python/manifest.ts`: the self-package rule reads `name` from
  `setup.py` / `setup.cfg` / `pyproject.toml`.
- Modify `python/resolver/python-member-return-types.ts` (`frameworkReturnType`
  port).
- Test `tests/core/domains/language/python/vocabulary/django-facets.test.ts`.

- [ ] Failing tests:
  - `Model.objects.filter(x).first().save()` → `Model#save`;
  - `model._meta.get_field(n)` → `Options#get_field`;
  - `book.author.name_display()` with `author = ForeignKey(Author)` →
    `Author#name_display`;
  - a corpus whose `setup.py` declares `name='Django'` activates the django
    vocabulary with no manifest dependency.
- [ ] Implement.
- [ ] **Gate:** G-PY-ORACLE on django and ugnest / netbox (the apps where it
      matters), kind `chain`, predicted ≈ 40 on django.
- [ ] `review_changes` → fix → commit
      `feat(trajectory): Django framework facets for managers, _meta and relations`.

### Task 20: K2 Python union consumer (resolver lane)

**Files:** Modify `python/resolver/python-resolver.ts` (dispatch components
become `[table, union, cone]`). Create
`python/resolver/dispatch/python-union-ports.ts`. Test
`tests/core/domains/language/python/resolver/union-dispatch.test.ts`.

- [ ] Failing test: `x: A | B` with both defining `run` → 2 `cone` edges.
- [ ] Implement.
- [ ] **Gate:** G-PY-ORACLE, phantom not up.
- [ ] `review_changes` → fix → commit
      `feat(trajectory): union-receiver dispatch for Python`.

### Task 21: K5 Python drop patterns (resolver lane)

**Files:** Modify `python/resolver/python-chain-factory.ts` (append
`ReceiverPatternDropSymbolResolutionStrategy`). Test
`tests/core/domains/language/python/resolver/receiver-pattern-drop.test.ts`.

- [ ] Derive candidate rules. Take the `phantom` sample rows of kind `chain` /
      `dynamic` from the CHECKPOINT-W1 oracle JSONs. Group them by receiver
      shape: the tail call of the receiver chain (e.g. `.objects.filter(...)`,
      `.values(...)`), or a module-alias root that the mapper reports external.
- [ ] A candidate becomes a rule only if, on all six corpora, it removes ≥ 10
      phantom rows with `lost` = 0 (measure with the rule appended behind a
      local flag). If no candidate qualifies, close the bead with the measured
      table and add no strategy.
- [ ] For each accepted rule: a failing test with the exact receiver shape →
      `DROP`, and a near-miss shape → `CONTINUE`.
- [ ] Implement.
- [ ] **Gate:** G-PY-ORACLE, `lost` = 0, phantom down or equal.
- [ ] `review_changes` → fix → commit
      `feat(trajectory): Python receiver-pattern drop rules`.

### Task 22: P6 undecidable — K11 (resolver lane)

**Files:**

- Modify `contracts/types/codegraph-resolution.ts`
  (`CallResolver.targetsUndecidable?`).
- Modify `trajectory/codegraph/symbols/resolution-runner.ts`
  (`classifyResolveMiss` checks it right after `dynamicSend`).
- Modify `python/walker/walker.ts` (`getattr(obj, <non-literal>)(...)` →
  `dynamicSend`).
- Create `python/resolver/python-undecidable.ts` (typed receiver, member absent
  on the MRO, class defines `__getattr__` / `__getattribute__` or has a
  `metaclass=` base).
- Test `tests/core/domains/language/python/resolver/undecidable.test.ts`.

This task touches the walker. Schedule it after Task 18 in the walker lane, or
rebase onto it.

- [ ] Failing tests: each shape → `unresolvable`; a member found on the MRO →
      still `resolved`.
- [ ] Implement.
- [ ] **Gate:** kind-stats `unresolvable` rises and `missWithInProjectDef` falls
      by the same count; `edges` unchanged.
- [ ] `review_changes` → fix → commit
      `feat(trajectory): statically undecidable Python calls leave the resolve denominator`.

### Task 23: P7 external by type — K12 (resolver lane)

**Files:** Modify `python/resolver/python-external-vocabulary.ts`
(`isReceiverDefinitionExternal` arm: a field / local typed by a constructor
imported from an external module — mapper says `external`, or stdlib). Test
`tests/core/domains/language/python/resolver/external-by-type.test.ts`.

- [ ] Failing test: `self.ready_event = threading.Event()`;
      `self.ready_event.set()` → `externalSkipped`.
- [ ] Implement.
- [ ] **Gate:** `externalSkipped` rises and the miss falls by the same count;
      G-PY-ORACLE `agreeExternal` rises and `lost` = 0.
- [ ] `review_changes` → fix → commit
      `feat(trajectory): Python receivers typed by external constructors are external`.

### Task 24: Navigators, capability doc, enumerations (any lane, last)

**Files:**

- `src/core/domains/language/CLAUDE.md` and
  `src/core/domains/language/python/CLAUDE.md`: name the new contracts, never
  enumerate implementers.
- `src/core/domains/language/python/capability.ts`: tier text.
- `npm run gen:lang-compat`.
- `tests/navigator-enumerations.test.ts`: derived sets for any new capability.

- [ ] `npx vitest run tests/navigator-enumerations.test.ts tests/navigator-code-references.test.ts`.
      PASS.
- [ ] `review_changes` → fix → commit
      `docs(trajectory): language navigators and capability tier for the resolver substrate`.

### CHECKPOINT W2 (orchestrator)

- [ ] Full suite on the integration branch.
- [ ] G-RB once more: Ruby must still be identical, since wave 2 never touches
      Ruby.
- [ ] G-PY-ORACLE on all six corpora → a table against the Task 0 baseline in
      the epic's notes.

---

## Wave 3 — Python dynamic dispatch (its own sub-epic)

### Task 25: Python dynamic dispatch on K1, precision-gated

**Files:** Modify `python/resolver/dispatch/python-dispatch-gates.ts` and
`python-dynamic-dispatch.ts` (ports on `DynamicDispatchResolver`). Test
`tests/core/domains/language/python/resolver/dynamic-dispatch-gate.test.ts`.

- [ ] Re-measure with `CODEGRAPH_PY_DYNAMIC_DISPATCH=1` on all six corpora after
      wave 2: per-corpus fabricated + wrongFile, phantom, and the dynamic-kind
      recall gain.
- [ ] Add gates only where oracle phantoms concentrate (classify the phantom
      rows by receiver binding with `scripts/py-e5-residual-reason-report.ts`).
- [ ] Flip the default to on **only** if every corpus passes the precision gate.
      Otherwise leave it off and record the numbers in the epic.
- [ ] `review_changes` → fix → commit
      `feat(trajectory): Python dynamic dispatch on the kernel engine`, or
      `test(trajectory): …` if the flag stays off.

---

## Wave 4 — live validation (user-gated, orchestrator)

### Task 26: Recompute, measure, walker bump

- [ ] Python walker version: bump once for this release in
      `python/capability.ts`; re-pin if it was already bumped this cycle.
- [ ] Ask the user. On "замер":
  - `DEBUG=1 tea-rags index-codebase --project swe-django__django-11039 --force-enrichments codegraph --languages python --json`,
    then
    `DEBUG=1 tea-rags prime /Users/Shared/swe-lite-ab/repos/django__django-11039`
    → per-kind rates against 0.602 / 0.725;
  - the same with `--languages ruby` on one Ruby project → rates unchanged.
- [ ] Close beads with the measured numbers (`epic-completion-gate.md`).

---

## Beads

Epic `py-ruby-substrate` under `tea-rags-mcp-m99j1`. Tasks 0–26 are one bead
each, plus the wave-0 fan-out bead.

Dependencies:

- 0 → 1 → 2 → 3 → {4..12};
- 12 → CHECKPOINT W1 → {13..24};
- walker lane 13 → 15 → 16 → 17 → 18 → 22;
- 10 → 14;
- 11 → 15;
- 6 → 19;
- 8 → 20;
- 9, 19 → 21;
- W2 → 25 → 26.

Labels:

- `architecture` on lifts;
- `metrics` + `api` on Python mechanics;
- `bugfix` on the fan-out bead.
