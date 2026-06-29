# Ruby DSL Grammar Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every imperative Ruby DSL traversal remnant declarative so adding
a gem/convention grammar is one module file + one typed-array line, zero
interpreter/resolver edits.

**Architecture:** Four declarative mechanisms layered on the existing
`RubyFrameworkVocabulary` registry (composed by `dsl/catalogue.ts`): (D) a
method-semantics facet (`instanceReturning`/`relationReturning`), (E) an
`enqueueDispatch` facet + gem-module split, (A) an `operands` shape descriptor
on `RubyDslEntry` + generic `extractOperands`, (B) a `STRUCTURED_MACROS` typed
array of `StructuredMacroExpander`s for enum/aasm, (C) an `emits` descriptor +
one generic edge loop replacing four hand-coded branches in `collectRubyCalls`
(and the god-function's decomposition). `dsl/` stays tree-sitter-free pure data;
interpreters live in the walker layer.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), tree-sitter-ruby AST,
vitest. No new dependencies.

## Global Constraints

- **RELOCATION refactor, NOT a feature.** Behaviour byte-identical; the
  codegraph `byReceiverKind` / `resolveSuccessRate` metrics MUST NOT move
  (`resolver-architecture.md` rule #4).
- **Business-logic tests stay green UNTOUCHED** — move OK, rewrite NO
  (`feedback_business_logic_tests_immutable`). The primary regression net is
  `tests/core/domains/language/ruby/walker/ruby-walker.test.ts` (cc 17, shared 3
  owners) + `tests/core/domains/language/ruby/walker/macro-expansion.test.ts` +
  the resolver strategy tests.
- **Migration INVERTS TDD** (`feedback_refactor_migration_test_order`): relocate
  the code first → run the existing suite GREEN → author NEW unit tests for the
  NEW entity LAST. Never author new tests before the relocation is green.
- **`dsl/` is pure data** — no tree-sitter import in any `dsl/*.ts`. AST
  argument extraction lives in the walker layer (`walker/macro-expansion.ts`,
  `walker/walker.ts`, `walker/type-sources/ast-inference.ts`).
- **Naming** (`naming.md` + CLAUDE.md): domain-qualified exported names. Each
  framework owns its vocabulary in its own module; gems get their own file.
- **Commits**: conventional, scope `trajectory`, body/footer lines ≤100 chars.
  One commit per slice. Each slice = one beads task under epic `pg5ya`.
- **Test command (per-slice regression gate):**
  `npx vitest run tests/core/domains/language/ruby tests/core/domains/trajectory/codegraph`

---

## File Structure

```
src/core/domains/language/ruby/
  dsl/
    types.ts            RubyDslEntry (+operands, +emits), RubyFrameworkVocabulary
                        (+instanceReturning, +relationReturning, +enqueueDispatch)
    framework-module.ts defineFrameworkVocabulary (passthrough of new facets)
    catalogue.ts        composeEntries + composeMethodSet + composeEnqueueDispatch
                        + STRUCTURED_MACROS array; FRAMEWORKS (+ sidekiq)
    ruby-core.ts        +instanceReturning {new}; +operands for define_method/
                        alias_method/alias/attr_*
    activesupport.ts    +operands for delegate/cattr_*/...; +emits for delegate
    rails.ts            +instanceReturning/relationReturning (AR); +enqueueDispatch
                        {perform_later,perform_now}; +emits for associations/
                        callbacks; enum StructuredMacroExpander
    sidekiq.ts          NEW gem — enqueueDispatch {perform_async/_in/_at/_bulk}
    aasm.ts             NEW gem — aasm StructuredMacroExpander
    enqueue.ts          DELETED (vocab → sidekiq.ts/rails.ts; reader → catalogue)
  walker/
    macro-expansion.ts  extractOperands(node, shape); STRUCTURED_MACROS dispatch;
                        per-macro-name if-chain DELETED
    walker.ts           collectRubyCalls decomposed; generic emits loop replaces
                        the 4 per-category branches + extractCallbackSymbols
    type-sources/
      ast-inference.ts  reads RUBY_INSTANCE_RETURNING/RUBY_RELATION_RETURNING;
                        local flat Sets DELETED
```

---

## Execution model — subagent-driven waves

- **Wave 1 (parallel, worktree-isolated): Task D + Task E.** They extend
  `types.ts` (`RubyFrameworkVocabulary`) and `catalogue.ts` in **non-overlapping
  hunks** (different facet fields, different compose functions) and otherwise
  touch disjoint files (D → `ast-inference.ts`; E →
  `sidekiq.ts`/`enqueue.ts`/`ruby-enqueue-dispatch.ts`). Each runs in its own
  git worktree; merge sequentially; re-run the regression gate after EACH merge.
  A 3-way merge on `types.ts`/`catalogue.ts` is mechanical (non-conflicting
  hunks) — if a real conflict appears, fall back to running E after D.
- **Wave 2 (strictly sequential): Task A → Task B → Task C.** All three mutate
  `walker/macro-expansion.ts` (A, B) or `walker/walker.ts` (C); the A/B edits
  overlap the same if-chain region — no safe parallelism. Task C carries the
  `collectRubyCalls` decomposition.
- **Wave 3: Task F (rule doc)** after every mechanism slice lands AND a live
  validation confirms `byReceiverKind` is unchanged.

Fresh subagent per task; two-stage review between tasks. Each subagent receives:
its task block below, the Global Constraints, and the search-cascade injection
block.

---

## Task D — method-semantics facet (`pg5ya.1`) · Wave 1

**Files:**

- Modify: `src/core/domains/language/ruby/dsl/types.ts`
  (`RubyFrameworkVocabulary`)
- Modify: `src/core/domains/language/ruby/dsl/framework-module.ts`
- Modify: `src/core/domains/language/ruby/dsl/ruby-core.ts`
- Modify: `src/core/domains/language/ruby/dsl/rails.ts`
- Modify: `src/core/domains/language/ruby/dsl/catalogue.ts`
- Modify: `src/core/domains/language/ruby/walker/type-sources/ast-inference.ts`
- Test:
  `tests/core/domains/language/ruby/dsl/catalogue-method-semantics.test.ts`
  (new)

**Interfaces:**

- Produces: `RUBY_INSTANCE_RETURNING: ReadonlySet<string>` and
  `RUBY_RELATION_RETURNING: ReadonlySet<string>` exported from `dsl/index.ts`
  (re-exported from `catalogue.ts`). `RUBY_INSTANCE_RETURNING` includes `new`
  (owned by ruby-core) ∪ the AR finders/factories (owned by rails) — so it is
  exactly the OLD `INSTANCE_RETURNING_METHODS ∪ {new}`.
- Consumes: nothing from other slices.

- [ ] **Step 1 (relocate): add the two facets to the contract.** In `types.ts`,
      inside `RubyFrameworkVocabulary`, add:

  ```ts
  /** Methods that, on a class-CONSTANT receiver, return an INSTANCE of that
   *  constant (constructor + factory + finder). ruby-core: {new}; rails(AR):
   *  find/create!/build/finders. Consumed by ast-inference constInstanceType. */
  readonly instanceReturning?: ReadonlySet<string>;
  /** AR::Relation-returning query methods (where/order/…) — chaining preserves
   *  element type; a terminal instanceReturning on a relation yields one
   *  instance. Consumed by ast-inference relationRootConst. */
  readonly relationReturning?: ReadonlySet<string>;
  ```

- [ ] **Step 2 (relocate): pass them through the factory.** In
      `framework-module.ts`, change `defineFrameworkVocabulary` to accept an
      optional fourth `methodSemantics` argument and spread it onto the returned
      object:

  ```ts
  export function defineFrameworkVocabulary(
    framework: string,
    entries: Record<string, RubyDslEntry>,
    runtimeBuiltins?: ReadonlySet<string>,
    methodSemantics?: Pick<
      RubyFrameworkVocabulary,
      "instanceReturning" | "relationReturning"
    >,
  ): RubyFrameworkVocabulary {
    return {
      framework,
      entries,
      runtimeBuiltins,
      hasExternalMember: (member) =>
        member in entries || (runtimeBuiltins?.has(member) ?? false),
      ...methodSemantics,
    };
  }
  ```

- [ ] **Step 3 (relocate): move the vocabulary into the owning modules.** In
      `ruby-core.ts`, pass `{ instanceReturning: new Set(["new"]) }` as the 4th
      arg of its `defineFrameworkVocabulary(...)` call. In `rails.ts`, pass
      `{ instanceReturning: new Set(["find","find!","find_by","find_by!","create","create!","build","first","last","take"]), relationReturning: new Set(["where","not","order","joins","includes","eager_load","preload","references","group","having","limit","offset","distinct","select","reorder","unscope","except","all","readonly","lock","none"]) }`.
      These are copied VERBATIM from the current `INSTANCE_RETURNING_METHODS` /
      `RELATION_RETURNING_METHODS` in `ast-inference.ts` (plus `new`).

- [ ] **Step 4 (relocate): compose + export.** In `catalogue.ts` add:

  ```ts
  function composeMethodSet(
    modules: readonly RubyFrameworkVocabulary[],
    facet: "instanceReturning" | "relationReturning",
  ): ReadonlySet<string> {
    const out = new Set<string>();
    for (const mod of modules) for (const m of mod[facet] ?? []) out.add(m);
    return out;
  }
  export const RUBY_INSTANCE_RETURNING = composeMethodSet(
    FRAMEWORKS,
    "instanceReturning",
  );
  export const RUBY_RELATION_RETURNING = composeMethodSet(
    FRAMEWORKS,
    "relationReturning",
  );
  ```

  Re-export both from `dsl/index.ts`.

- [ ] **Step 5 (relocate): repoint consumers + delete the flat Sets.** In
      `ast-inference.ts`: import `RUBY_INSTANCE_RETURNING` /
      `RUBY_RELATION_RETURNING` from `../../dsl/index.js`; delete the local
      `INSTANCE_RETURNING_METHODS` and `RELATION_RETURNING_METHODS` `Set`
      declarations. Rewrite `constInstanceType`'s guard from
      `if (methodName !== "new" && !INSTANCE_RETURNING_METHODS.has(methodName)) return null;`
      to `if (!RUBY_INSTANCE_RETURNING.has(methodName)) return null;`
      (identical, since `new` is now in the set). Repoint `relationRootConst`'s
      `RELATION_RETURNING_METHODS.has(...)` to
      `RUBY_RELATION_RETURNING.has(...)`. FIRST grep
      `INSTANCE_RETURNING_METHODS` / `RELATION_RETURNING_METHODS` repo-wide to
      confirm `ast-inference.ts` is the only consumer; if another exists,
      repoint it too in this step.

- [ ] **Step 6 (verify existing GREEN):** Run
      `npx vitest run tests/core/domains/language/ruby tests/core/domains/trajectory/codegraph`.
      Expected: all pass (byte-identical behaviour — `new` ∈ set ⟺ old
      `new`-special case). If any localBindings / AR-finders test fails, the
      verbatim copy in Step 3 is wrong — diff against the deleted Sets.

- [ ] **Step 7 (new tests for the new entity):** Create
      `tests/core/domains/language/ruby/dsl/catalogue-method-semantics.test.ts`:

  ```ts
  import { describe, expect, it } from "vitest";

  import {
    RUBY_INSTANCE_RETURNING,
    RUBY_RELATION_RETURNING,
  } from "../../../../../../src/core/domains/language/ruby/dsl/index.js";

  describe("composed method-semantics facets", () => {
    it("instanceReturning unions ruby-core {new} with AR factories/finders", () => {
      expect(RUBY_INSTANCE_RETURNING.has("new")).toBe(true); // ruby-core
      expect(RUBY_INSTANCE_RETURNING.has("create!")).toBe(true); // rails(AR)
      expect(RUBY_INSTANCE_RETURNING.has("find")).toBe(true);
      expect(RUBY_INSTANCE_RETURNING.has("where")).toBe(false); // relation, not instance
    });
    it("relationReturning owns the AR query verbs", () => {
      expect(RUBY_RELATION_RETURNING.has("where")).toBe(true);
      expect(RUBY_RELATION_RETURNING.has("new")).toBe(false);
    });
  });
  ```

  Run it:
  `npx vitest run tests/core/domains/language/ruby/dsl/catalogue-method-semantics.test.ts`
  → PASS.

- [ ] **Step 8 (commit):**

  ```bash
  git add -A && git commit -m "refactor(trajectory): own Ruby instance/relation method vocab in grammar (pg5ya D)"
  ```

---

## Task E — enqueue split into sidekiq gem + rails (`pg5ya.2`) · Wave 1

**Files:**

- Modify: `src/core/domains/language/ruby/dsl/types.ts`
  (`RubyFrameworkVocabulary`)
- Modify: `src/core/domains/language/ruby/dsl/framework-module.ts`
- Create: `src/core/domains/language/ruby/dsl/sidekiq.ts`
- Modify: `src/core/domains/language/ruby/dsl/rails.ts`
- Modify: `src/core/domains/language/ruby/dsl/catalogue.ts` (`FRAMEWORKS`,
  compose)
- Delete: `src/core/domains/language/ruby/dsl/enqueue.ts`
- Modify: `src/core/domains/language/ruby/dsl/index.ts` (exports)
- Test: `tests/core/domains/language/ruby/dsl/catalogue-enqueue.test.ts` (new)
- Unchanged (verify only): `resolver/strategies/ruby-enqueue-dispatch.ts`,
  `tests/core/domains/language/ruby/resolver/strategies/ruby-enqueue-dispatch.test.ts`

**Interfaces:**

- Produces: `enqueueEntrypoint(member: string): string | undefined` (relocated
  to `catalogue.ts`, re-exported from `dsl/index.ts`) reading a composed
  `RUBY_ENQUEUE_DISPATCH: Readonly<Record<string,string>>`. Signature
  byte-identical to the current `enqueue.ts` export, so
  `RubyEnqueueDispatchSymbolResolutionStrategy` needs ZERO edits.
- Consumes: nothing from Task D (separate facet, separate compose fn — only
  shares the `types.ts`/`catalogue.ts` files in non-overlapping hunks).

- [ ] **Step 1 (relocate): add the enqueue facet to the contract.** In
      `types.ts`, inside `RubyFrameworkVocabulary`, add:

  ```ts
  /** Background-job CLASS-method enqueue verbs and the INSTANCE entrypoint each
   *  routes to. sidekiq: perform_async/_in/_at/_bulk → "perform"; rails(ActiveJob):
   *  perform_later/_now → "perform". Consumed by enqueueEntrypoint. */
  readonly enqueueDispatch?: Readonly<Record<string, string>>;
  ```

  In `framework-module.ts`, widen the `methodSemantics` param to also carry
  `enqueueDispatch` (i.e.
  `Pick<RubyFrameworkVocabulary, "instanceReturning" | "relationReturning" | "enqueueDispatch">`)
  — this is the only line that may touch Task D's hunk; if D already widened it,
  add `"enqueueDispatch"` to the existing `Pick`.

- [ ] **Step 2 (relocate): create the gem module.** Create `dsl/sidekiq.ts`:

  ```ts
  import { defineFrameworkVocabulary } from "./framework-module.js";

  /** Sidekiq / Sidekiq-Pro gem grammar. A `Worker.perform_async(args)` class call
   *  defers to `Worker#perform`; the gem instantiates the worker out of band, so
   *  the static graph never sees the edge. One module file + one FRAMEWORKS line. */
  export const SIDEKIQ_VOCABULARY = defineFrameworkVocabulary(
    "sidekiq",
    {},
    undefined,
    {
      enqueueDispatch: {
        perform_async: "perform",
        perform_in: "perform",
        perform_at: "perform",
        perform_bulk: "perform",
      },
    },
  );
  ```

- [ ] **Step 3 (relocate): rails owns ActiveJob enqueue.** In `rails.ts`, add
      `enqueueDispatch: { perform_later: "perform", perform_now: "perform" }` to
      its `defineFrameworkVocabulary(...)` 4th-arg object (creating the object
      if Task D has not yet merged its `instanceReturning` there — merge
      resolves the union).

- [ ] **Step 4 (relocate): register + compose + relocate the reader.** In
      `catalogue.ts`: import `SIDEKIQ_VOCABULARY`, add it to the `FRAMEWORKS`
      array; add:

  ```ts
  function composeEnqueueDispatch(
    modules: readonly RubyFrameworkVocabulary[],
  ): Readonly<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const mod of modules)
      for (const [k, v] of Object.entries(mod.enqueueDispatch ?? {}))
        out[k] = v;
    return out;
  }
  export const RUBY_ENQUEUE_DISPATCH = composeEnqueueDispatch(FRAMEWORKS);
  export const enqueueEntrypoint = (member: string): string | undefined =>
    RUBY_ENQUEUE_DISPATCH[member];
  ```

- [ ] **Step 5 (relocate): delete the flat map + repoint exports.** Delete
      `dsl/enqueue.ts`. In `dsl/index.ts`, remove the
      `export { ENQUEUE_DISPATCH, enqueueEntrypoint } from "./enqueue.js";` line
      and add `enqueueEntrypoint` (+ `RUBY_ENQUEUE_DISPATCH` if any consumer
      needs it) to the `catalogue.js` re-export. Grep `ENQUEUE_DISPATCH`
      repo-wide and repoint / remove any remaining import (the strategy imports
      `enqueueEntrypoint`, not the map — verify).

- [ ] **Step 6 (verify existing GREEN):** Run
      `npx vitest run tests/core/domains/language/ruby/resolver/strategies/ruby-enqueue-dispatch.test.ts tests/core/domains/language/ruby/walker/macro-expansion.test.ts`.
      Expected: all pass (strategy unchanged, same `enqueueEntrypoint` outputs).
      Then run the full gate.

- [ ] **Step 7 (new tests for the new entity):** Create
      `tests/core/domains/language/ruby/dsl/catalogue-enqueue.test.ts`:

  ```ts
  import { describe, expect, it } from "vitest";

  import { enqueueEntrypoint } from "../../../../../../src/core/domains/language/ruby/dsl/index.js";

  describe("composed enqueue dispatch", () => {
    it("routes Sidekiq verbs (gem-owned) to #perform", () => {
      for (const v of [
        "perform_async",
        "perform_in",
        "perform_at",
        "perform_bulk",
      ]) {
        expect(enqueueEntrypoint(v)).toBe("perform");
      }
    });
    it("routes ActiveJob verbs (rails-owned) to #perform", () => {
      expect(enqueueEntrypoint("perform_later")).toBe("perform");
      expect(enqueueEntrypoint("perform_now")).toBe("perform");
    });
    it("returns undefined for a non-enqueue member", () => {
      expect(enqueueEntrypoint("save")).toBeUndefined();
    });
  });
  ```

  Run it → PASS.

- [ ] **Step 8 (commit):**

  ```bash
  git add -A && git commit -m "refactor(trajectory): split enqueue vocab into sidekiq gem + rails ActiveJob (pg5ya E)"
  ```

---

## Task A — operands descriptor + generic `extractOperands` (`pg5ya.3`) · Wave 2

**Files:**

- Modify: `src/core/domains/language/ruby/dsl/types.ts` (`RubyDslEntry`)
- Modify: `src/core/domains/language/ruby/dsl/ruby-core.ts`,
  `dsl/activesupport.ts`, `dsl/rails.ts` (attach `operands` to the simple
  macros)
- Modify: `src/core/domains/language/ruby/walker/macro-expansion.ts`
- Test:
  `tests/core/domains/language/ruby/walker/macro-expansion-operands.test.ts`
  (new)

**Interfaces:**

- Produces: `OperandsShape` type on `RubyDslEntry.operands`; a walker-layer
  `extractOperands(node: AstNode, shape: OperandsShape): string[]` returning the
  base symbol names a macro call declares.
- Consumes: `RubyDslEntry.declares` (existing) — `extractOperands` feeds each
  base through `entry.declares(base)`.

- [ ] **Step 1 (relocate): the operands shape on the contract.** In `types.ts`,
      add to `RubyDslEntry`:

  ```ts
  /** How the walker extracts the base symbol name(s) a declaring macro takes,
   *  replacing the per-macro-NAME if-branches in macro-expansion.ts.
   *   - 'leading-symbols' : all leading :sym args, STOP at first non-symbol
   *                         (delegate :a, :b, to: :x). flags: stopAtKwarg.
   *   - 'first-symbol'    : only the first :sym (scope :active, -> {}; attribute :n, :type)
   *   - 'skip-first'      : symbols after the first (store_accessor :col, :a, :b)
   *   - 'literal-name'    : symbol OR string literal (define_method :foo / "foo")
   *   - 'second-symbol'   : the 2nd :sym only (alias_method declares the NEW name) */
  readonly operands?:
    | "leading-symbols"
    | "first-symbol"
    | "skip-first"
    | "literal-name"
    | "second-symbol";
  ```

- [ ] **Step 2 (relocate): attach `operands` to the owning entries.** Add
      `operands: "literal-name"` to `define_method` (ruby-core),
      `operands: "second-symbol"` to `alias_method` (ruby-core),
      `operands: "leading-symbols"` to `delegate` (activesupport),
      `operands: "skip-first"` to `store_accessor` (rails),
      `operands: "first-symbol"` to `scope` and `attribute` (rails). These
      entries already exist (they carry `category`/`declares`); add the field
      only.

- [ ] **Step 3 (relocate): the generic extractor + dispatch.** In
      `macro-expansion.ts`, add `extractOperands(node, shape): string[]` whose
      body is the UNION of the current per-branch extraction logic (the
      `define_method`, `alias_method`, `delegate`, `store_accessor`,
      `scope`/`attribute` branches), parameterised by `shape`. Then replace the
      per-macro-NAME `if` chain (`if (macroName === "define_method")` … through
      the `scope`/`attribute` special case) with: look up
      `entry = RUBY_DSL[macroName]`; if `entry?.operands` and `entry.declares`,
      compute `bases = extractOperands(args, entry.operands)` and return
      `bases.flatMap((b) => entry.declares!(b)).map((m) => mk(...))`. Keep the
      helper functions (`stripSymbolColon`, `literalNameFromArg`) — they move
      into `extractOperands`'s call sites. Do NOT touch the `enum`/`aasm`
      branches (Task B).

- [ ] **Step 4 (verify existing GREEN):** Run
      `npx vitest run tests/core/domains/language/ruby/walker/macro-expansion.test.ts tests/core/domains/language/ruby/walker/ruby-name-of.test.ts tests/core/domains/language/ruby tests/core/domains/trajectory/codegraph`.
      Expected: all pass. The existing `macro-expansion.test.ts` cases for
      define_method/alias_method/delegate/store_accessor/scope/attribute are the
      byte-identical-behaviour oracle.

- [ ] **Step 5 (new tests for the new entity):** Create
      `macro-expansion-operands.test.ts` unit-testing `extractOperands` directly
      for each shape (`'leading-symbols'` stops at a `to:` pair; `'skip-first'`
      drops the store column; `'second-symbol'` returns only the 2nd symbol;
      `'literal-name'` accepts a string; `'first-symbol'` returns one). Build
      small tree-sitter ASTs as the existing macro-expansion tests do. Run →
      PASS.

- [ ] **Step 6 (commit):**

  ```bash
  git add -A && git commit -m "refactor(trajectory): declarative operands shape replaces per-macro if-chain (pg5ya A)"
  ```

---

## Task B — `STRUCTURED_MACROS` array for enum + aasm (`pg5ya.4`) · Wave 2

**Files:**

- Create: `src/core/domains/language/ruby/dsl/aasm.ts` (NEW gem — the expander
  module, but pure data per the constraint: it declares the macro NAME + the
  walker-layer expander is registered via the typed array)
- Modify: `src/core/domains/language/ruby/walker/macro-expansion.ts`
  (`STRUCTURED_MACROS` array + dispatch; enum expander owned by rails-domain,
  aasm expander imported from the gem)
- Modify: `src/core/domains/language/ruby/dsl/catalogue.ts` or `index.ts`
  (export the `STRUCTURED_MACROS` registry assembly point if it lives in `dsl/`)
- Test:
  `tests/core/domains/language/ruby/walker/macro-expansion-structured.test.ts`
  (new)

**Interfaces:**

- Produces: `StructuredMacroExpander` interface
  `{ macroName: string; expand(node: AstNode): DeclaredMethod[] }` and a typed
  array `STRUCTURED_MACROS: readonly StructuredMacroExpander[]` in the walker
  layer (these need the AST, so they are walker-layer, not pure `dsl/`; the gem
  OWNERSHIP is expressed by the file the expander lives in).
- Consumes: `DeclaredMethod`, `mk` helpers (existing in `macro-expansion.ts`).

- [ ] **Step 1 (relocate): define the expander contract.** In
      `macro-expansion.ts` (walker layer), add:

  ```ts
  export interface StructuredMacroExpander {
    readonly macroName: string;
    expand(node: AstNode, startLine: number, endLine: number): DeclaredMethod[];
  }
  ```

- [ ] **Step 2 (relocate): move the enum branch into an expander.** Create an
      `enumExpander: StructuredMacroExpander` whose `expand` body is the CURRENT
      `if (macroName === "enum")` block (lines ~96-116), verbatim. Place it
      where rails-domain structured macros live (a `rails-structured.ts`
      walker-layer file, or co-located in `macro-expansion.ts` with a clear
      `// rails(AR)` ownership comment). Move `enumValueNames`/`enumKeyName`
      helpers with it.

