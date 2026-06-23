# Ruby DSL Per-Framework Decomposition + Unified Macro-Expansion Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose the flat `RUBY_DSL` catalogue into per-framework modules and
unify the duplicated chunker/codegraph macro-expansion into one engine, then add
ActiveRecord association `declares`.

**Architecture:** `dsl/` stays pure data (per-framework `RubyDslModule`s
composed into one `RUBY_DSL` Record). A single tree-sitter-coupled engine
`walker/macro-expansion.ts` computes the declared-method set; both consumers
(chunker `macros.ts`, codegraph `name-of.ts`) call it and apply their own
emission policy. Three phases: A relocate (zero behavior change), B unify engine
(byte-identical), C add associations (behavior change, metric-validated).

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), tree-sitter-ruby,
vitest, DuckDB (codegraph `cg_symbols`), Qdrant (chunk payload).

## Global Constraints

- Spec:
  `docs/superpowers/specs/2026-06-22-ruby-dsl-per-framework-decomposition-design.md`.
- Worktree `.claude/worktrees/ruby-dsl-decomposition`, branch
  `worktree-ruby-dsl-decomposition`, base local main `8d3f26ca`. Spec committed
  `82e27761`.
- Tests: `npx vitest run`. Type check: `npm run build` (tsc must be 0).
  Pre-commit runs tests + type-check in parallel.
- `domains/language/` is a leaf domain: imports only from `contracts/` +
  `infra/`. `dsl/` must NOT import tree-sitter (stays pure data). Import
  direction `walker/ → dsl/` only (never `dsl/ → walker/`).
- Barrel rule: cross-subdomain imports go through `dsl/index.ts`. Consumers keep
  their `RUBY_DSL[name]` lookup unchanged.
- symbolId convention (`.claude/rules/symbolid-convention.md`): instance
  `Class#method`, static `Class.method`. Chunker and codegraph MUST agree on the
  separator for the same physical node — this is the lockstep contract the
  unification protects.
- Refactor-migration test order: relocate code → existing tests green UNTOUCHED
  → redistribute tests LAST. Business-logic tests are immutable (move OK,
  rewrite NO).
- Conventional commits: `refactor(...)` for Phase A/B,
  `improve(...)`/`feat(...)` for Phase C; header ≤ 100 chars; silo-pairing
  `Why:` line (touched files are deep-silo single-owner). Co-Authored-By
  trailer.
- Each phase = its own commit + its own beads task under `cai0`/`duzy`.
- Metric-driven cai0 ethos: only Phase C changes behavior; live-validate it
  ALONE against huginn (serialized reindex, attribute the delta).

---

## Current state (ground truth — read before starting)

`dsl/catalogue.ts` exports `RUBY_DSL: Record<string, RubyDslEntry>` (flat, ~60
keywords) + types `MethodKind`, `DslCategory`, `RubyDslEntry`. `dsl/index.ts`
re-exports them.

Four consumers read `RUBY_DSL` via `dsl/index.js`:

1. `chunking/class-body-chunker.ts:84` — `entry.category` → `CATEGORY_TO_GROUP`.
2. `walker/macros.ts:147` — `RUBY_DSL[name]?.declares` (chunker
   `MacroSymbol[]`).
3. `walker/name-of.ts:222` —
   `AR_ASSOCIATION_MACROS[name] ?? RUBY_DSL[name]?.declares` (codegraph
   `NamedSymbol[]`).
4. `walker/walker.ts:635` (`category === "callback"`), `:753` + `:895`
   (`redirectTarget`).

`name-of.ts:180` holds a hidden second catalogue `AR_ASSOCIATION_MACROS`
(codegraph-only association declares). `walker.ts:646` holds
`singularizeAssociation` (used by `associationModelConstant` at `:697`; sibling
`camelizeModelName` stays in walker).

**Keyword → framework module assignment** (placement by best-effort provenance;
movable later — that is the OCP point; the dup-key guard forbids a keyword in
two modules):

- **ruby-core.ts** (`RUBY_CORE_DSL`): `attr_accessor`, `attr_reader`,
  `attr_writer`, `define_method`, `alias_method`, `alias`, `include`, `extend`,
  `prepend`.
- **activesupport.ts** (`ACTIVESUPPORT_DSL`): `cattr_accessor`, `cattr_reader`,
  `cattr_writer`, `mattr_accessor`, `mattr_reader`, `mattr_writer`, `delegate`,
  `delegate_missing_to`, `class_attribute`, `included`, `extended`,
  `class_methods`.
- **rails.ts** (`RAILS_DSL`): `has_many`, `has_one`, `belongs_to`,
  `has_and_belongs_to_many`, `attribute`, `has_one_attached`,
  `has_many_attached`, `store_accessor`, `serialize`, all
  `validates*`/`validate`, all callbacks
  (`before_*`/`after_*`/`around_*`/`skip_*`), `scope`, `enum`, `aasm`,
  `accepts_nested_attributes_for`.

---

# PHASE A — Catalogue decomposition (pure data relocation, ZERO behavior change)

Beads: create task under `cai0`/`duzy`, status in_progress.

### Task A1: Relocate types + inflection (no catalogue split yet)

**Files:**

