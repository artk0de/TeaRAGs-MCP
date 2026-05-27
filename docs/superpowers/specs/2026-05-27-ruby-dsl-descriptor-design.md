# Ruby DSL Descriptor — Unifying the Method-Declaring Macro Vocabulary

**Date:** 2026-05-27
**Status:** Design approved — ready for implementation plan
**Scope:** `src/core/domains/language/ruby/` (chunker + codegraph-walker side only)

## Problem

The knowledge that certain Ruby idioms (`attr_accessor`, `delegate`,
`alias_method`, `define_method`, …) are **method-declaring macros** is encoded
independently in **three** places, with no shared source of truth:

1. **`ruby/chunking/class-body-chunker.ts`** — `DECLARATION_KEYWORDS` maps the
   accessor / delegation macros to chunk **group types** (`attr_accessor →
   "attributes"`, `delegate → "delegates"`) to cluster consecutive DSL
   declaration lines into one chunk.
2. **`ruby/walker/macros.ts`** — `RUBY_DSL_MACROS` maps each macro to the
   **synthetic method symbols** it declares (`attr_accessor → getter + setter`),
   consumed by the chunker's `macroSymbols` capability to emit searchable
   `Class#method` chunks.
3. **`ruby/walker/walker.ts`** — hand-rolled `alias` / `alias_method` blocks emit
   a **redirect call edge** (new method → old method) into the codegraph.

Each place independently "knows" which names are method-declaring macros. Adding
a macro to one without the others is a silent drift — confirmed by tea-rags as
the churn epicenter of the Ruby DSL surface (`rbNameOf` changeDensity "intense",
the whole surface 100% single-owner with no reviewer-pairing safety net).

This is the **only** genuine cross-consumer overlap in the Ruby DSL surface.
Zeitwerk conventions are resolver-only; RSpec method-sets and the broad Rails
grouping vocabulary (validations / scopes / callbacks / associations) are
chunker-only; the resolver consumes neither macros nor the group map. Those are
explicitly **out of scope** — unifying them would be artificial.

## Goal

Extract the method-declaring macro vocabulary into a single declarative
descriptor module `ruby/dsl/` that all three consumers read, so a macro is
defined **once** and every consumer derives its behaviour from it. Adding a new
macro becomes a one-line edit that the chunker grouping, symbol synthesis, and
walker redirect all pick up automatically.

## Non-Goals

- No unification with the resolver (Zeitwerk / require) — disjoint knowledge.
- No unification of RSpec method-sets or non-method-declaring Rails keywords
  (validations / scopes / callbacks / associations / enums / …) — these stay in
  `class-body-chunker`'s own map; they do not declare methods.
- No change to the chunker **engine** (`ingest/.../chunker/tree-sitter.ts`). It
  keeps consuming the `macroSymbols` capability through the existing interface;
  the descriptor lives behind that capability.
- No new procedural behaviour in the descriptor — it is declarative data only.

## Architecture

```
ruby/dsl/macros.ts            ← single declarative source of truth
        │
        ├─► ruby/chunking/class-body-chunker.ts   (category → chunk group)
        ├─► ruby/walker/macros.ts                  (declares → synthetic symbols)
        └─► ruby/walker/walker.ts                  (redirectTarget → redirect edge)
```

All imports are sibling imports **within** `domains/language/ruby/` — no
cross-domain boundary, no eslint guard impact, the worker is untouched.

### The descriptor (`ruby/dsl/macros.ts`)

Each entry carries **intrinsic facts about the macro** — never a consumer's
output vocabulary.

