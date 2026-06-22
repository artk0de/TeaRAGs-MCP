# Ruby DSL Per-Framework Decomposition + Unified Macro-Expansion Engine

- **Date**: 2026-06-22
- **Epic**: `tea-rags-mcp-cai0` (Ruby resolver precision) → child of
  `tea-rags-mcp-duzy` (Ruby/Rails syntactic resolver improvements)
- **Status**: Approved design

## Problem

`src/core/domains/language/ruby/dsl/catalogue.ts` is a flat
`RUBY_DSL: Record<string, RubyDslEntry>` that mixes three distinct frameworks in
one file:

- **Ruby-core** macros: `attr_accessor`/`attr_reader`/`attr_writer`,
  `define_method`, `alias`, `alias_method`, `include`/`extend`/`prepend`.
- **ActiveSupport**: `cattr_*`/`mattr_*` accessor families, `delegate`,
  `delegate_missing_to`, `class_attribute`, concern hooks, `attribute`,
  `store_accessor`, `serialize`.
- **ActiveRecord / Rails**: associations (`has_many`/`has_one`/`belongs_to`/
  `has_and_belongs_to_many`), `validates*`, callbacks (`before_*`/`after_*`/
  `around_*`), `scope`, `enum`, nested-attrs, `*_attached`, `aasm`.

Adding a framework means editing the shared file — an OCP violation. The
optional `declares?` field mixes method-declaring and group-only entries.

### The real rot: duplicated expansion + a hidden second catalogue

Macro **expansion** (turning a class-body macro call into the synthetic methods
it declares) is duplicated across two consumers, each re-implementing the
special-cases:

- `walker/macros.ts` `pushMacroSymbols` (chunker payload) — special-cases for
  `delegate` (stop-at-hash), `alias_method` (first symbol), `define_method`
  (literal name), `alias` keyword form + a generic `entry.declares` loop.
- `walker/name-of.ts` `rbNameOf` / `rubyMacroEmission` (codegraph `cg_symbols`)
  — special-cases for `define_method`, `alias_method`, `alias` keyword + `scope`
  first-arg-only + a generic loop reading
  `AR_ASSOCIATION_MACROS[name] ?? RUBY_DSL[name]?.declares`.

`AR_ASSOCIATION_MACROS` (name-of.ts:180) is a **hidden second catalogue**:
codegraph-only `declares` for associations (`has_many`→`posts`/`posts=`,
`belongs_to`→`user`/`user=`/`user_id`/`user_id=`, `scope`→static) that the
shared catalogue deliberately keeps group-only. The lockstep comment claims
"chunker symbolIds match cg_symbols by construction" — true ONLY for shared
catalogue macros. For associations the two consumers already **diverge**:
codegraph emits accessors the chunker never sees. Divergence between the two
hand-written expanders silently breaks chunker↔codegraph `symbolId` agreement.

### Consumers of `RUBY_DSL` (all must keep working)

1. `chunking/class-body-chunker.ts:84` — `entry.category` → `CATEGORY_TO_GROUP`.
2. `walker/macros.ts:147` — `RUBY_DSL[name]` for `.declares` (chunker payload).
3. `walker/name-of.ts:222` — `RUBY_DSL[name]?.declares` +
   `AR_ASSOCIATION_MACROS` (codegraph `cg_symbols`).
4. `walker/walker.ts:635` — `category === "callback"`.
5. `walker/walker.ts:753,895` — `redirectTarget` (alias redirect detection).

## Goals

1. **Per-framework decomposition** — each framework's macros live in their own
   file under `ruby/dsl/`, composed into one `RUBY_DSL` lookup. Adding a
   framework = new file + one registration line.
2. **Unify the expansion engine** — one `expandClassBodyMacros(node)` both
   consumers call, so chunker and codegraph cannot diverge by construction.
   Removes the hidden `AR_ASSOCIATION_MACROS` and the duplicated special-cases.
3. **Enable macro-synthesis (secondary, metric-gated)** — once associations
   carry `declares` in the catalogue, extend the accessor set
   (`post_ids`/`build_`/`create_`/foreign-keys) against measured huginn bareCall
   misses.

### Non-Goals / honest scope