- Create: `src/core/domains/language/ruby/dsl/types.ts`
- Create: `src/core/domains/language/ruby/dsl/inflection.ts`
- Modify: `src/core/domains/language/ruby/dsl/catalogue.ts` (import types from
  `./types.js`)
- Modify: `src/core/domains/language/ruby/dsl/index.ts` (re-export from
  `./types.js`)
- Modify: `src/core/domains/language/ruby/walker/walker.ts:646-651` (remove
  `singularizeAssociation`, import from `../dsl/index.js`)

**Interfaces:**

- Produces: `dsl/types.ts` exports `MethodKind`, `DslCategory`, `RubyDslEntry`,
  `RubyDslModule`, `DeclaredMethodSpec`. `dsl/inflection.ts` exports
  `singularizeAssociation(word: string): string`.

- [ ] **Step 1: Create `dsl/types.ts`** — move the type declarations verbatim
      from `catalogue.ts` and add two new types:

```ts
export type MethodKind = "instance" | "static";

export type DslCategory =
  | "accessor"
  | "delegation"
  | "alias"
  | "dynamic-method"
  | "association"
  | "validation"
  | "scope"
  | "callback"
  | "include"
  | "enum"
  | "state-machine"
  | "concern-hook"
  | "nested-attrs"
  | "other";

/** A method a macro declares, given an already-parsed base symbol name. */
export type DeclaredMethodSpec = { name: string; kind: MethodKind };

export interface RubyDslEntry {
  category: DslCategory;
  declares?: (base: string) => DeclaredMethodSpec[];
  redirectTarget?: "second-symbol" | "alias-keyword-old";
}

/** A per-framework slice of the catalogue. Composed into RUBY_DSL. */
export interface RubyDslModule {
  readonly framework: string; // "ruby-core" | "activesupport" | "rails"
  readonly entries: Record<string, RubyDslEntry>;
}
```

- [ ] **Step 2: Create `dsl/inflection.ts`** — move `singularizeAssociation`
      verbatim from `walker.ts:646-651`:

```ts
/**
 * Naive Rails singularize for the common association-name → model-name cases
 * (duzy). `categories → category` (ies → y), `boxes → box` (xes/ses/shes/ches →
 * strip `es`), `posts → post` (trailing `s`). NOT a full inflector; irregulars
 * and `class_name:` overrides are out of scope. A non-plural word passes through.
 */
export function singularizeAssociation(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:xes|ses|shes|ches)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}
```

- [ ] **Step 3: Point `catalogue.ts` at `./types.js`** — delete the inline
      `MethodKind`/`DslCategory`/`RubyDslEntry` declarations (lines 24-60), add
      at top:

```ts
import type { DslCategory, MethodKind, RubyDslEntry } from "./types.js";
```

Keep the `RUBY_DSL` object and the `accessorPair` helper as-is for now.

- [ ] **Step 4: Update `dsl/index.ts` barrel** to re-export the relocated types
      (public surface unchanged):

```ts
export { RUBY_DSL } from "./catalogue.js";
export type {
  DslCategory,
  MethodKind,
  RubyDslEntry,
  RubyDslModule,
  DeclaredMethodSpec,
} from "./types.js";
export { singularizeAssociation } from "./inflection.js";
```

- [ ] **Step 5: Update `walker.ts`** — delete `singularizeAssociation` (lines
      646-651), and where the file imports from `../dsl/index.js` add
      `singularizeAssociation`. Verify `associationModelConstant` (line ~697)
      still resolves it. `camelizeModelName` stays in walker.ts.

- [ ] **Step 6: Build + existing tests green (UNTOUCHED)**

Run: `npm run build && npx vitest run src/core/domains/language/ruby` Expected:
tsc 0 errors; all existing ruby tests PASS (no test edits in this task).

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/language/ruby/dsl/types.ts src/core/domains/language/ruby/dsl/inflection.ts \
        src/core/domains/language/ruby/dsl/catalogue.ts src/core/domains/language/ruby/dsl/index.ts \
        src/core/domains/language/ruby/walker/walker.ts
git commit -m "refactor(language): extract ruby dsl types + inflection to own files

Why: foundation for per-framework catalogue split; singularizeAssociation must
live in dsl/ (pure data) so rails.ts can use it without a dsl->walker cycle.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task A2: Split catalogue into per-framework modules + compose

**Files:**

- Create: `src/core/domains/language/ruby/dsl/ruby-core.ts`
- Create: `src/core/domains/language/ruby/dsl/activesupport.ts`
- Create: `src/core/domains/language/ruby/dsl/rails.ts`
- Modify: `src/core/domains/language/ruby/dsl/catalogue.ts` (becomes
  `composeModules`)

**Interfaces:**

- Consumes: `RubyDslModule`, `RubyDslEntry` from `./types.js`.
- Produces: `RUBY_CORE_DSL`, `ACTIVESUPPORT_DSL`, `RAILS_DSL` (each
  `RubyDslModule`); `composeModules(modules)` + `RUBY_DSL` from `catalogue.ts`
  (unchanged export name).

- [ ] **Step 1: Create `dsl/ruby-core.ts`** — a `RubyDslModule` whose `entries`
      hold the ruby-core keywords, each entry value copied VERBATIM from the
      current `catalogue.ts`:

```ts
import type { MethodKind, RubyDslModule } from "./types.js";

const accessorPair = (base: string, kind: MethodKind) => [
  { name: base, kind },
  { name: `${base}=`, kind },
];

export const RUBY_CORE_DSL: RubyDslModule = {
  framework: "ruby-core",
  entries: {
    attr_accessor: {
      category: "accessor",
      declares: (b) => accessorPair(b, "instance"),
    },
    attr_reader: {
      category: "accessor",
      declares: (b) => [{ name: b, kind: "instance" }],
    },
    attr_writer: {
      category: "accessor",
      declares: (b) => [{ name: `${b}=`, kind: "instance" }],
    },
    define_method: {
      category: "dynamic-method",
      declares: (b) => [{ name: b, kind: "instance" }],
    },
    alias_method: {
      category: "alias",
      declares: (b) => [{ name: b, kind: "instance" }],
      redirectTarget: "second-symbol",
    },
    alias: {
      category: "alias",
      declares: (b) => [{ name: b, kind: "instance" }],
      redirectTarget: "alias-keyword-old",
    },
    include: { category: "include" },
    extend: { category: "include" },
    prepend: { category: "include" },
  },
};
```

- [ ] **Step 2: Create `dsl/activesupport.ts`** — copy the
      cattr/mattr/delegate/class_attribute/concern-hook entries VERBATIM from
      current `catalogue.ts`:

```ts
import type { MethodKind, RubyDslModule } from "./types.js";

const accessorPair = (base: string, kind: MethodKind) => [
  { name: base, kind },
  { name: `${base}=`, kind },
];

export const ACTIVESUPPORT_DSL: RubyDslModule = {
  framework: "activesupport",
  entries: {
    cattr_accessor: {
      category: "accessor",
      declares: (b) => accessorPair(b, "static"),
    },
    cattr_reader: {
      category: "accessor",
      declares: (b) => [{ name: b, kind: "static" }],
    },
    cattr_writer: {
      category: "accessor",
      declares: (b) => [{ name: `${b}=`, kind: "static" }],
    },
    mattr_accessor: {
      category: "accessor",
      declares: (b) => accessorPair(b, "static"),
    },
    mattr_reader: {
      category: "accessor",
      declares: (b) => [{ name: b, kind: "static" }],
    },
    mattr_writer: {
      category: "accessor",
      declares: (b) => [{ name: `${b}=`, kind: "static" }],
    },
    delegate: {
      category: "delegation",
      declares: (b) => [{ name: b, kind: "instance" }],
    },
    delegate_missing_to: { category: "delegation" },
    class_attribute: { category: "accessor" },
    included: { category: "concern-hook" },
    extended: { category: "concern-hook" },
    class_methods: { category: "concern-hook" },
  },
};
```

- [ ] **Step 3: Create `dsl/rails.ts`** — copy the
      association/validation/callback/scope/enum/etc. entries VERBATIM from
      current `catalogue.ts` (associations stay GROUP-ONLY in Phase A — no
      `declares` yet; that is Phase C). Reproduce EVERY remaining keyword from
      the current catalogue not already placed in ruby-core/activesupport,
      preserving each entry's `category`:

```ts
import type { RubyDslModule } from "./types.js";

export const RAILS_DSL: RubyDslModule = {
  framework: "rails",
  entries: {
    // associations (group-only until Phase C)
    has_many: { category: "association" },
    has_one: { category: "association" },
    belongs_to: { category: "association" },
    has_and_belongs_to_many: { category: "association" },
    // accessor-family group-only
    attribute: { category: "accessor" },
    has_one_attached: { category: "accessor" },
    has_many_attached: { category: "accessor" },
    store_accessor: { category: "other" },
    serialize: { category: "other" },
    // validations (verbatim copy of all validates* + validate + validates_* from catalogue.ts)
    validates: { category: "validation" },
    validates_with: { category: "validation" },
    validate: { category: "validation" },
    validates_each: { category: "validation" },
    validates_associated: { category: "validation" },
    validates_acceptance_of: { category: "validation" },
    validates_confirmation_of: { category: "validation" },
    validates_exclusion_of: { category: "validation" },
    validates_format_of: { category: "validation" },
    validates_inclusion_of: { category: "validation" },
    validates_length_of: { category: "validation" },
    validates_numericality_of: { category: "validation" },
    validates_presence_of: { category: "validation" },
    validates_uniqueness_of: { category: "validation" },
    // scope
    scope: { category: "scope" },
    // callbacks (verbatim copy of EVERY before_*/after_*/around_*/skip_* from catalogue.ts)
    before_validation: { category: "callback" },
    after_validation: { category: "callback" },
    before_save: { category: "callback" },
    after_save: { category: "callback" },
    around_save: { category: "callback" },
    before_create: { category: "callback" },
    after_create: { category: "callback" },
    around_create: { category: "callback" },
    before_update: { category: "callback" },
    after_update: { category: "callback" },
    around_update: { category: "callback" },
    before_destroy: { category: "callback" },
    after_destroy: { category: "callback" },
    around_destroy: { category: "callback" },
    after_commit: { category: "callback" },
    after_rollback: { category: "callback" },
    after_initialize: { category: "callback" },
    after_find: { category: "callback" },
    after_touch: { category: "callback" },
    before_action: { category: "callback" },
    after_action: { category: "callback" },
    around_action: { category: "callback" },
    before_filter: { category: "callback" },
    after_filter: { category: "callback" },
    around_filter: { category: "callback" },
    skip_before_action: { category: "callback" },
    skip_after_action: { category: "callback" },
    skip_around_action: { category: "callback" },
    // nested attrs / enum / state machine
    accepts_nested_attributes_for: { category: "nested-attrs" },
    enum: { category: "enum" },
    aasm: { category: "state-machine" },
  },
};
```

