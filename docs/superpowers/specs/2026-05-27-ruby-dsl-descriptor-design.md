# Ruby DSL Descriptor — Unifying the Class-Body Declaration Vocabulary

**Date:** 2026-05-27
**Status:** Design approved — ready for implementation plan
**Scope:** `src/core/domains/language/ruby/` (chunker + codegraph-walker side only)

## Problem

The knowledge of Ruby/Rails **class-body declaration DSL** — which identifiers
are declaration macros, what category they belong to, and (for the
method-declaring subset) what methods they synthesise — is encoded
independently in several places that can silently drift:

1. **`ruby/chunking/class-body-chunker.ts`** — `DECLARATION_KEYWORDS` maps ~50
   keywords (`has_many`, `validates`, `scope`, `before_save`, `attr_accessor`,
   `delegate`, …) to chunk **group types** to cluster consecutive declaration
   lines into one chunk.
2. **`ruby/walker/macros.ts`** — `RUBY_DSL_MACROS` maps the method-declaring
   macros (`attr_accessor` → getter+setter, …) to **synthetic method symbols**,
   consumed by the chunker's `macroSymbols` capability to emit searchable
   `Class#method` chunks.
3. **`ruby/walker/walker.ts`** — hand-rolled `alias` / `alias_method` blocks emit
   a **redirect call edge** (new method → old method) into the codegraph.

