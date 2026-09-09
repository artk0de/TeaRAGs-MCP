# Type-Fact Store Kernel Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the three pieces of Ruby's type-fact machinery that are not
actually Ruby-specific — the `RubyTypeRef` algebra, the `RubyTypeFact` /
type-source contracts, and `RubyTypeFactStore` — into
`src/core/domains/language/kernel/`, and add the kernel helper that turns a
built store into the `Partial<FileExtraction>` an extraction pass emits. Nothing
about Ruby's behaviour moves with them: the seven-rank precedence order stays
Ruby data, injected into the store instead of baked into it. Every Ruby import
path and all 50 Ruby test call sites keep working byte-identically through
re-export shims. This is E1 seam 2; the payoff lands in E2, where Python's
annotation pass is
`sources → TypeFactStore.fromFacts(facts, PYTHON_TYPE_SOURCE_ORDER) → typeFactChannels`
inside one `ExtractionFacetPass`.

**Architecture:** Relocation, not redesign. The kernel gains four files — a
`TypeRef` algebra, a `TypeFact` / `InlineTypeSource<TInput>` /
`SidecarTypeSource` contract module, the `TypeFactStore` itself, and
`typeFactChannels`. Ruby's `type-ref.ts`, `walker/type-fact-store.ts` and
`walker/type-sources/types.ts` shrink to shims that re-export the kernel symbols
under their old Ruby names, so no consumer and no test changes an import. The
one behavioural knob the store carried implicitly — `DEFAULT_SOURCE_ORDER` — is
lifted out as a constructor argument and stored on the instance; Ruby's shim
supplies `RUBY_TYPE_SOURCE_ORDER` as the default so its 49 order-less test call
sites keep their meaning, and the single production call site passes it
explicitly. `typeFactChannels` is net-new: Ruby does NOT adopt it in this seam,
because Ruby's `walker/type-channels.ts` wraps the store's output in two
precedence rules the helper deliberately does not know about.

**Tech Stack:** TypeScript (NodeNext, `strict`), vitest, tsx for the corpus
harness. New code in `src/core/domains/language/kernel/`; the contract change is
one type rename plus an alias in `src/core/contracts/types/language.ts`.

**Spec:**
docs/superpowers/specs/2026-09-03-python-codegraph-unification-program-design.md
(E1 seam 2, contract-spine rows `TypeRef` and `TypeSource` + `TypeFact`) — plus
the Decision record below.

## Decision record

### E1 seam 2 — type-fact store + type-source contracts (`fmcly`)

**1. Relocation, not redesign.** `RubyTypeFactStore` becomes `TypeFactStore` in
`kernel/type-fact-store.ts` with the same behaviour, the same private
constructor, the same six helper functions. `RubyTypeFact` → `TypeFact`,
`RubyInlineTypeSource` → `InlineTypeSource<TInput>` (generic over the language's
extract input, so the kernel never names `RubyExtractInput`),
`RubySidecarTypeSource` → `SidecarTypeSource`, all in `kernel/type-facts.ts`.
`RubyTypeRef` → `TypeRef` in `contracts/types/language.ts` with
`export type RubyTypeRef = TypeRef` kept; `ruby/type-ref.ts` helpers →
`kernel/type-ref.ts`. Evidence for the shim approach: 36 files mention
`RubyTypeRef`, 17 mention `RubyTypeFactStore`, 11 mention `RubyTypeFact`, and 11
of those files are tests that may not be rewritten
(`.claude/rules/resolver-architecture.md` §4). Re-exports cost one line each and
keep `git diff --stat -- tests/` empty.

**2. `sourceOrder` is injected; the seven Ruby ranks stay in `ruby/`.**
`TypeFactStore.fromFacts(facts, sourceOrder)` REQUIRES the order — the kernel
has no opinion about whether `yard` outranks `ast`, and a kernel default would
silently give Python Ruby's ranks.
`RUBY_TYPE_SOURCE_ORDER = ["sorbet", "rbs", "yard", "associations", "draper", "body-last-expr", "ast"]`
moves to `ruby/walker/type-fact-store.ts` — the file that becomes the shim — and
the shim keeps it as a DEFAULT parameter. Evidence: there is exactly one
production `fromFacts` caller (`ruby/walker/file-type-env.ts:54`) and it passes
no order; 49 of the 50 test call sites also pass none. Making the shim's
parameter required would rewrite 49 test lines, which the relocation rule
forbids. The production caller passes `RUBY_TYPE_SOURCE_ORDER` explicitly
anyway, so the default exists for the tests, not for the code.

**3. The internal `DEFAULT_SOURCE_ORDER` reads ARE a latent inconsistency, and
closing it changes no observable result.** `fromFacts` ranks its coordinate
dedupe by the order it was GIVEN, but `structuredReturnType`, `ivarType`,
`structuredReturnTypesMap` and `ivarTypesMap` each re-read the module-level
`DEFAULT_SOURCE_ORDER` directly (`ruby/walker/type-fact-store.ts:147`, `:166`,
`:190`, `:216`). A store built with a non-default order therefore dedupes params
one way and ranks returns/ivars another. Storing the order on the instance and
reading `this.sourceOrder` in all four fixes that. It is observable for nobody
today: production only ever passes the default, and the single non-default call
site — `tests/.../type-fact-store-precedence.test.ts:80`,
`fromFacts(facts, ["ast", "yard"])` — asserts only `localBindingsForChunk`,
which already used the injected order. So this is behaviour-preserving for every
existing caller AND a real fix; a new kernel test pins the fixed semantics.

**4. `typeFactChannels` is net-new, and Ruby does not adopt it here.** The
helper returns exactly the `Partial<FileExtraction>` a facet pass emits:
per-chunk `localBindings`, plus `functionReturnTypes`, `structuredReturnTypes`
and `ivarTypes`, each emitted only when non-empty so `mergeExtraction`'s "absent
stays absent" holds without the merge having to prune. Ruby's `type-channels.ts`
cannot be replaced by it, because two of its channels are MERGES whose
precedence is the whole point — YARD `@return` overwriting body inference at
`:44`, and owner-qualified body inference NOT overwriting the store at `:79-81`.
Those rules stay inside the Ruby monolith, exactly as Model A requires. The
helper's consumer is Python's annotation pass in E2.

**5. Gates.** Ruby walker + type-source suites green with
`git diff --stat -- tests/core/domains/language/ruby` empty; new kernel unit
tests for every moved symbol; `npm run type-check`;
`npx eslint --max-warnings 0` over the touched kernel and `ruby/` files;
`npm run test:coverage`; the Ruby parity harness at `--limit 20000` on mastodon
reporting `mismatches 0`, timed before and after and within +10%. Read the
caveat on that harness in Global Constraints — it is a
no-crash-and-still-identity check for this seam, not a before/after diff.

---

## Global Constraints

- **No Ruby test edits, at all.**
  `git diff --stat -- tests/core/domains/language/ruby` must be EMPTY after
  every task. Relocation discipline: `.claude/rules/resolver-architecture.md` §4
  (move OK, rewrite NO) and `.claude/rules/test-invariants.md`. If a Ruby test
  fails, the shim is wrong — fix the shim, never the test.
- **Every Ruby import path survives byte-identically.** Three files become shims
  and keep their paths: `ruby/type-ref.ts`, `ruby/walker/type-fact-store.ts`,
  `ruby/walker/type-sources/types.ts`. No importer moves. Verified importer
  inventory is in "Context the implementer needs" — re-run those greps at the
  end of Task 2 and diff the file lists.
- **The kernel never names a language.** `kernel/type-facts.ts` must not import
  from `ruby/` — that is why `InlineTypeSource` is generic over its input type.
  A kernel file importing anything under `domains/language/<lang>/` is a
  review-stopping defect.
- **NDJSON spill discipline.** Everything the store returns and everything
  `typeFactChannels` emits stays a plain `Record` / array. A `Map` or `Set` in a
  `FileExtraction` value serialises to `{}` and loses every entry
  (`contracts/types/codegraph-extraction.ts:8-11`). `Map` is fine as a local
  device inside a method, which is how `fromFacts` already uses it.
- **Emit only non-empty.** `typeFactChannels` sets a channel only when it
  carries something, and skips a chunk with no bindings entirely. An empty
  object reaching the spill moves the payload the schema-drift guard compares.
- **`localBindings` stays line-sorted.** `resolveLocalBindingType` reads
  "greatest `line <= atLine`" (`.claude/rules`-level invariant, recorded in
  `src/core/domains/language/CLAUDE.md` → Invariants). `localBindingsForChunk`
  already sorts each variable's array; the helper must not disturb that, and a
  test pins it.
- **`DefaultSymbolIdComposer` is not in scope.** `typeFactChannels` copies
  `chunk.symbolId` verbatim from the `WalkContext` chunk list. It never composes
  an id — a divergent id yields edges pointing at ids no chunk carries, with no
  error (`domains/language/CLAUDE.md` → Invariants).
- **Naming.** Kernel symbols drop the `ruby` prefix and keep enough domain to
  read cold in an import line (`.claude/rules/naming.md`): `typeRefUnionOf`, not
  `unionOf`. The enclosing `kernel/type-ref.ts` pins the rest, so
  `typeRefEquals` needs no further qualification. Exact names are fixed in Task
  1 and Task 2 and MUST match across tasks.