> Cross-check against current `catalogue.ts`: every one of the ~60 keywords must
> appear in exactly ONE module. The dup-key guard (next step) fails the build if
> a keyword is duplicated; a MISSING keyword is caught by the byte-identical
> test in Step 6.

- [ ] **Step 4: Rewrite `dsl/catalogue.ts` as `composeModules`**:

```ts
/**
 * Composes the per-framework RubyDslModules into one RUBY_DSL lookup. Adding a
 * framework = a new dsl/<framework>.ts module + one line in MODULES. The
 * dup-key guard forbids a keyword living in two modules.
 */
import { ACTIVESUPPORT_DSL } from "./activesupport.js";
import { RAILS_DSL } from "./rails.js";
import { RUBY_CORE_DSL } from "./ruby-core.js";
import type { RubyDslEntry, RubyDslModule } from "./types.js";

export function composeModules(
  modules: readonly RubyDslModule[],
): Record<string, RubyDslEntry> {
  const out: Record<string, RubyDslEntry> = {};
  for (const mod of modules) {
    for (const [keyword, entry] of Object.entries(mod.entries)) {
      if (keyword in out) {
        throw new Error(
          `Ruby DSL catalogue: duplicate keyword "${keyword}" (module "${mod.framework}")`,
        );
      }
      out[keyword] = entry;
    }
  }
  return out;
}

const MODULES: readonly RubyDslModule[] = [
  RUBY_CORE_DSL,
  ACTIVESUPPORT_DSL,
  RAILS_DSL,
];

export const RUBY_DSL: Record<string, RubyDslEntry> = composeModules(MODULES);
```

- [ ] **Step 5: Write the byte-identical guard test** (new entity test,
      allowed):

```ts
// dsl/catalogue.test.ts — pin the composed surface
import { describe, expect, it } from "vitest";

import { RUBY_DSL } from "./index.js";

describe("RUBY_DSL composition", () => {
  it("exposes every framework keyword exactly once", () => {
    // representative keywords from each module resolve
    expect(RUBY_DSL.attr_accessor?.category).toBe("accessor"); // ruby-core
    expect(RUBY_DSL.delegate?.category).toBe("delegation"); // activesupport
    expect(RUBY_DSL.has_many?.category).toBe("association"); // rails
    expect(RUBY_DSL.before_action?.category).toBe("callback"); // rails
    expect(RUBY_DSL.alias?.redirectTarget).toBe("alias-keyword-old");
  });
  it("throws on a duplicate keyword across modules", async () => {
    const { composeModules } = await import("./catalogue.js");
    expect(() =>
      composeModules([
        { framework: "a", entries: { x: { category: "other" } } },
        { framework: "b", entries: { x: { category: "other" } } },
      ]),
    ).toThrow(/duplicate keyword "x"/);
  });
});
```

- [ ] **Step 6: Build + ALL existing ruby tests green (UNTOUCHED)**

Run: `npm run build && npx vitest run src/core/domains/language/ruby` Expected:
tsc 0; all existing chunker/walker/dsl tests PASS unchanged (composed `RUBY_DSL`
is identical to the old flat object — any missing/renamed keyword fails an
existing test).

- [ ] **Step 7: Commit**

```bash
git add src/core/domains/language/ruby/dsl/
git commit -m "refactor(language): split ruby DSL catalogue into per-framework modules

Why: flat RUBY_DSL mixed ruby-core/activesupport/rails in one deep-silo file;
per-framework modules + composeModules make adding a framework a new-file change.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task A3: Redistribute catalogue tests per module (LAST, examples preserved)

**Files:**

- Modify/Create: per-module test files under `tests/.../ruby/dsl/` mirroring
  existing catalogue test cases.

- [ ] **Step 1: Locate existing catalogue tests** —
      `npx vitest run src/core/domains/language/ruby/dsl --reporter=verbose` (or
      find the test file importing `RUBY_DSL`). Record the baseline
      `it`/`describe` count.
- [ ] **Step 2: Move each existing case to the module that now owns its
      keyword** (e.g. an `attr_accessor` case → `ruby-core.test.ts`). MOVE only
      — do not rewrite assertions. Imports/setup may be adapted.
- [ ] **Step 3: Verify count ≥ baseline** — sum `it`/`describe` across the new
      per-module files; must be ≥ the Step 1 baseline. No case dropped.
- [ ] **Step 4: Run** `npx vitest run src/core/domains/language/ruby/dsl` — all
      PASS.
- [ ] **Step 5: Commit**

```bash
git add tests/
git commit -m "test(language): redistribute ruby DSL catalogue tests per framework module

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Beads: close the Phase A task.

---

# PHASE B — Unify the expansion engine (behavior-preserving)