- This is **primarily an architecture refactor** (kill duplication + the hidden
  catalogue, make framework addition cheap). codegraph **already** synthesizes
  core association accessors via `AR_ASSOCIATION_MACROS`, so the resolve-recall
  gain from this work is a **refinement** (extended method sets), NOT a large
  lever. Do not over-claim a recall jump.
- No `method_missing`, no dynamically-constructed names, no `included do`
  Concern mixin merge — out of scope in both layers today, stays out.
- Literal "zero edits to existing files" is **not** achievable with static TS
  imports: a new framework module needs one line in the composition list. That
  is a normal registration seam (open for extension), not a violation.

## Design

### Mechanism vs Policy (the load-bearing principle)

The catalogue already separates intrinsic facts from consumer policy:
`catalogue.ts` notes the chunk-group name is "the chunker's **policy**, not an
intrinsic fact, so it lives there not here" (`CATEGORY_TO_GROUP` is in the
chunker). Apply the same cut to `declares`:

- **Mechanism (unified, one):** `expandClassBodyMacros(node) → DeclaredMethod[]`
  computes the FULL declared-method set. One engine, special-cases handled once.
- **Policy (per consumer):** codegraph takes all; the chunker runs the result
  through its own `category`-based filter (co-located with `CATEGORY_TO_GROUP`).
  The engine is NOT coupled to policy — a consumer can opt out of part of the
  behavior without touching the engine or the catalogue.

Default chunker policy (approved): emit everything, including associations (the
former accessor-count Non-Goal is dropped). The opt-out seam is preserved.

### File structure

`dsl/` stays **pure data** (no tree-sitter import):

```
ruby/dsl/
  types.ts          # RubyDslEntry, DslCategory, MethodKind, DeclaredMethod, RubyDslModule
  inflection.ts     # singularizeAssociation (relocated from walker.ts:649) — pure string→string
  ruby-core.ts      # RUBY_CORE_DSL: attr_*/define_method/alias/alias_method/include/extend/prepend
  activesupport.ts  # ACTIVESUPPORT_DSL: cattr/mattr_*, delegate, delegate_missing_to,
                    #   class_attribute, concern-hooks, attribute, store_accessor, serialize
  rails.ts          # RAILS_DSL: associations, validations, callbacks, scope, enum,
                    #   nested-attrs, *_attached, aasm
  catalogue.ts      # composeModules(MODULES) → RUBY_DSL (merged Record) + dup-key guard
  index.ts          # barrel
```

The unified engine is tree-sitter-coupled, so it lives in `walker/`, not in the
pure-data `dsl/`:

```
ruby/walker/macro-expansion.ts   # expandClassBodyMacros(node) — THE single engine
```

### Module interface

```ts
export interface RubyDslModule {
  readonly framework: string; // provenance: "ruby-core" | "activesupport" | "rails"
  readonly entries: Record<string, RubyDslEntry>;
}

// catalogue.ts
const MODULES: readonly RubyDslModule[] = [
  RUBY_CORE_DSL,
  ACTIVESUPPORT_DSL,
  RAILS_DSL,
];
export const RUBY_DSL: Record<string, RubyDslEntry> = composeModules(MODULES);
// composeModules throws at module-load on a duplicate keyword across modules (dev guard).
```

Consumers keep their existing `RUBY_DSL[name]` lookup unchanged.

### Unified engine

```ts
// walker/macro-expansion.ts
export interface DeclaredMethod {
  name: string;
  kind: MethodKind; // "instance" | "static"
  category: DslCategory;
  startLine: number;
  endLine: number;
}
export function expandClassBodyMacros(node: AstNode): DeclaredMethod[];
```

Encapsulates: receiver guard, macro-name extraction, per-macro arg-extraction
(`delegate` stop-at-hash, `scope` first-arg-only, `define_method`/`alias_method`
literal), and the `entry.declares` projection. The `alias` keyword form (a
distinct AST node, not a `call`) is handled by a sibling export
`expandAliasKeyword(node)` to mirror today's two entry points.

- `name-of.ts` → maps `DeclaredMethod` → `NamedSymbol`, applies the
  `singleton_class` → static override (existing `toStaticKind`).
- `macros.ts` → maps `DeclaredMethod` → `MacroSymbol`, applies the chunker
  category-policy filter (default: identity / emit-all).

### Association `declares` (in `rails.ts`)