- **Commit format.** One commit per task, `<type>(language): <subject> (fmcly)`,
  header ≤ 100 chars, body lines ≤ 100 cols, `Co-Authored-By` trailer
  (`.claude/rules/commit-rules.md`). `refactor` for Tasks 1, 2 and 4 — no
  behaviour a caller can observe changes. `feat` for Task 3: `typeFactChannels`
  is a capability that did not exist. Task 1 also touches
  `contracts/types/language.ts`, but only to rename a type and leave an alias —
  no new public surface — so `language` stays the honest scope, as it was for E1
  seam 0. This seam has no per-task beads; `fmcly` is the E1 epic and goes in
  every message.
- **No `Why:` line needed.** None of the touched files is on the deep-silo list
  in `.claude/rules/silo-pairing.md`. Do not invent one.
- **Worktree per task.** A fresh Opus subagent in its own git worktree. A fresh
  worktree has no `build/`, and the chunker pool forks the COMPILED worker, so
  run `npm run build` once before the first test run — a bare build, no
  `npm link`, no reindex.
- **The parity harness is weaker than it looks for this seam.**
  `scripts/spikes/ruby-walker-composition-parity.ts:78` compares
  `extractFromRubyFile(input)` against `walker.walk(input)` — both sides run the
  relocated store, so `mismatches 0` proves the composed walker still returns
  the monolith's object by identity and that nothing throws over 20k real files.
  It does NOT prove pre-relocation output equals post-relocation output. The
  before/after evidence is: the untouched Ruby suite, and (optional, if the
  executor wants a corpus-level number)
  `scripts/codegraph-chain-tally.ts --lang ruby` on mastodon run once before
  Task 1 and once after Task 4, with `edges` / `fileOnly` / `unresolved`
  identical — relocation protocol step 3(b).
- **Perf.** Record the parity harness's wall clock before Task 1 and after Task
  4 on the same machine; +10% is the ceiling. The relocation adds one property
  read per rank comparison and one indirection per `fromFacts`; if that shows up
  as 10%, something else changed.

---

## File Structure

**Created**

| File                                                            | Single responsibility                                                                               |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `src/core/domains/language/kernel/type-ref.ts`                  | The `TypeRef` algebra: build a union, compare, strip nil arms, pick the receiver form.              |
| `src/core/domains/language/kernel/type-facts.ts`                | `TypeFact`, `InlineTypeSource<TInput>`, `SidecarTypeSource`, `ProjectTypeSourceContext`.            |
| `src/core/domains/language/kernel/type-fact-store.ts`           | `TypeFactStore` — precedence-resolved facts, indexed for per-chunk and per-coordinate reads.        |
| `src/core/domains/language/kernel/type-fact-channels.ts`        | `typeFactChannels(store, chunks)` → the `Partial<FileExtraction>` a type-facts facet pass emits.    |
| `tests/core/domains/language/kernel/type-ref.test.ts`           | Kernel algebra cases + the Ruby shim aliases point at the kernel functions.                         |
| `tests/core/domains/language/kernel/type-fact-store.test.ts`    | Injected order governs ALL FOUR ranked reads; empty order; line-sorted bindings; shim default.      |
| `tests/core/domains/language/kernel/type-fact-channels.test.ts` | Emit-only-non-empty, per-chunk filtering, line ordering, and composition through `mergeExtraction`. |

**Modified**

| File                                                          | Change                                                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `src/core/contracts/types/language.ts`                        | `RubyTypeRef` renamed to `TypeRef`; `export type RubyTypeRef = TypeRef` alias kept.                     |
| `src/core/domains/language/ruby/type-ref.ts`                  | Becomes a shim: re-exports the five kernel helpers under their `ruby*` names.                           |
| `src/core/domains/language/ruby/walker/type-fact-store.ts`    | Becomes a shim: `RUBY_TYPE_SOURCE_ORDER` + `RubyTypeFactStore` value/type pair over `TypeFactStore`.    |
| `src/core/domains/language/ruby/walker/type-sources/types.ts` | Becomes a shim: `RubyTypeFact` / `RubyInlineTypeSource` / `RubySidecarTypeSource` / context re-exports. |
| `src/core/domains/language/ruby/walker/file-type-env.ts`      | The one production `fromFacts` call passes `RUBY_TYPE_SOURCE_ORDER` explicitly.                         |
| `src/core/domains/language/CLAUDE.md`                         | One Mechanics bullet for the kernel store + language-owned ranks.                                       |

**Untouched, deliberately** — listed so nobody "helpfully" sweeps them:

- All 11 Ruby test files that import `RubyTypeFactStore` / `RubyTypeFact` /
  `RubyTypeRef`, plus `tests/core/domains/language/ruby/type-ref.test.ts`.
- The 36 files referencing `RubyTypeRef`. The alias keeps them compiling; a
  repo-wide rename is a separate, later, purely-cosmetic change and is NOT in
  this seam.
- `ruby/walker/type-channels.ts` and `ruby/walker/chunk-extractions.ts`. They
  keep calling the store through the shim type and keep their own precedence.
- `ruby/walker/type-sources/index.ts` and the five inline sources. Their
  `RubyInlineTypeSource` annotation resolves to the kernel generic through the
  shim, so they compile unchanged.

---

## Context the implementer needs

### Every `fromFacts` caller (verified 2026-09-09)

**Production: one.** `src/core/domains/language/ruby/walker/file-type-env.ts:54`

```ts
const store = RubyTypeFactStore.fromFacts(facts);
```

No order argument — it takes `DEFAULT_SOURCE_ORDER`, the seven Ruby ranks.

**Tests: 50 call sites across 10 files**, all through `RubyTypeFactStore`:

| File                                                       | Sites | Order passed                       |
| ---------------------------------------------------------- | ----- | ---------------------------------- |
| `ruby/walker/type-fact-store.test.ts`                      | 7     | default                            |
| `ruby/walker/type-fact-store-maps.test.ts`                 | 10    | default                            |
| `ruby/walker/type-fact-store-precedence.test.ts`           | 12    | 11 default, 1 custom               |
| `ruby/walker/type-fact-store-typeref.test.ts`              | 6     | default                            |
| `ruby/walker/type-sources/yard-scope.test.ts`              | 5     | default                            |
| `ruby/walker/type-sources/yard.test.ts`                    | 2     | default                            |
| `ruby/walker/type-sources/associations.test.ts`            | 2     | default                            |
| `ruby/walker/type-sources/body-last-expr.test.ts`          | 2     | default                            |
| `ruby/resolver/type-propagation-container.test.ts`         | 1     | default                            |
| (`ruby/resolver/ast-container-binding.integration.test.ts` | 0     | mentions it in a doc comment only) |

The one custom order is `type-fact-store-precedence.test.ts:80`,
`RubyTypeFactStore.fromFacts(facts, ["ast", "yard"])`, asserting only
`localBindingsForChunk`. That is why decision 3 holds: the four
`DEFAULT_SOURCE_ORDER`-reading methods are never exercised with a non-default
order, so instance-scoping the order is invisible to every existing assertion.

---

### What consumes each store method

| Method                     | Production consumer                       | Channel it feeds                       |
| -------------------------- | ----------------------------------------- | -------------------------------------- |
| `localBindingsForChunk`    | `ruby/walker/chunk-extractions.ts:81`     | `ChunkExtraction.localBindings`        |
| `returnTypeByMethod`       | `ruby/walker/type-channels.ts:44`         | `FileExtraction.functionReturnTypes`   |
| `structuredReturnTypesMap` | `ruby/walker/type-channels.ts:79`         | `FileExtraction.structuredReturnTypes` |
| `ivarTypesMap`             | `ruby/walker/type-channels.ts:88`         | `FileExtraction.ivarTypes`             |
| `structuredReturnType`     | none in `src/` — point lookup, tests only | —                                      |
| `ivarType`                 | none in `src/` — point lookup, tests only | —                                      |

The two point lookups have no production caller today. They stay: they are the
per-coordinate form of the two maps, they are pinned by
`type-fact-store-precedence.test.ts`, and deleting them would be a redesign.

### The two precedence rules that must NOT move into the kernel

Both live in `ruby/walker/type-channels.ts` and stay there:

1. **`:44` — store beats body inference, by last-write-wins spread.**

   ```ts
   const returnTypes = { ...bodyReturnTypes, ...store.returnTypeByMethod() };
   ```

   A YARD `@return [T]` overwrites the body-last-expression guess for the same
   method name.

2. **`:79-81` — body inference fills only where the store said nothing.**

   ```ts
   for (const [key, ref] of Object.entries(
     collectRubyScopedBodyReturnTypes(root, catalogue),
   )) {
     if (!(key in structuredReturnTypes)) structuredReturnTypes[key] = ref;
   }
   ```

   Owner-qualified body inference is merged UNDER the declared facts, so YARD /
   associations / the service-entry source keep the precedence
   `RUBY_TYPE_SOURCE_ORDER` states.

`typeFactChannels` implements neither. It publishes what the store holds and
nothing else. That asymmetry is why Ruby keeps its own channel builder in this
seam — swapping it for the helper would move rule 1 from "annotation wins" to
"whichever the merge saw first", which is a behaviour change wearing a
refactor's clothes.

### Why the `RubyTypeFactStore` shim is a const + type pair, not a subclass

`RubyTypeFactStore` is used BOTH as a value (`.fromFacts`, 50 sites) and as a
type (`RubyFileTypeEnv.store: RubyTypeFactStore` in `file-type-env.ts:39`), so
the shim has to occupy both namespaces. Verified with
`grep -rn "new RubyTypeFactStore\|instanceof RubyTypeFactStore" src tests scripts`:
the only hit is the class's own `return new RubyTypeFactStore(...)` inside
`fromFacts`. Nothing constructs it, nothing tests it with `instanceof`. So a
`const` object exposing `fromFacts` plus a `type` alias covers every use, keeps
the kernel constructor private, and needs no inheritance. TypeScript merges a
value and a type of the same name by design; typescript-eslint's `no-redeclare`
allows declaration merging. If lint disagrees on the executor's config, the
answer is to check the rule's options — NOT to rename anything or edit a test.