Beads: create Phase B task under `cai0`/`duzy`, in_progress.

### Task B1: Create the unified engine `walker/macro-expansion.ts`

**Files:**

- Create: `src/core/domains/language/ruby/walker/macro-expansion.ts`
- Create: `tests/.../ruby/walker/macro-expansion.test.ts`

**Interfaces:**

- Consumes: `RUBY_DSL`, types from `../dsl/index.js`; `AstNode` from contracts;
  transitional `AR_ASSOCIATION_MACROS` (re-exported from `name-of.ts` OR
  temporarily duplicated here — see Step 3 note).
- Produces:
  - `interface DeclaredMethod { name: string; kind: MethodKind; category: DslCategory; startLine: number; endLine: number }`
  - `function expandClassBodyMacros(node: AstNode): DeclaredMethod[]`
  - `function expandAliasKeyword(node: AstNode): DeclaredMethod[]`

- [ ] **Step 1: Write failing tests** for the engine on representative nodes
      (use the project's existing tree-sitter parse test helper — find how
      `name-of.test.ts` / `macros.test.ts` build `AstNode`s and reuse it):

```ts
// macro-expansion.test.ts
import { parseRubyClassBody } from "<existing test helper>"; // reuse macros.test.ts helper
import { describe, expect, it } from "vitest";

import {
  expandAliasKeyword,
  expandClassBodyMacros,
} from "./macro-expansion.js";

describe("expandClassBodyMacros", () => {
  it("attr_accessor :a, :b → a/a=/b/b= instance", () => {
    const node = parseRubyClassBody("attr_accessor :a, :b");
    expect(
      expandClassBodyMacros(node).map((m) => `${m.name}:${m.kind}`),
    ).toEqual(["a:instance", "a=:instance", "b:instance", "b=:instance"]);
  });
  it("delegate :a, :b, to: :other → a/b instance, stops at hash", () => {
    const node = parseRubyClassBody("delegate :a, :b, to: :other");
    expect(expandClassBodyMacros(node).map((m) => m.name)).toEqual(["a", "b"]);
  });
  it("define_method(:foo) → foo instance (literal arg only)", () => {
    const node = parseRubyClassBody("define_method(:foo) { 1 }");
    expect(expandClassBodyMacros(node).map((m) => m.name)).toEqual(["foo"]);
  });
  it("scope :active, -> {} → active static, first arg only", () => {
    const node = parseRubyClassBody("scope :active, -> { where(x: 1) }");
    expect(expandClassBodyMacros(node)).toEqual([
      expect.objectContaining({
        name: "active",
        kind: "static",
        category: "scope",
      }),
    ]);
  });
  it("non-macro / receiver-qualified call → []", () => {
    expect(
      expandClassBodyMacros(parseRubyClassBody("obj.attr_accessor :x")),
    ).toEqual([]);
  });
});
describe("expandAliasKeyword", () => {
  it("alias new old → new instance", () => {
    expect(
      expandAliasKeyword(parseRubyClassBody("alias new_name old_name")).map(
        (m) => m.name,
      ),
    ).toEqual(["new_name"]);
  });
});
```

- [ ] **Step 2: Run, verify fail** —
      `npx vitest run .../macro-expansion.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement the engine** by consolidating the special-cases
      currently duplicated in `macros.ts` (`pushMacroSymbols`) and `name-of.ts`
      (`rubyMacroEmission` / `rubyDefineMethodEmission` /
      `rubyAliasMethodEmission`). The engine returns the FULL set with
      `category`. Per-macro arg-extraction:
  - receiver-qualified (`childForFieldName("receiver")`) → `[]`.
  - `delegate` → leading `simple_symbol` args until first non-symbol (the `to:`
    pair).
  - `alias_method` → first `simple_symbol` only (kind instance).
  - `define_method` → first arg if literal symbol/string (reuse a
    `literalNameFromArg` helper).
  - `scope` → first `simple_symbol` only, projected through its `declares`
    (static).
  - generic: every `simple_symbol` arg projected through
    `RUBY_DSL[name].declares`.
  - **transitional association source**: consult `AR_ASSOCIATION_MACROS` first
    (`AR_ASSOCIATION_MACROS[name] ?? RUBY_DSL[name]?.declares`) so codegraph
    output is identical at Phase B. Mark this with
    `// TODO(Phase C): drop AR_ASSOCIATION_MACROS once rails.ts owns association declares`.
    Category for those comes from `RUBY_DSL[name]?.category ?? "association"`.
  - `startLine`/`endLine` from `node.startPosition.row + 1` /
    `endPosition.row + 1`.

  `expandAliasKeyword(node)` handles the `alias` keyword AST node (first
  `identifier` child → instance method).

- [ ] **Step 4: Run, verify pass** —
      `npx vitest run .../macro-expansion.test.ts` → PASS.

- [ ] **Step 5: Build** — `npm run build` → tsc 0.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/language/ruby/walker/macro-expansion.ts tests/
git commit -m "refactor(language): add unified ruby class-body macro-expansion engine

Why: expansion logic was duplicated across chunker macros.ts and codegraph
name-of.ts; one engine prevents silent chunker<->codegraph symbolId divergence.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task B2: Rewire chunker `macros.ts` to the engine (byte-identical)

**Files:**