```ts
type MethodKind = "instance" | "static";

type MacroCategory = "accessor" | "delegation" | "alias" | "dynamic-method";

interface RubyMacroSpec {
  /** Intrinsic category of the macro (NOT a chunker group name). */
  category: MacroCategory;
  /**
   * Synthetic methods the macro declares, given an already-parsed base symbol
   * name. Pure; the AST argument extraction that produces `base` lives in the
   * consumer matcher, not here.
   */
  declares: (base: string) => { name: string; kind: MethodKind }[];
  /**
   * Only for `alias` / `alias_method`: how the walker locates the redirect
   * target (the OLD method name) so it can emit a new→old call edge.
   */
  redirectTarget?: "second-symbol" | "alias-keyword-old";
}

const RUBY_METHOD_MACROS: Record<string, RubyMacroSpec> = {
  attr_accessor:  { category: "accessor",   declares: b => [{ name: b, kind: "instance" }, { name: `${b}=`, kind: "instance" }] },
  attr_reader:    { category: "accessor",   declares: b => [{ name: b, kind: "instance" }] },
  attr_writer:    { category: "accessor",   declares: b => [{ name: `${b}=`, kind: "instance" }] },
  cattr_accessor: { category: "accessor",   declares: b => [{ name: b, kind: "static" }, { name: `${b}=`, kind: "static" }] },
  cattr_reader:   { category: "accessor",   declares: b => [{ name: b, kind: "static" }] },
  cattr_writer:   { category: "accessor",   declares: b => [{ name: `${b}=`, kind: "static" }] },
  mattr_accessor: { category: "accessor",   declares: b => [{ name: b, kind: "static" }, { name: `${b}=`, kind: "static" }] },
  mattr_reader:   { category: "accessor",   declares: b => [{ name: b, kind: "static" }] },
  mattr_writer:   { category: "accessor",   declares: b => [{ name: `${b}=`, kind: "static" }] },
  delegate:       { category: "delegation", declares: b => [{ name: b, kind: "instance" }] },
  define_method:  { category: "dynamic-method", declares: b => [{ name: b, kind: "instance" }] },
  alias_method:   { category: "alias", declares: b => [{ name: b, kind: "instance" }], redirectTarget: "second-symbol" },
  // `alias` keyword form is matched by the walker/macros consumers directly
  // (it is not a `call` node); its spec is keyed under "alias".
  alias:          { category: "alias", declares: b => [{ name: b, kind: "instance" }], redirectTarget: "alias-keyword-old" },
};
```

`RUBY_METHOD_MACROS` is the entire shared knowledge. Each consumer maps it to
its own output.

## Consumer Projections

### 1. `class-body-chunker.ts` — `category → group`

The chunker owns the mapping from intrinsic category to its grouping vocabulary
(the descriptor stays free of chunker concepts):

```ts
const CATEGORY_TO_GROUP: Record<MacroCategory, string> = {
  accessor: "attributes",
  delegation: "delegates",
  alias: "aliases",                 // NEW grouping (behaviour addition)
  "dynamic-method": "dynamic_methods", // NEW grouping (behaviour addition)
};
```

`DECLARATION_KEYWORDS` is built at module load by merging:

- the **non-method-declaring** Rails/RSpec/FactoryBot keywords (associations,
  validations, scopes, callbacks, includes, enums, state_machine,
  concern_hooks, setup, hooks, shared, factory, nested_attrs, other) — kept
  hardcoded in `class-body-chunker`, unchanged; with
- the descriptor entries mapped `name → CATEGORY_TO_GROUP[spec.category]`.

`classifyLine` continues to look up a line's first identifier in the merged map.

**Behaviour change (intentional):** `alias`, `alias_method`, and `define_method`
lines were previously ungrouped (fell through to continuation). They now
cluster into `"aliases"` / `"dynamic_methods"` groups.

### 2. `ruby/walker/macros.ts` — `declares → synthetic symbols`

`extractRubyMacroSymbols` reads the descriptor instead of a local table:

- Recognise a macro call by membership in `RUBY_METHOD_MACROS`.
- Extract the base symbol arguments from the AST (this AST parsing — leading
  symbols until the first kwarg for `delegate`, the literal symbol/string for
  `define_method`, the first symbol for `alias_method`, the alias-keyword new
  name — **stays in this consumer**; it differs per macro).
- For each parsed `base`, call `spec.declares(base)` → `MacroSymbol[]`.

The local `RUBY_DSL_MACROS` constant is deleted; the per-macro arg-extraction
helpers (`stripSymbolColon`, `literalNameFromArg`, the delegate/alias_method/
define_method branches) remain — they are AST parsing, not vocabulary.

### 3. `ruby/walker/walker.ts` — `redirectTarget → redirect edge`