### Kernel path depths (get these right the first time)

From `src/core/domains/language/kernel/*.ts`:

- contracts → `../../../contracts/types/language.js`,
  `../../../contracts/types/codegraph.js` (matches `extraction-passes.ts:24`)
- sibling kernel file → `./type-facts.js`, `./type-fact-store.js`

From `src/core/domains/language/ruby/type-ref.ts` → `../kernel/type-ref.js`.
From `src/core/domains/language/ruby/walker/type-fact-store.ts` →
`../../kernel/type-fact-store.js`. From
`src/core/domains/language/ruby/walker/type-sources/types.ts` →
`../../../kernel/type-facts.js`.

---

## Task 1: `TypeRef` + `kernel/type-ref.ts`, with Ruby re-exports

**Files**

- CREATE `src/core/domains/language/kernel/type-ref.ts`
- CREATE `tests/core/domains/language/kernel/type-ref.test.ts`
- MODIFY `src/core/contracts/types/language.ts` (rename + alias, ~6 lines)
- MODIFY `src/core/domains/language/ruby/type-ref.ts` (becomes a 7-line shim)

**Interfaces**

Consumes: `TypeRef` from `contracts/types/language.js`.

Produces, from `kernel/type-ref.ts`:

```ts
export const NIL_TYPE_REF: TypeRef;
export function typeRefEquals(a: TypeRef, b: TypeRef): boolean;
export function typeRefUnionOf(
  members: readonly TypeRef[],
): TypeRef | undefined;
export function typeRefNonNilArms(ref: TypeRef): readonly TypeRef[];
export function typeRefReceiverForm(
  ref: TypeRef | undefined,
): TypeRef | undefined;
```

Produces, from `contracts/types/language.ts`:

```ts
export type TypeRef =
  | { form: "class" | "instance"; name: string }
  | { form: "union"; members: TypeRef[] }
  | { form: "container"; element: TypeRef }
  | { form: "nil" };
export type RubyTypeRef = TypeRef;
```

Produces, from `ruby/type-ref.ts` (names unchanged from today):
`RUBY_NIL_TYPE_REF`, `rubyTypeRefEquals`, `rubyUnionOf`, `rubyNonNilArms`,
`rubyReceiverForm`.

**Steps**

- [x] **RED.** Create `tests/core/domains/language/kernel/type-ref.test.ts`. It
      fails on the missing module, which is the red state for a relocation.

```ts
import { describe, expect, it } from "vitest";

import type { TypeRef } from "../../../../../src/core/contracts/types/language.js";
import {
  NIL_TYPE_REF,
  typeRefEquals,
  typeRefNonNilArms,
  typeRefReceiverForm,
  typeRefUnionOf,
} from "../../../../../src/core/domains/language/kernel/type-ref.js";
import {
  RUBY_NIL_TYPE_REF,
  rubyNonNilArms,
  rubyReceiverForm,
  rubyTypeRefEquals,
  rubyUnionOf,
} from "../../../../../src/core/domains/language/ruby/type-ref.js";

const firm: TypeRef = { form: "instance", name: "Firm" };
const user: TypeRef = { form: "instance", name: "User" };

describe("kernel TypeRef algebra", () => {
  it("compares every form structurally, unions arm-by-arm in order", () => {
    expect(typeRefEquals(firm, { form: "instance", name: "Firm" })).toBe(true);
    expect(typeRefEquals(firm, { form: "class", name: "Firm" })).toBe(false);
    expect(typeRefEquals(NIL_TYPE_REF, { form: "nil" })).toBe(true);
    expect(
      typeRefEquals(
        { form: "union", members: [firm, user] },
        { form: "union", members: [user, firm] },
      ),
    ).toBe(false);
    expect(
      typeRefEquals(
        { form: "container", element: firm },
        { form: "container", element: firm },
      ),
    ).toBe(true);
  });

  it("flattens nested unions, collapses equal arms, and a single arm IS that arm", () => {
    expect(typeRefUnionOf([])).toBeUndefined();
    expect(typeRefUnionOf([firm])).toEqual(firm);
    expect(typeRefUnionOf([firm, firm])).toEqual(firm);
    expect(
      typeRefUnionOf([{ form: "union", members: [firm, user] }, user]),
    ).toEqual({
      form: "union",
      members: [firm, user],
    });
  });

  it("strips nil arms without unwrapping containers", () => {
    expect(typeRefNonNilArms(NIL_TYPE_REF)).toEqual([]);
    expect(typeRefNonNilArms(firm)).toEqual([firm]);
    const arr: TypeRef = { form: "container", element: firm };
    expect(
      typeRefNonNilArms({ form: "union", members: [arr, NIL_TYPE_REF] }),
    ).toEqual([arr]);
  });

  it("collapses a nilable receiver to its one reachable arm, keeps a real two-arm union", () => {
    expect(typeRefReceiverForm(undefined)).toBeUndefined();
    expect(typeRefReceiverForm(NIL_TYPE_REF)).toBeUndefined();
    expect(
      typeRefReceiverForm({ form: "union", members: [firm, NIL_TYPE_REF] }),
    ).toEqual(firm);
    const twoArm: TypeRef = { form: "union", members: [firm, user] };
    expect(typeRefReceiverForm(twoArm)).toEqual(twoArm);
  });
});

describe("ruby/type-ref.ts shim", () => {
  it("re-exports the kernel functions themselves, not copies", () => {
    expect(rubyTypeRefEquals).toBe(typeRefEquals);
    expect(rubyUnionOf).toBe(typeRefUnionOf);
    expect(rubyNonNilArms).toBe(typeRefNonNilArms);
    expect(rubyReceiverForm).toBe(typeRefReceiverForm);
    expect(RUBY_NIL_TYPE_REF).toBe(NIL_TYPE_REF);
  });
});
```

- [x] **Rename the contract type.** In `src/core/contracts/types/language.ts`,
      the `export type RubyTypeRef = …` union at `:672` becomes `TypeRef`, and
      an alias takes the old name. Keep the existing docblock above `TypeRef`
      verbatim except its last sentence, which now points at the kernel: change
      "Build and compare these through `domains/language/ruby/type-ref.ts`,
      never by hand" to "`domains/language/kernel/type-ref.ts`".

```ts
export type TypeRef =
  | { form: "class" | "instance"; name: string }
  | { form: "union"; members: TypeRef[] }
  | { form: "container"; element: TypeRef }
  | { form: "nil" };

/**
 * The name this type carried while it was Ruby-only (E1 seam 2). Kept as an
 * alias so the 36 files that reference it — contracts, four Ruby resolver
 * modules, the codegraph trajectory, and eleven test files that may not be
 * rewritten — compile unchanged. New code says `TypeRef`.
 */
export type RubyTypeRef = TypeRef;
```

- [x] **Create `src/core/domains/language/kernel/type-ref.ts`.** Bodies are the
      Ruby file's, unchanged. Names lose `ruby`; the prose keeps the reasoning
      and drops the Ruby framing where it was incidental.