- Modify: `src/core/domains/language/ruby/walker/macros.ts`

**Interfaces:**

- Consumes: `expandClassBodyMacros`, `expandAliasKeyword`, `DeclaredMethod` from
  `./macro-expansion.js`.

- [ ] **Step 1: Replace `pushMacroSymbols` body** with a call to the engine; map
      `DeclaredMethod` → `RubyMacroSymbol`
      (`{ name, kind, startLine, endLine }`); apply the chunker emission policy
      that DROPS `category === "association"` (preserves today's no-association
      chunk payload). Replace `pushAliasKeywordSymbol` body with
      `expandAliasKeyword`. Keep the `singleton_class` → static override in
      `extractRubyMacroSymbols`.

```ts
// inside extractRubyMacroSymbols loop, per stmt:
for (const m of expandClassBodyMacros(stmt)) {
  if (m.category === "association") continue; // chunker policy: associations are codegraph-only (Phase B parity)
  out.push({
    name: m.name,
    kind: m.kind,
    startLine: m.startLine,
    endLine: m.endLine,
  });
}
for (const m of expandAliasKeyword(stmt)) {
  out.push({
    name: m.name,
    kind: m.kind,
    startLine: m.startLine,
    endLine: m.endLine,
  });
}
```

- [ ] **Step 2: Build + existing chunker tests green (UNTOUCHED)**

Run:
`npm run build && npx vitest run src/core/domains/language/ruby/walker/macros src/core/domains/language/ruby/chunking`
Expected: tsc 0; all existing macro/chunker tests PASS unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/core/domains/language/ruby/walker/macros.ts
git commit -m "refactor(language): chunker macros.ts delegates to unified expansion engine

Why: removes the chunker's hand-rolled macro special-cases; association drop is
the chunker emission policy, keeping chunk payload byte-identical (Phase B).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task B3: Rewire codegraph `name-of.ts` to the engine (byte-identical)

**Files:**

- Modify: `src/core/domains/language/ruby/walker/name-of.ts`

- [ ] **Step 1: Replace `rubyMacroEmission` / `rubyDefineMethodEmission` /
      `rubyAliasMethodEmission` / `rubyAliasKeywordEmission` call sites in
      `rbNameOf`** with the shared engine. Map `DeclaredMethod` → `NamedSymbol`
      (`{ name, descendsInto: false, methodKind: kind }`); keep the
      `rubyInsideSingletonClass` → `toStaticKind` override.
      `AR_ASSOCIATION_MACROS` stays in this file but is now consumed BY the
      engine (re-exported to it), not by a local loop — OR keep it local and
      pass it: simplest is to export `AR_ASSOCIATION_MACROS` from `name-of.ts`
      and have `macro-expansion.ts` import it (transitional; deleted in Phase
      C). `rbNameOf` keeps the `method`/`class`/`module` branches unchanged —
      only the macro `call`/`alias` branches route through the engine.

```ts
if (node.type === "call" || node.type === "method_call") {
  const emit = expandClassBodyMacros(node).map((m) => ({
    name: m.name,
    descendsInto: false,
    methodKind: m.kind,
  }));
  if (emit.length > 0)
    return rubyInsideSingletonClass(node) ? toStaticKind(emit) : emit;
}
if (node.type === "alias") {
  const aliasEmit = expandAliasKeyword(node).map((m) => ({
    name: m.name,
    descendsInto: false,
    methodKind: m.kind,
  }));
  if (aliasEmit.length > 0)
    return rubyInsideSingletonClass(node) ? toStaticKind(aliasEmit) : aliasEmit;
}
```

> Note: `define_method`/`alias_method` precedence is now inside the engine.
> Verify the engine reproduces the old precedence (define_method → alias_method
> → DSL macro) and the literal-name handling, so codegraph output is unchanged.

- [ ] **Step 2: Build + existing codegraph/name-of tests green (UNTOUCHED)**

Run:
`npm run build && npx vitest run src/core/domains/language/ruby/walker/name-of src/core/domains/trajectory/codegraph`
Expected: tsc 0; all existing tests PASS unchanged.

- [ ] **Step 3: Commit**

```bash
git add src/core/domains/language/ruby/walker/name-of.ts src/core/domains/language/ruby/walker/macro-expansion.ts
git commit -m "refactor(language): codegraph name-of.ts delegates to unified expansion engine

Why: codegraph and chunker now expand class-body macros through ONE engine;
AR_ASSOCIATION_MACROS stays transitional until Phase C moves it to rails.ts.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task B4: Golden lockstep regression test

**Files:**

- Create: `tests/.../ruby/macro-lockstep.test.ts`

- [ ] **Step 1: Write a golden test** that parses a representative Rails model
      fixture (attr_accessor + delegate + has_many + belongs_to + scope +
      alias + define_method) and asserts the chunker symbol set and the
      codegraph symbol set match their Phase-A snapshot — chunker WITHOUT
      associations, codegraph WITH associations (current behavior). Use inline
      expected arrays (no behavior change expected vs main).
- [ ] **Step 2: Run** — `npx vitest run .../macro-lockstep.test.ts` → PASS
      (documents the Phase B invariant).
- [ ] **Step 3: Full ruby suite** —
      `npx vitest run src/core/domains/language/ruby src/core/domains/trajectory/codegraph`
      → all PASS.
- [ ] **Step 4: Commit**

```bash
git add tests/
git commit -m "test(language): golden lockstep regression for ruby macro expansion

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Beads: close the Phase B task.