- [ ] **Step 3 (relocate): move the aasm branch into the gem expander.** Create
      `dsl/aasm.ts` documenting the gem; the actual
      `aasmExpander: StructuredMacroExpander` (needs AST) lives walker-layer
      (e.g. `walker/structured/aasm.ts`) with its `expand` body = the CURRENT
      `if (macroName === "aasm")` block (lines ~124-147) verbatim.
      (`dsl/aasm.ts` stays tree-sitter-free; it may hold only the gem's
      NAME/metadata — keep the AST walk in the walker layer per the constraint.)

- [ ] **Step 4 (relocate): the typed-array dispatch.** Add
      `const STRUCTURED_MACROS: readonly StructuredMacroExpander[] = [enumExpander, aasmExpander];`
      In `expandClassBodyMacros`, replace the `enum` and `aasm` `if` blocks
      with:
      `const structured = STRUCTURED_MACROS.find((e) => e.macroName === macroName); if (structured) return structured.expand(node, startLine, endLine);`
      (placed where the enum/aasm branches were).

- [ ] **Step 5 (verify existing GREEN):** Run
      `npx vitest run tests/core/domains/language/ruby/walker/macro-expansion.test.ts tests/core/domains/language/ruby tests/core/domains/trajectory/codegraph`.
      Expected: all pass — the existing enum/aasm cases in
      `macro-expansion.test.ts` are the oracle (these were added in ujm91).