```ts
/**
 * The `TypeRef` algebra — the ONE place a union / nilable type reference is
 * built, compared, and taken apart (bd tea-rags-mcp-27q0z; relocated from
 * `ruby/type-ref.ts` in E1 seam 2).
 *
 * Before this existed every channel that carried a return type carried a single
 * nominal name, so a callee yielding a `Firm` on one path and `nil` on another
 * had no honest form: the type sources dropped it and consumers saw silence.
 * `nil` is now an arm like any other, which lets a fact SAY "Firm or nothing"
 * instead of choosing between saying nothing and overstating.
 *
 * The split of duties is deliberate:
 *
 *   - REPRESENTATION keeps the nil arm. Erasing it at construction would make
 *     `Firm|nil` indistinguishable from `Firm`, and a later consumer (the
 *     memoized-tail closure, a nil-guard analysis) could never recover it.
 *   - RESOLUTION drops it. A call on nil reaches no in-project definition, so
 *     the only edges a nilable receiver can produce are the ones its nominal
 *     arms produce. That policy lives in each language's `returnTypeOf`, which
 *     is where "what does calling `m` on this receiver yield" is already
 *     decided once.
 *
 * Pure data, no `contracts/` runtime dependency beyond the type itself, so the
 * cycle-sensitive `ruby/resolver/type-propagation.ts` can import it freely.
 */
import type { TypeRef } from "../../../contracts/types/language.js";

/** The nil arm — a value that dispatches to nothing. */
export const NIL_TYPE_REF: TypeRef = { form: "nil" };

/**
 * Structural equality over every `TypeRef` form. Union arms compare IN ORDER:
 * `typeRefUnionOf` fixes a deterministic order at construction, so two refs
 * built from the same facts compare equal, and a hand-built ref that genuinely
 * lists its arms differently is not silently treated as the same statement.
 */
export function typeRefEquals(a: TypeRef, b: TypeRef): boolean {
  if (a.form !== b.form) return false;
  if (a.form === "nil") return true;
  if (a.form === "container")
    return typeRefEquals(a.element, (b as { element: TypeRef }).element);
  if (a.form === "union") {
    const other = (b as { members: readonly TypeRef[] }).members;
    return (
      a.members.length === other.length &&
      a.members.every((m, i) => typeRefEquals(m, other[i]))
    );
  }
  return a.name === (b as { name: string }).name;
}

/**
 * Build the ref stating "one of these". Nested unions are flattened so arms are
 * always one level deep, structurally equal arms collapse (first occurrence
 * keeps its position), and a list that reduces to a single arm IS that arm — a
 * one-member union is not a union, and leaving one around would make every
 * consumer handle a form that says nothing extra.
 *
 * `undefined` for an empty list: no arms is no statement, which is exactly the
 * silence every type source already uses for "I don't know".
 */
export function typeRefUnionOf(
  members: readonly TypeRef[],
): TypeRef | undefined {
  const flat: TypeRef[] = [];
  const push = (ref: TypeRef): void => {
    if (ref.form === "union") {
      for (const inner of ref.members) push(inner);
      return;
    }
    if (flat.some((seen) => typeRefEquals(seen, ref))) return;
    flat.push(ref);
  };
  for (const member of members) push(member);
  if (flat.length === 0) return undefined;
  if (flat.length === 1) return flat[0];
  return { form: "union", members: flat };
}

/**
 * The arms a call on this receiver could actually dispatch to: the nil arm
 * removed, everything else kept as-is. A non-union ref is its own single arm
 * (or none, when it IS nil), so callers fold over one shape rather than
 * branching on `form` themselves.
 *
 * Container arms are returned untouched — unwrapping an element type is
 * `returnTypeOf`'s job, and doing it here would decide the member semantics in
 * the wrong place.
 */
export function typeRefNonNilArms(ref: TypeRef): readonly TypeRef[] {
  if (ref.form === "nil") return [];
  if (ref.form !== "union") return [ref];
  return ref.members.filter((m) => m.form !== "nil");
}

/**
 * The ref a RECEIVER-position consumer should see: a union with exactly one
 * reachable arm collapses to that arm, everything else passes through.
 *
 * This is where the nilable form pays for itself without costing precision. A
 * call on nil reaches no in-project definition, so a `Firm|nil` receiver
 * dispatches exactly where a `Firm` receiver does — and the collapse matters
 * because the resolution runner consults `resolveDispatch` BEFORE the exact
 * chain. Left as a union, a nilable receiver would be claimed by the union
 * dispatch component and a call that had one exact edge would come back as a
 * one-target `cone` fan-out instead: same target, weaker provenance.
 *
 * A union with TWO reachable arms is untouched — that call really can go two
 * places, and the fan-out is the correct answer. `undefined` when nothing is
 * reachable (an all-nil union, or `nil` itself), which is the same silence an
 * unknown receiver already produces; `undefined` in passes straight through so
 * callers can wrap a lookup without a null-check dance.
 */
export function typeRefReceiverForm(
  ref: TypeRef | undefined,
): TypeRef | undefined {
  if (ref === undefined) return undefined;
  const arms = typeRefNonNilArms(ref);
  if (arms.length === 0) return undefined; // `nil`, or a union of nothing but nil
  // One arm covers both the nilable collapse and every non-union form, which is
  // its own single arm — no branch on `form` needed.
  return arms.length === 1 ? arms[0] : ref;
}
```

- [x] **Replace `src/core/domains/language/ruby/type-ref.ts` with the shim.**
      The whole file, replacing all 114 lines. The reasoning docblock moved to
      the kernel with the code; leaving a copy here would be two statements of
      one fact.

```ts
/**
 * Ruby's names for the kernel `TypeRef` algebra (`kernel/type-ref.ts`), kept as
 * a shim by E1 seam 2 so the four Ruby resolver / type-source modules, the
 * recall-forensics script and `tests/.../ruby/type-ref.test.ts` keep their
 * imports. The reasoning behind each function lives with the code in the
 * kernel; nothing Ruby-specific remains here.
 */
export {
  NIL_TYPE_REF as RUBY_NIL_TYPE_REF,
  typeRefEquals as rubyTypeRefEquals,
  typeRefNonNilArms as rubyNonNilArms,
  typeRefReceiverForm as rubyReceiverForm,
  typeRefUnionOf as rubyUnionOf,
} from "../kernel/type-ref.js";
```

- [x] **GREEN + gates.** In order, all from the worktree root:

```bash
npm run build                                        # fresh worktree has no build/
npx vitest run tests/core/domains/language/kernel/type-ref.test.ts
npx vitest run tests/core/domains/language/ruby      # untouched, must be green
npm run type-check
npx eslint --max-warnings 0 \
  src/core/domains/language/kernel/type-ref.ts \
  src/core/domains/language/ruby/type-ref.ts \
  src/core/contracts/types/language.ts \
  tests/core/domains/language/kernel/type-ref.test.ts
git diff --stat -- tests/core/domains/language/ruby  # MUST be empty
```

- [x] **Commit.**

```text
refactor(language): relocate the TypeRef algebra to the kernel (fmcly)

RubyTypeRef becomes TypeRef in contracts with the old name kept as an alias,
and ruby/type-ref.ts becomes a re-export shim over kernel/type-ref.ts. The
five helpers keep their bodies and lose the ruby prefix. No consumer changes
an import; no Ruby test is touched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

## Task 2: `TypeFact` / type-source contracts + `TypeFactStore`, order injected

**Files**

- CREATE `src/core/domains/language/kernel/type-facts.ts`
- CREATE `src/core/domains/language/kernel/type-fact-store.ts`
- CREATE `tests/core/domains/language/kernel/type-fact-store.test.ts`
- MODIFY `src/core/domains/language/ruby/walker/type-fact-store.ts` (shim)
- MODIFY `src/core/domains/language/ruby/walker/type-sources/types.ts` (shim)
- MODIFY `src/core/domains/language/ruby/walker/file-type-env.ts` (2 lines)

**Interfaces**

Consumes: `TypeRef` (contracts), `LocalBinding`
(`contracts/types/codegraph.js`), `RubyExtractInput` (in the Ruby shim only).

Produces, from `kernel/type-facts.ts`:

```ts
export interface TypeFact {
  kind: "param" | "return" | "ivar" | "local" | "attr";
  source?: string;
  symbolScope: string[];
  methodName?: string;
  name?: string;
  classForm?: boolean;
  line?: number;
  type: TypeRef;
}
export interface InlineTypeSource<TInput> {
  readonly name: string;
  extract: (input: TInput) => TypeFact[];
}
export interface ProjectTypeSourceContext {
  projectRoot: string;
  files: readonly string[];
}
export interface SidecarTypeSource {
  readonly name: string;
  extractProject: (ctx: ProjectTypeSourceContext) => TypeFact[];
}
```

Produces, from `kernel/type-fact-store.ts`:

```ts
export class TypeFactStore {
  static fromFacts(
    facts: TypeFact[],
    sourceOrder: readonly string[],
  ): TypeFactStore;
  localBindingsForChunk(
    startLine: number,
    endLine: number,
  ): Record<string, LocalBinding[]>;
  returnTypeByMethod(): Record<string, string>;
  structuredReturnType(scope: string[], method: string): TypeRef | undefined;
  ivarType(scope: string[], ivar: string): TypeRef | undefined;
  structuredReturnTypesMap(): Record<string, TypeRef>;
  ivarTypesMap(): Record<string, Record<string, string>>;
}
```

Produces, from the Ruby shims (every name unchanged from today):
`RUBY_TYPE_SOURCE_ORDER` (new), `RubyTypeFactStore` (value + type),
`RubyTypeFact`, `RubyInlineTypeSource`, `RubySidecarTypeSource`,
`ProjectTypeSourceContext`.

**`ProjectTypeSourceContext.rubyFiles` becomes `files`.** That field has exactly
two occurrences in the repo — its own declaration and the `extractProject`
signature that names the interface. No source implements a sidecar today, so the
rename breaks nothing. Verify with
`grep -rn "rubyFiles\|extractProject" src tests scripts` before and after.

**Steps**

- [x] **RED.** Create
      `tests/core/domains/language/kernel/type-fact-store.test.ts`. Three of
      these cases fail today for a reason beyond the missing module: they assert
      the injected order governs the four ranked reads, which the Ruby original
      answers from its module-level `DEFAULT_SOURCE_ORDER`.

```ts
import { describe, expect, it } from "vitest";

import { TypeFactStore } from "../../../../../src/core/domains/language/kernel/type-fact-store.js";
import type { TypeFact } from "../../../../../src/core/domains/language/kernel/type-facts.js";
import {
  RUBY_TYPE_SOURCE_ORDER,
  RubyTypeFactStore,
} from "../../../../../src/core/domains/language/ruby/walker/type-fact-store.js";

const YARD_FIRST = ["yard", "ast"] as const;
const AST_FIRST = ["ast", "yard"] as const;

function returnFact(source: string, name: string): TypeFact {
  return {
    kind: "return",
    source,
    symbolScope: ["A"],
    methodName: "m",
    type: { form: "instance", name },
  };
}
function ivarFact(source: string, name: string): TypeFact {
  return {
    kind: "ivar",
    source,
    symbolScope: ["A"],
    name: "@x",
    type: { form: "instance", name },
  };
}