---

# PHASE C — Associations into catalogue + extension (BEHAVIOR CHANGE)

Beads: create Phase C task under `cai0`/`duzy`, in_progress. This phase moves
the metric — implement, then live-validate ALONE.

### Task C1: Add association/scope `declares` to `rails.ts`

**Files:**

- Modify: `src/core/domains/language/ruby/dsl/rails.ts`
- Create/extend: `tests/.../ruby/dsl/rails.test.ts`

**Interfaces:**

- Consumes: `singularizeAssociation` from `./inflection.js`;
  `DeclaredMethodSpec`, `MethodKind` from `./types.js`.

- [ ] **Step 1: Write failing tests** for the new declares (via
      `RUBY_DSL[name].declares`):

```ts
import { describe, expect, it } from "vitest";

import { RUBY_DSL } from "./index.js";

describe("ActiveRecord association declares", () => {
  it("has_many :posts → posts/posts=/post_ids/post_ids=", () => {
    expect(RUBY_DSL.has_many?.declares?.("posts").map((m) => m.name)).toEqual([
      "posts",
      "posts=",
      "post_ids",
      "post_ids=",
    ]);
  });
  it("has_many :categories singularizes → category_ids", () => {
    expect(
      RUBY_DSL.has_many?.declares?.("categories").map((m) => m.name),
    ).toContain("category_ids");
  });
  it("belongs_to :user → user/user=/build_user/create_user/user_id/user_id=", () => {
    expect(RUBY_DSL.belongs_to?.declares?.("user").map((m) => m.name)).toEqual([
      "user",
      "user=",
      "build_user",
      "create_user",
      "user_id",
      "user_id=",
    ]);
  });
  it("has_one :profile → profile/profile=/build_profile/create_profile", () => {
    expect(RUBY_DSL.has_one?.declares?.("profile").map((m) => m.name)).toEqual([
      "profile",
      "profile=",
      "build_profile",
      "create_profile",
    ]);
  });
  it("scope :active → active static", () => {
    expect(RUBY_DSL.scope?.declares?.("active")).toEqual([
      { name: "active", kind: "static" },
    ]);
  });
});
```

- [ ] **Step 2: Run, verify fail** — `npx vitest run .../rails.test.ts` → FAIL
      (declares undefined).

- [ ] **Step 3: Implement** the association declares in `rails.ts`:

```ts
import { singularizeAssociation } from "./inflection.js";
import type { DeclaredMethodSpec } from "./types.js";

const collection = (b: string): DeclaredMethodSpec[] => [
  { name: b, kind: "instance" }, { name: `${b}=`, kind: "instance" },
  { name: `${singularizeAssociation(b)}_ids`, kind: "instance" },
  { name: `${singularizeAssociation(b)}_ids=`, kind: "instance" },
];
const singularAssoc = (b: string): DeclaredMethodSpec[] => [
  { name: b, kind: "instance" }, { name: `${b}=`, kind: "instance" },
  { name: `build_${b}`, kind: "instance" }, { name: `create_${b}`, kind: "instance" },
];
// in entries:
has_many: { category: "association", declares: collection },
has_one: { category: "association", declares: singularAssoc },
has_and_belongs_to_many: { category: "association", declares: collection },
belongs_to: { category: "association",
  declares: (b) => [...singularAssoc(b), { name: `${b}_id`, kind: "instance" }, { name: `${b}_id=`, kind: "instance" }] },
scope: { category: "scope", declares: (b) => [{ name: b, kind: "static" }] },
```

- [ ] **Step 4: Run, verify pass** — `npx vitest run .../rails.test.ts` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/dsl/rails.ts tests/
git commit -m "feat(language): ActiveRecord association + scope declares in rails DSL module

Why: associations now carry their synthesized accessors in the catalogue, the
single source both chunker and codegraph read.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task C2: Remove `AR_ASSOCIATION_MACROS`, drop chunker association filter

**Files:**

- Modify: `src/core/domains/language/ruby/walker/name-of.ts` (delete
  `AR_ASSOCIATION_MACROS`)
- Modify: `src/core/domains/language/ruby/walker/macro-expansion.ts` (stop
  consulting `AR_ASSOCIATION_MACROS`; read catalogue only)
- Modify: `src/core/domains/language/ruby/walker/macros.ts` (remove the
  `category === "association"` drop)

- [ ] **Step 1: Write failing lockstep test** — both chunker and codegraph emit
      the SAME association accessors from the catalogue:

```ts
it("has_many :posts emits identical symbols in chunker and codegraph", () => {
  const node = parseRubyClassBody("class User; has_many :posts; end"); // adapt to fixtures
  const chunkNames = extractRubyMacroSymbols(classNode)
    .map((m) => m.name)
    .sort();
  const cgNames = collectNamedSymbols(classNode)
    .map((s) => s.name)
    .sort(); // adapt helper
  expect(chunkNames).toEqual(
    expect.arrayContaining(["posts", "posts=", "post_ids", "post_ids="]),
  );
  expect(cgNames).toEqual(chunkNames);
});
```