- [ ] **Step 6 (new tests for the new entity):** Create
      `macro-expansion-structured.test.ts` unit-testing the registry-dispatch
      path: an unknown structured macro name returns `[]`; `STRUCTURED_MACROS`
      contains exactly `enum` + `aasm`; each expander's `macroName` matches. Run
      → PASS.

- [ ] **Step 7 (commit):**

  ```bash
  git add -A && git commit -m "refactor(trajectory): STRUCTURED_MACROS array replaces enum/aasm if-branches (pg5ya B)"
  ```

---

## Task C — emits descriptor + decompose `collectRubyCalls` (`pg5ya.5`) · Wave 2

**Files:**

- Modify: `src/core/domains/language/ruby/dsl/types.ts` (`RubyDslEntry.emits`)
- Modify: `dsl/activesupport.ts` (delegate `emits`), `dsl/rails.ts`
  (associations
  - callbacks `emits`), `dsl/ruby-core.ts` (alias_method `emits`)
- Modify: `src/core/domains/language/ruby/walker/walker.ts` (generic emit loop +
  `collectRubyCalls` decomposition)
- Test: `tests/core/domains/language/ruby/walker/walker-emits.test.ts` (new)

**Interfaces:**

- Produces: `RubyDslEntry.emits` shape descriptor; a walker-layer
  `emitDslEdges(node, entry, startLine, out)` that replaces the four
  per-category branches at `walker.ts:1079-1136`.