describe("TypeFactStore — the injected order governs EVERY ranked read", () => {
  it("ranks localBindingsForChunk by the order it was given", () => {
    const facts: TypeFact[] = [
      {
        kind: "param",
        source: "yard",
        symbolScope: [],
        name: "x",
        line: 3,
        type: { form: "instance", name: "Y" },
      },
      {
        kind: "param",
        source: "ast",
        symbolScope: [],
        name: "x",
        line: 3,
        type: { form: "instance", name: "A" },
      },
    ];
    expect(
      TypeFactStore.fromFacts(facts, YARD_FIRST).localBindingsForChunk(1, 9)[
        "x"
      ],
    ).toEqual([{ line: 3, type: "Y" }]);
    expect(
      TypeFactStore.fromFacts(facts, AST_FIRST).localBindingsForChunk(1, 9)[
        "x"
      ],
    ).toEqual([{ line: 3, type: "A" }]);
  });

  it("ranks structuredReturnType and structuredReturnTypesMap by the same order", () => {
    const facts = [returnFact("yard", "Y"), returnFact("ast", "A")];
    expect(
      TypeFactStore.fromFacts(facts, YARD_FIRST).structuredReturnType(
        ["A"],
        "m",
      ),
    ).toEqual({
      form: "instance",
      name: "Y",
    });
    expect(
      TypeFactStore.fromFacts(facts, AST_FIRST).structuredReturnType(
        ["A"],
        "m",
      ),
    ).toEqual({
      form: "instance",
      name: "A",
    });
    expect(
      TypeFactStore.fromFacts(facts, AST_FIRST).structuredReturnTypesMap()[
        "A#m"
      ],
    ).toEqual({
      form: "instance",
      name: "A",
    });
  });

  it("ranks ivarType and ivarTypesMap by the same order", () => {
    const facts = [ivarFact("yard", "Y"), ivarFact("ast", "A")];
    expect(
      TypeFactStore.fromFacts(facts, AST_FIRST).ivarType(["A"], "@x"),
    ).toEqual({ form: "instance", name: "A" });
    expect(
      TypeFactStore.fromFacts(facts, AST_FIRST).ivarTypesMap()["A"],
    ).toEqual({ "@x": "A" });
    expect(
      TypeFactStore.fromFacts(facts, YARD_FIRST).ivarTypesMap()["A"],
    ).toEqual({ "@x": "Y" });
  });

  it("an empty order ranks everything equal, so the first fact seen wins", () => {
    const store = TypeFactStore.fromFacts(
      [returnFact("ast", "A"), returnFact("yard", "Y")],
      [],
    );
    expect(store.structuredReturnTypesMap()["A#m"]).toEqual({
      form: "instance",
      name: "A",
    });
  });

  it("keeps each variable's bindings sorted by line", () => {
    const at = (line: number, name: string): TypeFact => ({
      kind: "local",
      source: "ast",
      symbolScope: [],
      name: "v",
      line,
      type: { form: "instance", name },
    });
    const bindings = TypeFactStore.fromFacts(
      [at(9, "Late"), at(2, "Early")],
      AST_FIRST,
    ).localBindingsForChunk(1, 20);
    expect(bindings["v"]?.map((b) => b.line)).toEqual([2, 9]);
  });
});

describe("RubyTypeFactStore shim", () => {
  it("states the seven Ruby ranks and applies them when no order is passed", () => {
    expect(RUBY_TYPE_SOURCE_ORDER).toEqual([
      "sorbet",
      "rbs",
      "yard",
      "associations",
      "draper",
      "body-last-expr",
      "ast",
    ]);
    const store = RubyTypeFactStore.fromFacts([
      returnFact("ast", "A"),
      returnFact("yard", "Y"),
    ]);
    expect(store.structuredReturnTypesMap()["A#m"]).toEqual({
      form: "instance",
      name: "Y",
    });
  });
});
```

- [x] **Create `src/core/domains/language/kernel/type-facts.ts`.** The four
      declarations move verbatim; only the names and the `TInput` generic
      change, plus `rubyFiles` → `files`.

```ts
/**
 * What a type source produces and what shape a type source has (E1 seam 2,
 * relocated from `ruby/walker/type-sources/types.ts`).
 *
 * A `TypeFact` is one receiver-type claim at one symbol coordinate. Facts are
 * language-neutral: the SOURCE names (`"yard"`, `"annotations"`, `"docstring"`)
 * and their precedence are the language's data, resolved by `TypeFactStore`
 * against the order that language injects. The kernel never decides that a
 * `sig` outranks an inferred assignment.
 */
import type { TypeRef } from "../../../contracts/types/language.js";

/** One receiver-type fact a source attributes to a symbol coordinate. */
export interface TypeFact {
  kind: "param" | "return" | "ivar" | "local" | "attr";
  /** Source name that produced this fact — used for precedence resolution in {@link TypeFactStore}. */
  source?: string;
  /** Enclosing class/module FQ scope, e.g. ["Octokit","Client"]. */
  symbolScope: string[];
  /** Owning def short name (param/return/local). Undefined for class-level ivar/attr. */
  methodName?: string;
  /** Param / ivar / local var name. Undefined for `return`. */
  name?: string;
  /**
   * `true` when the fact documents a CLASS-level member (Ruby `@!method
   * self.call`, Python `@classmethod`) rather than an instance one. The store
   * then joins the coordinate with `.` instead of `#`, keeping `Class.call` and
   * `Class#call` — genuinely different methods — from overwriting each other
   * (bd tea-rags-mcp-8ypeu).
   */
  classForm?: boolean;
  /** 1-based source line for position-scoped inline facts; undefined for sidecar/name-keyed facts. */
  line?: number;
  type: TypeRef;
}

/**
 * A type source colocated in the source file itself (Ruby YARD comments and
 * Sorbet `sig {}`, Python annotations and docstrings). Generic over the
 * language's extract input so the kernel never names a language's walker type.
 */
export interface InlineTypeSource<TInput> {
  readonly name: string;
  extract: (input: TInput) => TypeFact[];
}

/** Inputs a sidecar source receives once per project (pre-pass). */
export interface ProjectTypeSourceContext {
  /** Absolute project root. */
  projectRoot: string;
  /** Relative paths of the source files being indexed (join target by FQ name). */
  files: readonly string[];
}

/**
 * A type source living in separate signature files (`sig/*.rbs`, `sorbet/rbi/`,
 * `*.pyi` stubs). Runs once per project, not once per file.
 */
export interface SidecarTypeSource {
  readonly name: string;
  extractProject: (ctx: ProjectTypeSourceContext) => TypeFact[];
}
```

- [x] **Create `src/core/domains/language/kernel/type-fact-store.ts`, part 1 —
      header and the six module-private helpers.** Bodies verbatim from
      `ruby/walker/type-fact-store.ts`; `RubyTypeRef` → `TypeRef`,
      `RubyTypeFact` → `TypeFact`, and the `DEFAULT_SOURCE_ORDER` const is NOT
      carried over.

```ts
/**
 * `TypeFactStore` — precedence-resolved type facts for one file, indexed for
 * the four channels a type-facts extraction pass publishes (E1 seam 2,
 * relocated from `ruby/walker/type-fact-store.ts`).
 *
 * The store resolves COLLISIONS, not policy. Which source outranks which is the
 * language's data, injected as `sourceOrder` at `fromFacts` and held on the
 * instance — Ruby says yard › associations › draper › body-last-expr › ast,
 * Python will say annotations › stubs › docstring › orm › body › ast, and the
 * store applies whichever it was handed to EVERY ranked read. (The Ruby
 * original took the order for its coordinate dedupe but re-read a module-level
 * default in `structuredReturnType` / `ivarType` and their map forms; that
 * split is closed here. No caller ever exercised it — production only ever
 * passed the default.)
 *
 * A source name absent from the order ranks `Infinity`, which is "lowest", not
 * "invalid": an unregistered source still contributes a fact when nothing else
 * claims that coordinate.
 */
import type { LocalBinding } from "../../../contracts/types/codegraph.js";
import type { TypeRef } from "../../../contracts/types/language.js";
import type { TypeFact } from "./type-facts.js";

/** Flatten a TypeRef to the bare class name today's LocalBinding.type holds. */
function refToName(ref: TypeRef): string | undefined {
  if (ref.form === "class" || ref.form === "instance") return ref.name;
  if (ref.form === "container") return refToName(ref.element); // element wins (today's Array<Post> -> Post)
  // union / nil: no single name. A nilable union deliberately does NOT collapse
  // to its one nominal arm here (bd tea-rags-mcp-27q0z) — this feeds the FLAT,
  // corpus-wide `functionReturnTypes` / `ivarTypes` channels, where a fact keyed
  // by bare name already speaks for every same-named method in the project
  // (bd h4hxh). The nilable form stays in the owner-qualified structured channel
  // that can afford it.
  return undefined;
}

/**
 * Best-effort string name for union: the first member's refToName.
 * Used to populate LocalBinding.type when typeRef carries the full union
 * (INFRA-A: union params were previously dropped; now emitted with a
 * best-effort string + the full typeRef for the engine).
 */
function firstMemberName(ref: TypeRef): string | undefined {
  if (ref.form !== "union") return undefined;
  const first = ref.members[0];
  return first !== undefined ? refToName(first) : undefined;
}

/**
 * Resolve source precedence rank: lower index = higher precedence.
 * Undefined or unknown source → Infinity (lowest precedence).
 */
function sourceRank(
  source: string | undefined,
  order: readonly string[],
): number {
  if (source === undefined) return Infinity;
  const i = order.indexOf(source);
  return i === -1 ? Infinity : i;
}

/**
 * Coordinate key for precedence deduplication of same-position facts.
 * Only collides when kind + scope + methodName + name + line are all identical
 * (the same binding site from two different sources). Different positions
 * (different `line`) are different coordinates and are both retained.
 */
function coordinateKey(f: TypeFact): string {
  return `${f.kind}|${f.symbolScope.join(",")}|${f.methodName ?? ""}|${f.name ?? ""}|${f.line ?? ""}`;
}

/**
 * Coordinate key for return-type facts keyed by scope + methodName.
 * Line is intentionally excluded — sidecar/name-keyed return facts lack a line.
 */