The method-declaring macros (`attr_*`, `cattr_*`, `mattr_*`, `delegate`,
`define_method`, `alias[_method]`) live in **all three** places independently —
the genuine drift surface, confirmed by tea-rags as the churn epicenter of the
Ruby DSL area (single-owner, no reviewer-pairing safety net). The broader Rails
declaration keywords (associations / validations / scopes / callbacks / …) live
only in (1), but they are the same kind of knowledge ("this identifier is a
class-body declaration of category X") and are worth centralising so the chunker
stops hard-coding a 50-entry vocabulary.

## Goal

Introduce a single declarative **catalogue** `ruby/dsl/` that owns the entire
Ruby/Rails class-body declaration vocabulary: each keyword → its intrinsic
`category`, plus optional facets `declares` (method synthesis) and
`redirectTarget` (alias edge). All three consumers project from it:

- `class-body-chunker` becomes a thin projection (`category → group`), owning no
  hardcoded declaration vocabulary.
- `macroSymbols` reads `declares`.
- `walker` reads `redirectTarget`.

Add a keyword **once** in the catalogue and every consumer derives its
behaviour. The method-declaring drift is eliminated; the chunker's vocabulary is
centralised.

## Non-Goals

- **RSpec / FactoryBot testing DSL is OUT.** RSpec is chunked by a separate
  mechanism — `ruby/chunking/rspec-scope-chunker.ts` builds a describe/context
  scope tree and sets `ctx.skipChildren = true` for spec files, bypassing
  `class-body-chunker` line grouping entirely. It owns its own vocabulary sets
  (`CONTAINER_METHODS` / `EXAMPLE_METHODS` / `SETUP_METHODS`), plus
  `rspec-filter.ts`'s sets. Those are a separate testing-DSL concern; folding
  `let` / `before` / `describe` / `factory` into the Rails catalogue would be
  wrong. (The `let` / `subject` / `before` / `shared_examples` / `factory` /
  `trait` entries currently in `class-body-chunker`'s `DECLARATION_KEYWORDS` are
  most likely **dead** — spec/factory files route through `rspec-scope-chunker`
  with `skipChildren=true` — but verifying/removing them is a **separate
  follow-up**, not this design.)
- **Resolver (Zeitwerk / require) is OUT.** Disjoint knowledge (autoload
  conventions), resolver-only, stays in `ruby/resolver/zeitwerk.ts`. The
  codegraph consumer of the catalogue is the **walker** (redirect edges), not
  the resolver.
- **No expansion of the synthesis set.** `scope` / `let` / `enum` /
  associations semantically declare methods but are NOT synthesised today
  (associations explicitly excluded to avoid accessor-count inflation; others
  never added). They enter the catalogue as **group-only** entries (no
  `declares`). Expanding synthesis to cover them is a separate behavioural
  decision with its own corner cases.
- **No change to the chunker engine** (`ingest/.../chunker/tree-sitter.ts`,
  bug-prone hotspot). It keeps consuming the `macroSymbols` capability through
  the existing interface; the catalogue lives behind that capability.

## Architecture

```
ruby/dsl/catalogue.ts          ← single declarative source of class-body DSL vocabulary
        │
        ├─► ruby/chunking/class-body-chunker.ts   (category → chunk group)
        ├─► ruby/walker/macros.ts                  (declares → synthetic symbols)
        └─► ruby/walker/walker.ts                  (redirectTarget → redirect edge)
```

All imports are sibling imports **within** `domains/language/ruby/` — no
cross-domain boundary, no eslint guard impact, the worker is untouched.

### The catalogue (`ruby/dsl/catalogue.ts`)

Each entry carries **intrinsic facts about the keyword** — never a consumer's
output vocabulary (e.g. not the chunker's group name).

```ts
type MethodKind = "instance" | "static";

type DslCategory =
  // method-declaring macros (carry `declares`; alias also `redirectTarget`)
  | "accessor" | "delegation" | "alias" | "dynamic-method"
  // group-only Rails declaration keywords (no `declares`)
  | "association" | "validation" | "scope" | "callback"
  | "include" | "enum" | "state-machine" | "concern-hook"
  | "nested-attrs" | "other";

interface RubyDslEntry {
  /** Intrinsic category. The ONLY thing group-only keywords carry. */
  category: DslCategory;
  /**
   * Synthetic methods declared, given an already-parsed base symbol. Present
   * ONLY on method-declaring macros. The AST argument extraction that produces
   * `base` lives in the consumer matcher, not here.
   */
  declares?: (base: string) => { name: string; kind: MethodKind }[];
  /**
   * Only for `alias` / `alias_method`: how the walker locates the redirect
   * target (the OLD method name) to emit a new→old call edge.
   */
  redirectTarget?: "second-symbol" | "alias-keyword-old";
}

const RUBY_DSL: Record<string, RubyDslEntry> = {
  // ── method-declaring macros (declares / redirect) ──
  attr_accessor:  { category: "accessor",       declares: b => [{ name: b, kind: "instance" }, { name: `${b}=`, kind: "instance" }] },
  attr_reader:    { category: "accessor",       declares: b => [{ name: b, kind: "instance" }] },
  attr_writer:    { category: "accessor",       declares: b => [{ name: `${b}=`, kind: "instance" }] },
  cattr_accessor: { category: "accessor",       declares: b => [{ name: b, kind: "static" }, { name: `${b}=`, kind: "static" }] },
  cattr_reader:   { category: "accessor",       declares: b => [{ name: b, kind: "static" }] },
  cattr_writer:   { category: "accessor",       declares: b => [{ name: `${b}=`, kind: "static" }] },
  mattr_accessor: { category: "accessor",       declares: b => [{ name: b, kind: "static" }, { name: `${b}=`, kind: "static" }] },
  mattr_reader:   { category: "accessor",       declares: b => [{ name: b, kind: "static" }] },
  mattr_writer:   { category: "accessor",       declares: b => [{ name: `${b}=`, kind: "static" }] },
  delegate:       { category: "delegation",     declares: b => [{ name: b, kind: "instance" }] },
  define_method:  { category: "dynamic-method", declares: b => [{ name: b, kind: "instance" }] },
  alias_method:   { category: "alias",          declares: b => [{ name: b, kind: "instance" }], redirectTarget: "second-symbol" },
  alias:          { category: "alias",          declares: b => [{ name: b, kind: "instance" }], redirectTarget: "alias-keyword-old" },

  // ── group-only Rails declaration keywords (category only) ──
  has_many: { category: "association" }, has_one: { category: "association" },
  belongs_to: { category: "association" }, has_and_belongs_to_many: { category: "association" },
  validates: { category: "validation" }, validate: { category: "validation" },
  validates_presence_of: { category: "validation" }, /* … the rest of validates_* */
  scope: { category: "scope" },
  before_save: { category: "callback" }, after_create: { category: "callback" },
  before_action: { category: "callback" }, /* … the rest of callbacks */
  include: { category: "include" }, extend: { category: "include" }, prepend: { category: "include" },
  attribute: { category: "accessor" }, class_attribute: { category: "accessor" },
  has_one_attached: { category: "accessor" }, has_many_attached: { category: "accessor" },
  accepts_nested_attributes_for: { category: "nested-attrs" },
  delegate_missing_to: { category: "delegation" },
  enum: { category: "enum" }, aasm: { category: "state-machine" },
  included: { category: "concern-hook" }, extended: { category: "concern-hook" }, class_methods: { category: "concern-hook" },
  serialize: { category: "other" }, store_accessor: { category: "other" },
};
```

`RUBY_DSL` is the entire shared declaration vocabulary. RSpec / FactoryBot
keywords are deliberately absent (see Non-Goals).

## Consumer Projections

Each consumer owns ONE small mapping that reads the shared catalogue. Nothing is
duplicated across consumers — each reads the facet it needs.

### 1. `class-body-chunker.ts` — `category → group` (thin projection)

```ts
const CATEGORY_TO_GROUP: Record<DslCategory, string> = {
  accessor: "attributes", delegation: "delegates",
  alias: "aliases",                    // NEW grouping (behaviour addition)
  "dynamic-method": "dynamic_methods", // NEW grouping (behaviour addition)
  association: "associations", validation: "validations", scope: "scopes",
  callback: "callbacks", include: "includes", enum: "enums",
  "state-machine": "state_machine", "concern-hook": "concern_hooks",
  "nested-attrs": "nested_attrs", other: "other",
};

// DECLARATION_KEYWORDS for non-RSpec class bodies is derived at module load:
//   keyword → CATEGORY_TO_GROUP[RUBY_DSL[keyword].category]
// The RSpec/FactoryBot grouping entries (let/subject/before/shared/factory/trait)
// — likely dead, see Non-Goals — are kept hardcoded in class-body-chunker as a
// separate set, NOT moved into the catalogue. (Their removal is a follow-up.)
```

`classifyLine` continues to look up a line's first identifier; the Rails subset
of its lookup table now comes from the catalogue.

**Behaviour change (intentional):** `alias`, `alias_method`, and `define_method`
lines were previously ungrouped (fell through to continuation). They now cluster
into `"aliases"` / `"dynamic_methods"` groups.

### 2. `ruby/walker/macros.ts` — `declares → synthetic symbols`

`extractRubyMacroSymbols` reads the catalogue instead of a local table:

- Recognise a macro by `RUBY_DSL[name]?.declares` being present.
- Extract base symbol arguments from the AST (this AST parsing — leading symbols
  until the first kwarg for `delegate`, literal symbol/string for
  `define_method`, first symbol for `alias_method`, alias-keyword new name —
  **stays in this consumer**; it differs per macro).
- For each parsed `base`: `entry.declares(base)` → `MacroSymbol[]`.

The local `RUBY_DSL_MACROS` constant and the per-macro arg-extraction helpers'
*table knowledge* are removed; the AST parsing helpers remain.

### 3. `ruby/walker/walker.ts` — `redirectTarget → redirect edge`

The hand-rolled `alias` (keyword) and `alias_method` (call) blocks become
catalogue-driven: when a matched keyword's entry has `redirectTarget`, the walker
extracts the old-method name by that strategy and emits the redirect `CallRef`.
The surrounding general call-edge walking (bare-id, super, send-unwrap,
block-pass, generic calls) is unchanged — it is not class-body DSL.

## What stays per-consumer (deliberately not unified)

- **AST argument extraction** — differs by consumer (synthesis extracts declared
  method names; walker extracts the redirect target). The catalogue hands an
  already-parsed `base` / a `redirectTarget` strategy, not the parsing.
- **Emission** — chunk grouping vs `MacroSymbol[]` vs `CallRef` are each the
  consumer's own output.
- **`category → group`** — the chunker's local policy (how it names groups), not
  an intrinsic fact; lives only in `class-body-chunker`.

## Migration Order (refactor-migration-test-order + TDD for the addition)

1. **Create `ruby/dsl/catalogue.ts`** + `ruby/dsl/index.ts` barrel, with the full
   vocabulary above. Add a direct unit test asserting each entry's
   `category` / `declares(base)` / `redirectTarget`.
2. **Re-target `ruby/walker/macros.ts`** (synthesis) and **`ruby/walker/walker.ts`**
   (redirect) to read the catalogue — **without touching their tests**. Existing
   macro-symbol and alias-redirect tests stay green (pure relocation).
3. **Re-target `class-body-chunker`** to derive its Rails `DECLARATION_KEYWORDS`
   from the catalogue via `CATEGORY_TO_GROUP`, keeping the RSpec/FactoryBot
   entries hardcoded as a separate set. Existing grouping tests for the Rails
   keywords stay green (identical keyword→group output).
4. **TDD the behaviour addition** — failing test first: `define_method` line →
   `"dynamic_methods"`, `alias` / `alias_method` line → `"aliases"`. Wire the
   `alias` + `dynamic-method` entries into `CATEGORY_TO_GROUP`, green. Update the
   few existing `class-body-chunker` assertions that expected those lines
   ungrouped — the business logic changed intentionally.
5. **Delete the local duplicates** — `RUBY_DSL_MACROS` from
   `ruby/walker/macros.ts`; the hardcoded Rails keyword→group entries from
   `class-body-chunker`'s `DECLARATION_KEYWORDS`.

## Testing

- **Catalogue (new entity):** direct table test — per entry, assert category,
  `declares(base)` output where present, `redirectTarget` where present.
- **Relocation consumers:** existing `ruby/walker/macros` (synthesis) and
  `ruby/walker/walker` (alias-redirect) tests remain unchanged and green — they
  are business-logic tests; relocation must not alter their examples.
- **class-body-chunker:** existing Rails grouping tests (attributes / delegates /
  associations / validations / scopes / callbacks / …) stay green; NEW tests
  assert `aliases` / `dynamic_methods` grouping; the few prior assertions
  expecting `define_method` / `alias` ungrouped are updated (intentional change).
- **Full gates:** `npx tsc --noEmit` = 0 · `npx eslint src/ --quiet` clean ·
  `npm run build` = 0 · `npx vitest run` full suite green · guard grep: zero
  cross-domain imports (everything within `domains/language/ruby/`).

## Risk (from tea-rags enrichment)

- The chunker **engine** `tree-sitter.ts` (hotspot, bugFixRate 32 "concerning")
  is **not touched** — it consumes the `macroSymbols` capability unchanged.
- `ruby/walker/walker.ts` is deep-silo; the change is a surgical replacement of
  the `alias` / `alias_method` blocks with catalogue-driven redirect emission.
  The deep-silo commit message carries a `Why:` line.
- The whole Ruby DSL surface is single-owner — the catalogue is written to **read
  as documentation** (the table IS the class-body DSL catalogue), the mitigation
  for the missing reviewer-pairing safety net.

## Affected Files

- **New:** `ruby/dsl/catalogue.ts`, `ruby/dsl/index.ts`,
  `tests/core/domains/language/ruby/dsl/catalogue.test.ts`.
- **Modified:** `ruby/walker/macros.ts` (read catalogue, drop `RUBY_DSL_MACROS`),
  `ruby/walker/walker.ts` (catalogue-driven redirect),
  `ruby/chunking/class-body-chunker.ts` (derive Rails `DECLARATION_KEYWORDS` from
  catalogue + `CATEGORY_TO_GROUP`, add alias/dynamic-method grouping, keep
  RSpec/FactoryBot entries as a separate hardcoded set), and the corresponding
  test files per the migration order.
- **Follow-up (separate):** verify & remove the likely-dead RSpec/FactoryBot
  entries from `class-body-chunker`'s `DECLARATION_KEYWORDS`.