- Consumes: existing helpers `extractSecondLiteralSymbol`,
  `extractDelegateTarget`, `extractDelegateSymbols`, `extractCallbackSymbols`,
  `associationModelConstant`.

- [ ] **Step 1 (relocate): the emits descriptor.** In `types.ts`, add to
      `RubyDslEntry`:

  ```ts
  /** What synthetic call edge(s) this macro emits from the class body, replacing
   *  the four per-category branches in collectRubyCalls.
   *   - 'self-instance'      : per leading symbol → {receiver:null, member:sym}   (before_action :auth)
   *   - 'model-constant-ref' : associated model  → {receiver:C, member:C}         (has_many :posts)
   *   - 'delegate-target'    : per delegated sym  → {receiver:to, member:sym}      (delegate :a, to: :x)
   *   - 'alias-redirect'     : old name           → {receiver:null, member:old}    (alias_method :new,:old) */
  readonly emits?: "self-instance" | "model-constant-ref" | "delegate-target" | "alias-redirect";
  ```

- [ ] **Step 2 (relocate): attach `emits` to the owning entries.**
      `alias_method` (ruby-core) → `'alias-redirect'`; `delegate`
      (activesupport) → `'delegate-target'`; each callback macro entry (rails) →
      `'self-instance'`; each association macro entry (rails) →
      `'model-constant-ref'`. (Callback/association macro NAMES are currently in
      `isRubyCallbackMacro` / `RUBY_ASSOCIATION_MACROS` sets — ensure each has a
      `RUBY_DSL` entry carrying the `emits` field; if some are set-only, add a
      minimal entry with `category` + `emits`.)