function returnCoordKey(scope: string[], methodName: string): string {
  return `${scope.join(",")}|${methodName}`;
}

/** Coordinate key for ivar facts keyed by scope + ivar name. */
function ivarCoordKey(scope: string[], ivar: string): string {
  return `${scope.join(",")}|${ivar}`;
}
```

- [x] **Part 2 — the class, in the same file.** Two changes from the Ruby
      original and no others: the constructor takes `sourceOrder` and holds it,
      and the four ranked reads use `this.sourceOrder` where they read
      `DEFAULT_SOURCE_ORDER`. Method bodies otherwise verbatim, including every
      docblock (with `RubyTypeRef` → `TypeRef`).

```ts
export class TypeFactStore {
  private readonly resolvedFacts: readonly TypeFact[];
  /** The language's source precedence, applied to EVERY ranked read below. */
  private readonly sourceOrder: readonly string[];

  private constructor(
    resolvedFacts: readonly TypeFact[],
    sourceOrder: readonly string[],
  ) {
    this.resolvedFacts = resolvedFacts;
    this.sourceOrder = sourceOrder;
  }

  /**
   * Resolve a flat fact list into the store. `sourceOrder` is REQUIRED — the
   * kernel has no default precedence, because a default would silently hand one
   * language another's ranks. Callers pass their own constant
   * (`RUBY_TYPE_SOURCE_ORDER`, `PYTHON_TYPE_SOURCE_ORDER`).
   */
  static fromFacts(
    facts: TypeFact[],
    sourceOrder: readonly string[],
  ): TypeFactStore {
    // Group by coordinate key; keep the fact with the highest-precedence source.
    const byCoord = new Map<string, TypeFact>();
    for (const f of facts) {
      const key = coordinateKey(f);
      const existing = byCoord.get(key);
      if (
        !existing ||
        sourceRank(f.source, sourceOrder) <
          sourceRank(existing.source, sourceOrder)
      ) {
        byCoord.set(key, f);
      }
    }
    return new TypeFactStore(Array.from(byCoord.values()), sourceOrder);
  }

  localBindingsForChunk(
    startLine: number,
    endLine: number,
  ): Record<string, LocalBinding[]> {
    const out: Record<string, LocalBinding[]> = {};
    for (const f of this.resolvedFacts) {
      if (f.kind !== "param" && f.kind !== "local") continue;
      if (f.line === undefined || f.line < startLine || f.line > endLine) {
        continue;
      }
      const { name } = f;
      // For union/container: typeRef carries the full ref; type = best-effort string.
      // For class/instance: typeRef not needed (string suffices, parity preserved).
      const isUnionOrContainer =
        f.type.form === "union" || f.type.form === "container";
      const type = isUnionOrContainer
        ? (refToName(f.type) ?? firstMemberName(f.type) ?? "")
        : refToName(f.type);
      if (!name || type === undefined) continue;
      const binding: LocalBinding = { line: f.line, type };
      if (f.type.form === "class") binding.valueKind = "class";
      if (isUnionOrContainer) binding.typeRef = f.type;
      (out[name] ??= []).push(binding);
    }
    for (const list of Object.values(out)) list.sort((a, b) => a.line - b.line);
    return out;
  }

  returnTypeByMethod(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const f of this.resolvedFacts) {
      if (f.kind !== "return" || !f.methodName) continue;
      const type = refToName(f.type);
      if (type !== undefined) out[f.methodName] = type;
    }
    return out;
  }

  /**
   * Full TypeRef for a method's return type (union/container preserved).
   * Scope is matched as a joined string; method name is exact.
   */
  structuredReturnType(scope: string[], method: string): TypeRef | undefined {
    const targetCoord = returnCoordKey(scope, method);
    // Among return facts for this coord, pick by source precedence.
    // (Position-keyed facts are already deduplicated in resolvedFacts;
    // return facts are name-keyed so we do a secondary pass here.)
    let best: TypeFact | undefined;
    let bestRank = Infinity;
    for (const f of this.resolvedFacts) {
      if (f.kind !== "return" || !f.methodName) continue;
      if (returnCoordKey(f.symbolScope, f.methodName) !== targetCoord) continue;
      const rank = sourceRank(f.source, this.sourceOrder);
      if (!best || rank < bestRank) {
        best = f;
        bestRank = rank;
      }
    }
    return best?.type;
  }

  /**
   * Full TypeRef for an instance variable (union/container preserved).
   * Scope is matched as a joined string; ivar name is exact.
   */
  ivarType(scope: string[], ivar: string): TypeRef | undefined {
    const targetCoord = ivarCoordKey(scope, ivar);
    let best: TypeFact | undefined;
    let bestRank = Infinity;
    for (const f of this.resolvedFacts) {
      if (f.kind !== "ivar" || !f.name) continue;
      if (ivarCoordKey(f.symbolScope, f.name) !== targetCoord) continue;
      const rank = sourceRank(f.source, this.sourceOrder);
      if (!best || rank < bestRank) {
        best = f;
        bestRank = rank;
      }
    }
    return best?.type;
  }

  /**
   * Full `"<fqClass>#<method>" → TypeRef` map over every return fact, in the
   * engine's `structuredReturnTypes` key convention (the codegraph
   * `fqMethodKey`): fq class = `symbolScope.join("::")`, member joined with `#`
   * — the instance form, which is also what the engine looks up for a class
   * receiver, so a `def self.x` `@return` keeps answering `Klass.x` chains.
   * The one exception is a fact that explicitly declares itself class-level
   * (`TypeFact.classForm`, set by an `@!method self.x` directive): it joins
   * with `.` so it cannot overwrite the same class's real instance method.
   * Union / container refs are preserved verbatim. Source precedence matches the
   * {@link structuredReturnType} point lookup: the highest-precedence source
   * (lowest `sourceRank`) wins per key.
   */
  structuredReturnTypesMap(): Record<string, TypeRef> {
    const out: Record<string, TypeRef> = {};
    const bestRank = new Map<string, number>();
    for (const f of this.resolvedFacts) {
      if (f.kind !== "return" || !f.methodName) continue;
      const key = `${f.symbolScope.join("::")}${f.classForm === true ? "." : "#"}${f.methodName}`;
      const rank = sourceRank(f.source, this.sourceOrder);
      const prev = bestRank.get(key);
      if (prev === undefined || rank < prev) {
        out[key] = f.type;
        bestRank.set(key, rank);
      }
    }
    return out;
  }

  /**
   * Full `fqClass → "@ivar" → typeName` map over every ivar fact, in the engine's
   * `ivarTypes` key convention: fq class = `symbolScope.join("::")`, ivar name
   * retains its leading `@`. The value is the bare type NAME reduced via the same
   * {@link refToName} the point lookups use (container → element name; union →
   * undefined and skipped, since the string-valued map cannot carry a union).
   * Source precedence matches the {@link ivarType} point lookup: the
   * highest-precedence string-reducible source wins per `(fqClass, @ivar)`.
   */
  ivarTypesMap(): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};
    const bestRank = new Map<string, number>();
    for (const f of this.resolvedFacts) {
      if (f.kind !== "ivar" || !f.name) continue;
      const type = refToName(f.type);
      if (type === undefined) continue;
      const fqClass = f.symbolScope.join("::");
      const coord = ivarCoordKey(f.symbolScope, f.name);
      const rank = sourceRank(f.source, this.sourceOrder);
      const prev = bestRank.get(coord);
      if (prev === undefined || rank < prev) {
        (out[fqClass] ??= {})[f.name] = type;
        bestRank.set(coord, rank);
      }
    }
    return out;
  }
}
```

- [x] **Replace `src/core/domains/language/ruby/walker/type-fact-store.ts` with
      the shim.** All 231 lines go; these 30 replace them.
      `RUBY_TYPE_SOURCE_ORDER` keeps the original's docblock, because the reason
      those seven ranks are in that order is Ruby knowledge and belongs here,
      not in the kernel.

```ts
/**
 * Ruby's type-fact store: the kernel `TypeFactStore` plus Ruby's source
 * precedence (E1 seam 2). The store moved; the ranks did not — which source
 * outranks which is language data, and this file is where Ruby states it.
 *
 * `RubyTypeFactStore` is a value + type pair rather than a class: it is used as
 * both (`.fromFacts` at 50 call sites, `RubyFileTypeEnv.store` as a type), and
 * nothing in the repo constructs it or tests it with `instanceof`.
 */
import { TypeFactStore } from "../../kernel/type-fact-store.js";
import type { TypeFact } from "../../kernel/type-facts.js";

/** Ruby source precedence: first = strongest. `associations` (Rails DSL
 *  inflection) ranks below YARD annotations; `body-last-expr` (service `call` /
 *  `perform` body last-expression inference) ranks below both — an annotation or
 *  a macro-declared type always beats a body-inferred return — but above raw AST
 *  local inference. */
export const RUBY_TYPE_SOURCE_ORDER: readonly string[] = [
  "sorbet",
  "rbs",
  "yard",
  "associations",
  "draper",
  "body-last-expr",
  "ast",
];

export type RubyTypeFactStore = TypeFactStore;