- [ ] **Step 2: Run, verify fail** — chunker still drops associations → FAIL.
- [ ] **Step 3: Implement** — delete `AR_ASSOCIATION_MACROS` from `name-of.ts`;
      in `macro-expansion.ts` change the builder lookup from
      `AR_ASSOCIATION_MACROS[name] ?? RUBY_DSL[name]?.declares` to just
      `RUBY_DSL[name]?.declares`; in `macros.ts` delete the
      `if (m.category === "association") continue;` line.
- [ ] **Step 4: Run, verify pass + full suite** —
      `npx vitest run src/core/domains/language/ruby src/core/domains/trajectory/codegraph`.
      The Phase-B golden lockstep test (B4) now legitimately changes (chunker
      gains associations) — UPDATE its expected arrays to the new lockstep
      snapshot (this is updating a snapshot for an intended behavior change, not
      rewriting business logic).
- [ ] **Step 5: Commit**

```bash
git add src/core/domains/language/ruby/walker/ tests/
git commit -m "feat(language): unify association emission via catalogue; drop hidden AR map

Why: AR_ASSOCIATION_MACROS was a codegraph-only second catalogue; chunker and
codegraph now emit association accessors from the same rails.ts declares.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task C3: Live validation against huginn + metric-gated method-set tuning

**Files:** none (validation); possible `rails.ts` tuning follow-up.

- [ ] **Step 1: Build + link the worktree**

```bash
cd /Users/artk0re/Dev/Tools/tea-rags-mcp/.claude/worktrees/ruby-dsl-decomposition
npm run build && npm link
```

- [ ] **Step 2: Kill stale processes** (so the MCP server reloads the new
      build):

```bash
pkill -9 -f "tea-rags server" || true
pkill -9 -f "chunker/infra/worker.js" || true
pkill -9 -f "duckdb/daemon/entry" || true
# leave qdrant running
```

- [ ] **Step 3: Ask the user to `/mcp reconnect tea-rags`** (manual; do not use
      AskUserQuestion). Wait for confirmation.
- [ ] **Step 4: Force-reindex huginn**, then read the resolve breakdown:

```
mcp__tea-rags__force_reindex project=huginn
# then read DEBUG byReceiverKind:
mcp__tea-rags__get_index_status project=huginn   # with DEBUG=1 env on the server
```

- [ ] **Step 5: Read the delta** — compare `resolveSuccessRate` byReceiverKind
      `bareCall` bucket vs the pre-Phase-C baseline (huginn ruby 0.523). Record
      attempted/resolved/externalSkipped for bareCall before/after. Attribute
      the delta to Phase C alone.
- [ ] **Step 6: Tune the method-set if warranted** — if
      `_ids`/`build_`/`create_` accessors do NOT appear among resolved bareCalls
      (no weight), trim them from `rails.ts` to avoid synthetic-symbol noise; if
      they DO resolve real call sites, keep. Document what was kept/dropped in
      the beads task + a code comment. Re-run Steps 1-5 after any trim.
- [ ] **Step 7: Commit any tuning** (if Step 6 changed `rails.ts`):

```bash
git add src/core/domains/language/ruby/dsl/rails.ts
git commit -m "improve(language): trim association accessor set to measured-resolving methods

Why: <metric note — which accessors resolved real huginn bareCalls, which were noise>.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

Beads: close the Phase C task + the parent `duzy`/`cai0` child as appropriate.
Record the huginn before/after in a `cai0` comment.

---

## Self-Review

- **Spec coverage:** Phase A (decomposition + types + inflection +
  composeModules + dup-guard) ✓; Phase B (engine + both consumers + golden) ✓;
  Phase C (rails declares + delete AR map + drop Non-Goal + live-validate +
  metric-gate) ✓; mechanism/policy split ✓ (chunker category filter); honest
  recall caveat ✓ (Phase C tuning is metric-gated). Non-Goals (method_missing,
  Concern merge) untouched ✓.
- **Type consistency:** `RubyDslModule`, `RubyDslEntry`, `DeclaredMethodSpec`,
  `MethodKind`, `DslCategory` defined in `dsl/types.ts` (Task A1) and consumed
  consistently; `DeclaredMethod` (with `category`/lines) defined in
  `macro-expansion.ts` (Task B1) and consumed in B2/B3/C2.
  `expandClassBodyMacros` / `expandAliasKeyword` names consistent across B1→C2.
  `singularizeAssociation` signature stable A1→C1.
- **Placeholder scan:** the only deferred specifics are intentional — exact
  validation/callback entry list is "verbatim copy from current catalogue.ts"
  (mechanical, byte-identical test catches omissions), and the test-helper
  import (`parseRubyClassBody`) is "reuse the existing
  macros.test.ts/name-of.test.ts helper" (the worker must read those test files
  to find the real helper name). No `TBD`/`implement later`.
- **Open decision (flagged, not a blocker):** the extended accessor set in C1
  (`_ids`/`build_`/`create_`/foreign-key) is the conventional Rails set; C3 Step
  6 trims it by measured resolution — this is the metric-gate, not a
  placeholder.

## Execution Handoff

Plan saved to
`docs/superpowers/plans/2026-06-22-ruby-dsl-per-framework-decomposition-plan.md`.