- [ ] **Step 3 (relocate): the generic emit loop.** In `walker.ts`, add
      `emitDslEdges(node, entry, startLine, out)` whose body is the UNION of the
      four current branches (lines 1079-1136), selected by `entry.emits`,
      reusing the existing extraction helpers verbatim. Replace the four
      `if (receiverText === null && …)` blocks with:
      `if (receiverText === null) { const entry = RUBY_DSL[method.text]; if (entry?.emits) emitDslEdges(node, entry, startLine, out); }`.

- [ ] **Step 4 (relocate the god-function — user directive): decompose
      `collectRubyCalls`.** The 263-line `collectRubyCalls#part1` (walker.ts
      ~874-1136) is the hotspot we are already editing. Extract cohesive helpers
      WITHOUT changing behaviour: e.g. `emitDynamicSendUnwrap(...)`,
      `emitDslEdges(...)` (Step 3), `emitRegistryDispatch(...)`,
      `emitBlockPass(...)`, each taking the same
      `(node, receiverText, startLine, out, …)` and returning void. The
      top-level `visit` becomes a short orchestration calling them. Pure
      extraction — every helper's body is lifted verbatim from the current
      inline block. This is the ONLY task allowed to restructure the function;
      keep edges byte-identical.

- [ ] **Step 5 (verify existing GREEN):** Run the FULL gate
      `npx vitest run tests/core/domains/language/ruby tests/core/domains/trajectory/codegraph`.
      Expected: all pass — `ruby-walker.test.ts`
      delegate/alias/callback/association cases are the oracle. If any edge
      count moves, the extraction in Step 3/4 is not byte-identical — diff the
      emitted `CallRef[]` against the pre-refactor output.