export const RubyTypeFactStore = {
  /** Ruby ranks by default so the walker suite's 49 order-less call sites keep
   *  their meaning; `file-type-env.ts` passes the order explicitly anyway. */
  fromFacts(
    facts: TypeFact[],
    sourceOrder: readonly string[] = RUBY_TYPE_SOURCE_ORDER,
  ): TypeFactStore {
    return TypeFactStore.fromFacts(facts, sourceOrder);
  },
};
```

- [x] **Replace `src/core/domains/language/ruby/walker/type-sources/types.ts`
      with the shim.** All four declarations become re-exports; the
      `RubyExtractInput` binding is what the generic exists for.

```ts
/**
 * Ruby's names for the kernel type-source contracts (`kernel/type-facts.ts`),
 * kept as a shim by E1 seam 2 so the five inline sources, the source registry
 * and the type-source suite keep their imports. `RubyInlineTypeSource` is the
 * kernel generic bound to Ruby's walker input — the one Ruby-specific fact
 * left in this file.
 */
import type { InlineTypeSource } from "../../../kernel/type-facts.js";
import type { RubyExtractInput } from "../walker.js";

export type {
  ProjectTypeSourceContext,
  SidecarTypeSource as RubySidecarTypeSource,
  TypeFact as RubyTypeFact,
} from "../../../kernel/type-facts.js";

/** A type source colocated in the `.rb` file (YARD comments, Sorbet `sig {}` / `T.let`). */
export type RubyInlineTypeSource = InlineTypeSource<RubyExtractInput>;
```

- [x] **Pass the order explicitly at the one production call site.** In
      `src/core/domains/language/ruby/walker/file-type-env.ts`, add
      `RUBY_TYPE_SOURCE_ORDER` to the existing import from
      `./type-fact-store.js` and change line 54:

```ts
const store = RubyTypeFactStore.fromFacts(facts, RUBY_TYPE_SOURCE_ORDER);
```

      The import line becomes:

```ts
import {
  RUBY_TYPE_SOURCE_ORDER,
  RubyTypeFactStore,
} from "./type-fact-store.js";
```

- [x] **GREEN + gates.**

```bash
npx vitest run tests/core/domains/language/kernel
npx vitest run tests/core/domains/language/ruby
npm run type-check
npx eslint --max-warnings 0 \
  src/core/domains/language/kernel \
  src/core/domains/language/ruby/walker \
  tests/core/domains/language/kernel
git diff --stat -- tests/core/domains/language/ruby   # MUST be empty
```

- [x] **Re-verify the importer inventory.** These must return the SAME file
      lists as the ones recorded in "Context the implementer needs":

```bash
/usr/bin/grep -rln "RubyTypeFactStore" src tests scripts
/usr/bin/grep -rln "RubyTypeFact\b" src tests scripts
/usr/bin/grep -rln "RubyInlineTypeSource" src tests scripts
/usr/bin/grep -rn "rubyFiles" src tests scripts     # must return NOTHING
```

- [x] **Parity harness.** Record the wall clock; it is the Task 4 baseline.

```bash
time npx tsx scripts/spikes/ruby-walker-composition-parity.ts \
  --corpus ~/Dev/Tools/tea-rags-bench/corpora/mastodon --limit 20000
```

      Expect `mismatches 0`. Read the Global Constraints caveat on what that
      does and does not prove.

- [x] **Commit.**

```text
refactor(language): relocate TypeFactStore and the type-source contracts (fmcly)

TypeFact, InlineTypeSource<TInput>, SidecarTypeSource and TypeFactStore move to
the kernel; Ruby's walker/type-fact-store.ts and type-sources/types.ts become
re-export shims. sourceOrder is now required at fromFacts and held on the
instance, so structuredReturnType / ivarType and their map forms rank by the
order they were given instead of a module-level default — a split no caller
exercised. RUBY_TYPE_SOURCE_ORDER stays Ruby data. No Ruby test is touched.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

## Task 3: `typeFactChannels` — the store's output as a pass's partial

Net-new. No existing behaviour changes; nothing calls this yet. It exists so
Python's E2 annotation pass is three lines instead of a channel builder, and so
the decision about which channels a type-facts pass owns is made once, here.

**Files**

- CREATE `src/core/domains/language/kernel/type-fact-channels.ts`
- CREATE `tests/core/domains/language/kernel/type-fact-channels.test.ts`

**Interfaces**

Consumes: `TypeFactStore` (`./type-fact-store.js`), `WalkContext["chunks"]`
(`contracts/types/language.js`), `ChunkExtraction` / `FileExtraction`
(`contracts/types/codegraph.js`).

Produces:

```ts
export function typeFactChannels(
  store: TypeFactStore,
  chunks: WalkContext["chunks"],
): Partial<FileExtraction>;
```

`WalkContext["chunks"]` is
`{ symbolId: string; startLine: number; endLine: number; scope: string[] }[]` —
exactly what a pass receives in `ctx`, so a pass calls
`typeFactChannels(store, ctx.chunks)` with nothing to assemble.

**Steps**

- [x] **RED.** Create
      `tests/core/domains/language/kernel/type-fact-channels.test.ts`.

```ts
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../src/core/contracts/types/codegraph.js";
import type { WalkContext } from "../../../../../src/core/contracts/types/language.js";
import { mergeExtraction } from "../../../../../src/core/domains/language/kernel/merge-extraction.js";
import { typeFactChannels } from "../../../../../src/core/domains/language/kernel/type-fact-channels.js";
import { TypeFactStore } from "../../../../../src/core/domains/language/kernel/type-fact-store.js";
import type { TypeFact } from "../../../../../src/core/domains/language/kernel/type-facts.js";

const ORDER = ["annotations", "ast"] as const;

const CHUNKS: WalkContext["chunks"] = [
  { symbolId: "app.svc#run", startLine: 1, endLine: 10, scope: ["Svc"] },
  { symbolId: "app.svc#idle", startLine: 11, endLine: 20, scope: ["Svc"] },
];

function paramFact(line: number, name: string, type: string): TypeFact {
  return {
    kind: "param",
    source: "annotations",
    symbolScope: ["Svc"],
    methodName: "run",
    name,
    line,
    type: { form: "instance", name: type },
  };
}

describe("typeFactChannels", () => {
  it("emits nothing at all for an empty store", () => {
    const out = typeFactChannels(TypeFactStore.fromFacts([], ORDER), CHUNKS);
    expect(Object.keys(out)).toEqual([]);
  });

  it("emits only the channels the facts actually populate", () => {
    const out = typeFactChannels(
      TypeFactStore.fromFacts([paramFact(4, "req", "Request")], ORDER),
      CHUNKS,
    );
    expect(Object.keys(out).sort()).toEqual(["chunks"]);
    expect(out.chunks).toEqual([
      {
        symbolId: "app.svc#run",
        scope: ["Svc"],
        startLine: 1,
        endLine: 10,
        calls: [],
        localBindings: { req: [{ line: 4, type: "Request" }] },
      },
    ]);
  });

  it("skips a chunk whose line range holds no binding", () => {
    const out = typeFactChannels(
      TypeFactStore.fromFacts([paramFact(4, "req", "Request")], ORDER),
      CHUNKS,
    );
    expect(out.chunks?.map((c) => c.symbolId)).toEqual(["app.svc#run"]);
  });

  it("keeps each variable's bindings sorted by line", () => {
    const store = TypeFactStore.fromFacts(
      [paramFact(8, "v", "Late"), paramFact(2, "v", "Early")],
      ORDER,
    );
    expect(
      typeFactChannels(store, CHUNKS).chunks?.[0]?.localBindings?.["v"]?.map(
        (b) => b.line,
      ),
    ).toEqual([2, 8]);
  });

  it("emits the three file-level channels from return and ivar facts", () => {
    const facts: TypeFact[] = [
      {
        kind: "return",
        source: "annotations",
        symbolScope: ["Svc"],
        methodName: "run",
        type: { form: "instance", name: "Result" },
      },
      {
        kind: "ivar",
        source: "annotations",
        symbolScope: ["Svc"],
        name: "@repo",
        type: { form: "instance", name: "Repo" },
      },
    ];
    const out = typeFactChannels(TypeFactStore.fromFacts(facts, ORDER), CHUNKS);
    expect(Object.keys(out).sort()).toEqual([
      "functionReturnTypes",
      "ivarTypes",
      "structuredReturnTypes",
    ]);
    expect(out.functionReturnTypes).toEqual({ run: "Result" });
    expect(out.structuredReturnTypes).toEqual({
      "Svc#run": { form: "instance", name: "Result" },
    });
    expect(out.ivarTypes).toEqual({ Svc: { "@repo": "Repo" } });
  });

  it("leaves a base extraction's absent channels absent when merged", () => {
    const base: FileExtraction = {
      relPath: "app/svc.py",
      language: "python",
      imports: [],
      fileScope: [],
      chunks: [{ symbolId: "app.svc#run", scope: ["Svc"], calls: [] }],
    };
    const merged = mergeExtraction(
      base,
      typeFactChannels(TypeFactStore.fromFacts([], ORDER), CHUNKS),
    );
    expect("functionReturnTypes" in merged).toBe(false);
    expect("ivarTypes" in merged).toBe(false);
    expect(merged.chunks).toEqual(base.chunks);
  });

  it("merges into the chunk the walker already emitted, matched by symbolId", () => {
    const base: FileExtraction = {
      relPath: "app/svc.py",
      language: "python",
      imports: [],
      fileScope: [],
      chunks: [{ symbolId: "app.svc#run", scope: ["Svc"], calls: [] }],
    };
    const store = TypeFactStore.fromFacts(
      [paramFact(4, "req", "Request")],
      ORDER,
    );
    const merged = mergeExtraction(base, typeFactChannels(store, CHUNKS));
    expect(merged.chunks).toHaveLength(1);
    expect(merged.chunks[0]?.localBindings).toEqual({
      req: [{ line: 4, type: "Request" }],
    });
  });
});
```