```ts
import { singularizeAssociation } from "./inflection.js";

const collection = (b: string): DeclaredMethodSpec[] => [
  { name: b, kind: "instance" }, { name: `${b}=`, kind: "instance" },
  { name: `${singularizeAssociation(b)}_ids`, kind: "instance" },
  { name: `${singularizeAssociation(b)}_ids=`, kind: "instance" },
];
const singularAssoc = (b: string): DeclaredMethodSpec[] => [
  { name: b, kind: "instance" }, { name: `${b}=`, kind: "instance" },
  { name: `build_${b}`, kind: "instance" }, { name: `create_${b}`, kind: "instance" },
];

has_many:   { category: "association", declares: collection },
has_one:    { category: "association", declares: singularAssoc },
belongs_to: { category: "association",
              declares: (b) => [...singularAssoc(b),
                                { name: `${b}_id`, kind: "instance" },
                                { name: `${b}_id=`, kind: "instance" }] },
scope:      { category: "scope", declares: (b) => [{ name: b, kind: "static" }] },
```

`singularizeAssociation` relocates `walker.ts:649 → dsl/inflection.ts`; walker
updates its import. The current minimal set (`has_many`→`posts`/`posts=`) is a
**subset** of the new set, so existing example tests stay green and methods are
only added. The exact extended set (`_ids`/`build_`/`create_`/foreign-key) is
**metric-gated** against measured huginn bareCall misses — start conventional,
keep what pulls weight.

## Implementation phases

Per the refactor-migration test order (relocate → existing tests green →
redistribute tests LAST; business-logic tests are not rewritten) and the
metric-driven cai0 ethos (one behavior change → one reindex → read delta):

- **Phase A — catalogue decomposition** (pure data relocation, ZERO behavior
  change). Split `RUBY_DSL` into `types.ts` + `ruby-core.ts` +
  `activesupport.ts`
  - `rails.ts` + composed `catalogue.ts`; `inflection.ts` relocation.
    `AR_ASSOCIATION_MACROS` stays in name-of.ts. Composed `RUBY_DSL` is
    identical. All existing tests green, untouched. Tests redistributed to
    per-module files LAST, examples preserved (validate `it`/`describe` counts ≥
    base).

- **Phase B — unify the expansion engine** (behavior-preserving refactor).
  Extract `expandClassBodyMacros` (+ `expandAliasKeyword`); both consumers call
  it; outputs byte-identical to today (associations remain codegraph-only via
  the chunker policy filter; `AR_ASSOCIATION_MACROS` still consulted). Removes
  the duplicated special-cases. All existing tests green, untouched.

- **Phase C — associations into the catalogue + extension** (behavior change,
  the approved Non-Goal removal). Add association/`scope` `declares` to
  `rails.ts`; delete `AR_ASSOCIATION_MACROS` from name-of.ts (engine now reads
  associations from the catalogue, same or extended output); drop the chunker
  association Non-Goal (chunker now emits association accessors too). New tests
  for chunker association emission + the extended method set. Live-validate
  against huginn (force-reindex, read bareCall/byReceiverKind delta).

Each phase is its own commit + its own beads task under `cai0`/`duzy`.

## Testing

- Phase A/B: existing test files stay green with import/setup adaptation only.
  Per-module test files are created by redistributing existing cases LAST; no
  case is dropped (`it`/`describe` count ≥ base per language-processing file).
- New entities (`composeModules`, `expandClassBodyMacros`, `RubyDslModule`) get
  fresh focused tests.
- Phase C: new behavioral tests for association emission (chunker + codegraph in
  lockstep on the SAME `DeclaredMethod[]`), extended accessor sets, and the
  `singularizeAssociation` edge cases already covered by walker tests.
- Live validation: huginn force-reindex; read `resolveSuccessRate`
  byReceiverKind (DEBUG) bareCall delta. Attribute the delta to Phase C alone
  (serialized).

## Risks

- **walker.ts `collectRubyCalls`** is a 256-line god-function, hub (fanIn 14),
  recent high churn — the riskiest neighbor. The engine extraction must not
  disturb its call-collection path; only the macro-symbol emission is touched.
- **macros.ts / name-of.ts are deep-silo single-owner** — the change
  consolidates both; reviewer pairing per silo-pairing rule, `Why:` line on the
  commit.
- **Phase ordering is load-bearing**: unifying the engine (B) before changing
  outputs (C) keeps chunker↔codegraph agreement provable at every commit.