- [ ] **Step 6 (new tests for the new entity):** Create `walker-emits.test.ts`
      unit-testing `emitDslEdges` per `emits` shape (each produces the exact
      `{receiver, member}` shape the old branch did) and a small test that the
      decomposed helpers compose to the same `CallRef[]` for a representative
      class body (alias_method + delegate + before_action + has_many). Run →
      PASS.

- [ ] **Step 7 (commit):**

  ```bash
  git add -A && git commit -m "refactor(trajectory): emits descriptor + decompose collectRubyCalls god-fn (pg5ya C)"
  ```

---

## Task F — `.claude/rules/ruby-dsl.md` (`pg5ya.6`) · Wave 3

**Files:**

- Create: `.claude/rules/ruby-dsl.md`

**Precondition:** all mechanism slices (D, E, A, B, C) merged AND a live
validation (reindex tea-rags + measure `byReceiverKind`) confirms the resolve
breakdown is unchanged vs the pre-epic baseline.

- [ ] **Step 1: write the rule with `paths:` frontmatter** scoping to
      `src/core/domains/language/ruby/dsl/**` +
      `src/core/domains/language/ruby/walker/**`. Document: (1) pick the
      framework module (`ruby-core`/`activesupport`/`rails`) or create a NEW gem
      file (`sidekiq.ts`/`aasm.ts`) composed into `FRAMEWORKS`; (2) decision
      table — declaring macro → `operands` shape + `declares`; instance/
      relation method → `instanceReturning`/`relationReturning` facet; enqueue
      verb → `enqueueDispatch` facet; structured macro →
      `StructuredMacroExpander` + `STRUCTURED_MACROS`; edge-emitting macro →
      `emits` descriptor; (3) where the resolver/walker reads each facet; (4)
      the "pure data in `dsl/`, AST walk in walker" boundary.