- [x] **GREEN.** Create
      `src/core/domains/language/kernel/type-fact-channels.ts`.

```ts
/**
 * `typeFactChannels` — a built `TypeFactStore` rendered as the
 * `Partial<FileExtraction>` a type-facts extraction pass returns (E1 seam 2).
 *
 * The store answers four questions; this decides which `FileExtraction` channel
 * each answer belongs to, once, so a language's annotation pass is
 * `sources → TypeFactStore.fromFacts(facts, ORDER) → typeFactChannels` and
 * nothing else. Python's E2 annotation pass is the first consumer.
 *
 * What it deliberately does NOT do is MERGE. Ruby's `walker/type-channels.ts`
 * publishes the same four channels but folds two other sources in around them —
 * a YARD `@return` overwrites body inference, and owner-qualified body inference
 * fills only where the store said nothing. Those are Ruby precedence decisions
 * that live inside Ruby's monolith (Model A), so Ruby keeps its own builder and
 * this helper stays a projection with no policy of its own.
 *
 * Empty is absent, everywhere: a chunk with no bindings produces no record, a
 * channel with no entries is never set, and the returned object for an empty
 * store has no keys at all. That is what lets `mergeExtraction` hold its
 * "absent stays absent" property without pruning after the fact — an empty `{}`
 * reaching the NDJSON spill moves the payload the schema-drift guard compares.
 */
import type {
  ChunkExtraction,
  FileExtraction,
} from "../../../contracts/types/codegraph.js";
import type { WalkContext } from "../../../contracts/types/language.js";
import type { TypeFactStore } from "./type-fact-store.js";

export function typeFactChannels(
  store: TypeFactStore,
  chunks: WalkContext["chunks"],
): Partial<FileExtraction> {
  const out: Partial<FileExtraction> = {};

  // Per-chunk local bindings. `symbolId` is copied verbatim from the chunk list
  // — the pass never composes an id, so the merge matches the walker's own
  // record and a pass can never invent a chunk the chunker did not emit.
  // `calls: []` satisfies the required channel and is pruned by the merge's
  // empty check, so it never materialises on the walker's record.
  const chunkRecords: ChunkExtraction[] = [];
  for (const chunk of chunks) {
    const localBindings = store.localBindingsForChunk(
      chunk.startLine,
      chunk.endLine,
    );
    if (Object.keys(localBindings).length === 0) continue;
    chunkRecords.push({
      symbolId: chunk.symbolId,
      scope: chunk.scope,
      startLine: chunk.startLine,
      endLine: chunk.endLine,
      calls: [],
      localBindings,
    });
  }
  if (chunkRecords.length > 0) out.chunks = chunkRecords;

  const functionReturnTypes = store.returnTypeByMethod();
  if (Object.keys(functionReturnTypes).length > 0)
    out.functionReturnTypes = functionReturnTypes;

  const structuredReturnTypes = store.structuredReturnTypesMap();
  if (Object.keys(structuredReturnTypes).length > 0)
    out.structuredReturnTypes = structuredReturnTypes;

  const ivarTypes = store.ivarTypesMap();
  if (Object.keys(ivarTypes).length > 0) out.ivarTypes = ivarTypes;

  return out;
}
```

      `localBindings` needs no sort here — `localBindingsForChunk` already sorts
      each variable's array by line, and `mergeLocalBindings` re-sorts on a
      collision. The test pins the property at this layer anyway, because a
      future reader of this file should not have to go read the store to know
      whether the order is guaranteed.

- [x] **Gates.**

```bash
npx vitest run tests/core/domains/language/kernel
npm run type-check
npx eslint --max-warnings 0 \
  src/core/domains/language/kernel/type-fact-channels.ts \
  tests/core/domains/language/kernel/type-fact-channels.test.ts
git diff --stat -- tests/core/domains/language/ruby   # MUST be empty
```

- [x] **Commit.**

```text
feat(language): add typeFactChannels, the type-facts pass projection (fmcly)

Renders a built TypeFactStore as the Partial<FileExtraction> an extraction
facet pass returns: per-chunk localBindings plus functionReturnTypes,
structuredReturnTypes and ivarTypes, each emitted only when non-empty. No
merging and no precedence of its own — Ruby keeps its two inversions inside
walker/type-channels.ts. First consumer is Python's E2 annotation pass.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

## Task 4: seam gates + the navigator paragraph

**Files**

- MODIFY `src/core/domains/language/CLAUDE.md` (one Mechanics bullet)

**Interfaces**

Consumes nothing, produces nothing. This task is the evidence that Tasks 1-3 are
a relocation, plus the one paragraph that tells the next agent where type facts
live and who owns the ranks.

**Steps**

- [ ] **Full unit gate.** `npm run test:coverage` — the release gate, not
      `npm test` (pre-commit skips coverage). If coverage drops below threshold,
      delegate to the `coverage-expander` subagent with
      `run_in_background: true`; do not write the tests inline and do not lower
      a threshold.

- [ ] **Lint and types across everything the seam touched.**

```bash
npm run type-check
npx eslint --max-warnings 0 src/ tests/
```

- [ ] **Ruby suite untouched and green.** Both halves matter — the second is the
      one that catches a shim that quietly changed a signature.

```bash
npx vitest run tests/core/domains/language/ruby
git diff --stat -- tests/core/domains/language/ruby   # MUST be empty
```

- [ ] **Parity harness, timed, against the Task 2 baseline.**

```bash
time npx tsx scripts/spikes/ruby-walker-composition-parity.ts \
  --corpus ~/Dev/Tools/tea-rags-bench/corpora/mastodon --limit 20000
```

      `mismatches 0`, wall clock within +10% of the number recorded in Task 2.
      Over +10%: profile before explaining it away — the relocation adds one
      property read per rank comparison and one call indirection per
      `fromFacts`, which is not a 10% shape.

- [ ] **Optional corpus-level before/after.** If a stronger relocation proof is
      wanted than "the suite is green", the honest one is the tally, run once on
      the pre-Task-1 commit and once on HEAD, with `edges` / `fileOnly` /
      `unresolved` identical (relocation protocol step 3(b)):

```bash
npx tsx scripts/codegraph-chain-tally.ts --lang ruby \
  --corpus ~/Dev/Tools/tea-rags-bench/corpora/mastodon
```

- [ ] **Add the navigator bullet.** In `src/core/domains/language/CLAUDE.md`,
      append to the `## Mechanics` section, directly after the extraction-pass
      bullet it continues:

```markdown
- **Type facts: kernel store, language-owned ranks.** `kernel/type-facts.ts`
  declares `TypeFact` / `InlineTypeSource<TInput>` / `SidecarTypeSource`,
  `kernel/type-fact-store.ts` resolves collisions, and
  `kernel/type-fact-channels.ts` renders a built store as the four channels a
  pass publishes (`localBindings` per chunk, `functionReturnTypes`,
  `structuredReturnTypes`, `ivarTypes`, each only when non-empty). Which source
  outranks which is NOT in the kernel: `fromFacts(facts, sourceOrder)` requires
  the order and holds it on the instance, so Ruby passes
  `RUBY_TYPE_SOURCE_ORDER` (seven ranks, `ruby/walker/type-fact-store.ts`) and
  Python will pass its own. A Python facet is
  `sources → TypeFactStore.fromFacts(facts, PYTHON_TYPE_SOURCE_ORDER) → typeFactChannels`
  inside one `ExtractionFacetPass`. Ruby does NOT use `typeFactChannels` —
  `ruby/walker/type-channels.ts` folds two more sources in around the store
  (YARD `@return` overwrites body inference at `:44`; owner-qualified body
  inference fills only where the store was silent at `:79`), and those
  inversions stay inside the monolith. Why: a kernel default order would
  silently hand one language another's precedence, and moving Ruby onto the
  plain projection would turn "annotation wins" into "whichever the merge saw
  first" — a behaviour change wearing a refactor's clothes.
```

- [ ] **Commit.**

```text
refactor(language): record the kernel type-fact seam in the navigator (fmcly)

One Mechanics bullet: where the store and the type-source contracts live, that
sourceOrder is language data injected at fromFacts, that typeFactChannels is
the projection a Python facet composes, and why Ruby keeps its own channel
builder. Closes E1 seam 2 after the full gate.

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
```

---

## Self-review before handing back

- [ ] Kernel symbol names are identical everywhere they appear in this plan and
      in the code: `TypeRef`, `NIL_TYPE_REF`, `typeRefEquals`, `typeRefUnionOf`,
      `typeRefNonNilArms`, `typeRefReceiverForm`, `TypeFact`,
      `InlineTypeSource`, `SidecarTypeSource`, `ProjectTypeSourceContext`,
      `TypeFactStore`, `typeFactChannels`, `RUBY_TYPE_SOURCE_ORDER`.
- [ ] Every Ruby name that existed before still resolves from the same path:
      `RubyTypeRef`, `RUBY_NIL_TYPE_REF`, `rubyTypeRefEquals`, `rubyUnionOf`,
      `rubyNonNilArms`, `rubyReceiverForm`, `RubyTypeFact`, `RubyTypeFactStore`,
      `RubyInlineTypeSource`, `RubySidecarTypeSource`,
      `ProjectTypeSourceContext`.
- [ ] `git diff --stat -- tests/core/domains/language/ruby` is empty.
- [ ] No file under `src/core/domains/language/kernel/` imports from
      `src/core/domains/language/<lang>/`.
- [ ] `grep -rn "DEFAULT_SOURCE_ORDER" src` returns nothing — the const is gone,
      not shadowed.
- [ ] `grep -rn "rubyFiles" src tests scripts` returns nothing.