The hand-rolled `alias` (keyword) and `alias_method` (call) blocks become
descriptor-driven: when a matched macro's spec has `redirectTarget`, the walker
extracts the old-method name by that strategy (`"second-symbol"` /
`"alias-keyword-old"`) and emits the redirect `CallRef`. The surrounding general
call-edge walking (bare-id, super, send-unwrap, block-pass, generic calls) is
unchanged — it is not macro DSL.

## What stays per-consumer (deliberately not unified)

- **AST argument extraction** — differs by consumer (chunker extracts declared
  method names; walker extracts the redirect target). The descriptor hands
  consumers an already-parsed `base` / a `redirectTarget` strategy, not the
  parsing itself.
- **Emission** — chunk grouping vs `MacroSymbol[]` vs `CallRef` are each the
  consumer's own output.

## Migration Order (refactor-migration-test-order + TDD for the addition)

1. **Create `ruby/dsl/macros.ts`** (the descriptor) + a direct unit test
   asserting each macro's `category` / `declares(base)` / `redirectTarget`.
2. **Re-target the two relocation consumers** (`ruby/walker/macros.ts` synthesis,
   `ruby/walker/walker.ts` redirect) to read the descriptor — **without touching
   their tests**. Existing macro-symbol and alias-redirect tests stay green
   (pure relocation, output unchanged).
3. **Re-target `class-body-chunker`** to build `DECLARATION_KEYWORDS` from its
   own non-macro keywords ∪ descriptor-derived accessor/delegation entries —
   existing grouping tests for attributes/delegates stay green.
4. **TDD the behaviour addition** — failing test first: `define_method` line →
   `"dynamic_methods"`, `alias` / `alias_method` line → `"aliases"`. Then wire
   the `alias` + `dynamic-method` entries into `CATEGORY_TO_GROUP`, green.
   Update the (few) existing `class-body-chunker` assertions that expected those
   lines ungrouped — the business logic changed intentionally.
5. **Delete the local duplicates** — `RUBY_DSL_MACROS` from
   `ruby/walker/macros.ts`; the hardcoded accessor/delegation entries from
   `class-body-chunker`'s `DECLARATION_KEYWORDS`.

## Testing

- **Descriptor (new entity):** direct table test — per macro, assert category,
  `declares(base)` output (name + kind), and `redirectTarget`.
- **Relocation consumers:** existing `ruby/walker/macros` (macro-symbol synthesis)
  and `ruby/walker/walker` (alias-redirect edge) tests remain unchanged and green
  — they are business-logic tests; relocation must not alter their examples.
- **class-body-chunker:** existing attributes/delegates grouping tests stay green;
  NEW tests assert the `aliases` / `dynamic_methods` grouping; the small number
  of prior assertions expecting `define_method`/`alias` ungrouped are updated to
  the new grouping (intentional behaviour change).
- **Full gates:** `npx tsc --noEmit` = 0 · `npx eslint src/ --quiet` clean ·
  `npm run build` = 0 · `npx vitest run` full suite green · guard grep: zero
  cross-domain imports (everything is within `domains/language/ruby/`).

## Risk (from tea-rags enrichment)

- The chunker **engine** `tree-sitter.ts` (hotspot, bugFixRate 32 "concerning")
  is **not touched** — it consumes the `macroSymbols` capability unchanged.
- `ruby/walker/walker.ts` is deep-silo (single-owner); the change is a surgical
  replacement of the `alias` / `alias_method` blocks with descriptor-driven
  redirect emission. The deep-silo commit message carries a `Why:` line.
- The whole Ruby DSL surface is single-owner — the descriptor is written to
  **read as documentation** (the spec table IS the macro catalogue), which is
  the mitigation for the missing reviewer-pairing safety net.

## Affected Files

- **New:** `ruby/dsl/macros.ts`, `ruby/dsl/index.ts` (barrel),
  `tests/core/domains/language/ruby/dsl/macros.test.ts`.
- **Modified:** `ruby/walker/macros.ts` (read descriptor, drop `RUBY_DSL_MACROS`),
  `ruby/walker/walker.ts` (descriptor-driven redirect),
  `ruby/chunking/class-body-chunker.ts` (build `DECLARATION_KEYWORDS` from
  descriptor + `CATEGORY_TO_GROUP`, add alias/dynamic-method grouping),
  and the corresponding test files per the migration order.