- [ ] **Step 2: commit**

  ```bash
  git add .claude/rules/ruby-dsl.md && git commit -m "docs(trajectory): rule for adding Ruby DSL grammars (pg5ya deliverable 2)"
  ```

---

## Self-Review

**Spec coverage:** D↔mechanism D + facet ownership; E↔enqueue split + sidekiq
gem; A↔operands; B↔structured enum/aasm + aasm gem; C↔emits + collectRubyCalls
decompose; F↔ruby-dsl.md. All spec sections mapped. ✓

**Placeholder scan:** every code step shows the target shape; relocation steps
name the exact current branch + line range to lift verbatim. No "TBD"/"handle
edge cases". ✓

**Type consistency:** `RUBY_INSTANCE_RETURNING`/`RUBY_RELATION_RETURNING` (D),
`enqueueEntrypoint`/`RUBY_ENQUEUE_DISPATCH` (E),
`OperandsShape`/`extractOperands` (A),
`StructuredMacroExpander`/`STRUCTURED_MACROS` (B), `RubyDslEntry.emits`/
`emitDslEdges` (C) used consistently across tasks. ✓

**Invariant:** every slice runs the regression gate BEFORE authoring new tests
(inverted TDD) and asserts no `byReceiverKind`/`resolveSuccessRate` move. ✓
