# Ruby DSL Catalogue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Centralise the Ruby/Rails class-body declaration DSL vocabulary into one declarative catalogue `ruby/dsl/catalogue.ts` that all three consumers (class-body-chunker grouping, walker macro-synthesis, walker alias-redirect) project from — eliminating the method-declaring-macro drift across the three files.

**Architecture:** A single `RUBY_DSL: Record<string, RubyDslEntry>` maps each keyword to its intrinsic `category` plus optional `declares` (method synthesis) and `redirectTarget` (alias edge) facets. `ruby/walker/macros.ts` reads `declares`; `ruby/walker/walker.ts` reads `redirectTarget`; `ruby/chunking/class-body-chunker.ts` derives its Rails `DECLARATION_KEYWORDS` via a local `CATEGORY_TO_GROUP` projection (and gains intentional `aliases` / `dynamic_methods` grouping). All imports are sibling imports within `domains/language/ruby/`.

**Tech Stack:** TypeScript, tree-sitter-ruby, vitest. Spec: `docs/superpowers/specs/2026-05-27-ruby-dsl-descriptor-design.md` (authoritative).

**Deep-silo note:** Every file here is single-owner (Arthur 100%, no reviewer-pairing). The catalogue MUST read as documentation. `ruby/walker/walker.ts` is deep-silo — its commit carries a `Why:` line. Each consumer relocation is behavior-PRESERVING; the existing macro/alias/grouping tests stay green (count-preservation rule: it/test/describe ≥ base).

**OVERLAP with `tea-rags-mcp-zz7d`:** The sibling follow-up zz7d (Ruby `singleton_class` macro emission — relax the `extractRubyMacroSymbols` class/module guard + static-kind semantics for `class << self`) ALSO edits `ruby/walker/macros.ts`. This plan is IN SCOPE for unifying the macro VOCABULARY only; it does NOT touch the `class`/`module` container guard at `macros.ts:98` and does NOT change synthesis behavior for singleton bodies. zz7d stays separate (it carries its own static/instance semantics decision). Whoever lands second rebases the `macros.ts` changes cleanly — they touch different regions (vocabulary lookup vs the container guard).

---

## File Structure

- **New** `src/core/domains/language/ruby/dsl/catalogue.ts` — `MethodKind`, `DslCategory`, `RubyDslEntry`, `RUBY_DSL`. The single declarative vocabulary.
- **New** `src/core/domains/language/ruby/dsl/index.ts` — barrel re-exporting the catalogue + types.
- **New** `tests/core/domains/language/ruby/dsl/catalogue.test.ts` — per-entry table test.
- **Modify** `src/core/domains/language/ruby/walker/macros.ts` — synthesis reads `RUBY_DSL[name].declares`; drop local `RUBY_DSL_MACROS`.
- **Modify** `src/core/domains/language/ruby/walker/walker.ts` — alias/alias_method redirect reads `RUBY_DSL[name].redirectTarget`.
- **Modify** `src/core/domains/language/ruby/chunking/class-body-chunker.ts` — `DECLARATION_KEYWORDS` (Rails subset) derived from catalogue via `CATEGORY_TO_GROUP`; RSpec/FactoryBot keywords kept as a separate hardcoded set; alias/dynamic-method grouping added.

---

## Task 1: The catalogue + unit test

**Files:**
- Create: `src/core/domains/language/ruby/dsl/catalogue.ts`
- Create: `src/core/domains/language/ruby/dsl/index.ts`
- Test: `tests/core/domains/language/ruby/dsl/catalogue.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/core/domains/language/ruby/dsl/catalogue.test.ts`:

```ts
import { describe, it, expect } from "vitest";

import { RUBY_DSL } from "../../../../../../src/core/domains/language/ruby/dsl/index.js";

describe("RUBY_DSL catalogue", () => {
  it("attr_accessor declares getter + setter (instance)", () => {
    const e = RUBY_DSL.attr_accessor;
    expect(e.category).toBe("accessor");
    expect(e.declares?.("foo")).toEqual([
      { name: "foo", kind: "instance" },
      { name: "foo=", kind: "instance" },
    ]);
  });

  it("cattr_accessor declares static getter + setter", () => {
    expect(RUBY_DSL.cattr_accessor.declares?.("x")).toEqual([
      { name: "x", kind: "static" },
      { name: "x=", kind: "static" },
    ]);
  });

  it("attr_reader / attr_writer declare a single accessor", () => {
    expect(RUBY_DSL.attr_reader.declares?.("a")).toEqual([{ name: "a", kind: "instance" }]);
    expect(RUBY_DSL.attr_writer.declares?.("a")).toEqual([{ name: "a=", kind: "instance" }]);
  });

  it("delegate declares one instance forwarder", () => {
    expect(RUBY_DSL.delegate.category).toBe("delegation");
    expect(RUBY_DSL.delegate.declares?.("name")).toEqual([{ name: "name", kind: "instance" }]);
  });

  it("define_method is a dynamic-method that declares one instance method", () => {
    expect(RUBY_DSL.define_method.category).toBe("dynamic-method");
    expect(RUBY_DSL.define_method.declares?.("run")).toEqual([{ name: "run", kind: "instance" }]);
  });

  it("alias_method is an alias with second-symbol redirect", () => {
    expect(RUBY_DSL.alias_method.category).toBe("alias");
    expect(RUBY_DSL.alias_method.declares?.("new_m")).toEqual([{ name: "new_m", kind: "instance" }]);
    expect(RUBY_DSL.alias_method.redirectTarget).toBe("second-symbol");
  });

  it("alias keyword is an alias with alias-keyword-old redirect", () => {
    expect(RUBY_DSL.alias.category).toBe("alias");
    expect(RUBY_DSL.alias.redirectTarget).toBe("alias-keyword-old");
  });

  it("group-only Rails keywords carry a category and NO declares/redirect", () => {
    for (const kw of ["has_many", "validates", "scope", "before_save", "include", "enum", "aasm", "included"]) {
      expect(RUBY_DSL[kw], kw).toBeDefined();
      expect(RUBY_DSL[kw].declares, kw).toBeUndefined();
      expect(RUBY_DSL[kw].redirectTarget, kw).toBeUndefined();
    }
    expect(RUBY_DSL.has_many.category).toBe("association");
    expect(RUBY_DSL.validates.category).toBe("validation");
    expect(RUBY_DSL.scope.category).toBe("scope");
    expect(RUBY_DSL.before_save.category).toBe("callback");
    expect(RUBY_DSL.accepts_nested_attributes_for.category).toBe("nested-attrs");
    expect(RUBY_DSL.aasm.category).toBe("state-machine");
    expect(RUBY_DSL.included.category).toBe("concern-hook");
  });

  it("group-only accessor keywords (attribute, attachments) have NO declares", () => {
    for (const kw of ["attribute", "class_attribute", "has_one_attached", "has_many_attached"]) {
      expect(RUBY_DSL[kw].category, kw).toBe("accessor");
      expect(RUBY_DSL[kw].declares, kw).toBeUndefined();
    }
  });

  it("excludes RSpec / FactoryBot keywords (separate testing DSL)", () => {
    for (const kw of ["let", "subject", "before", "describe", "context", "it", "factory", "trait", "shared_examples"]) {
      expect(RUBY_DSL[kw], kw).toBeUndefined();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/core/domains/language/ruby/dsl/catalogue.test.ts`
Expected: FAIL — `Cannot find module '.../ruby/dsl/index.js'`.

- [ ] **Step 3: Create `src/core/domains/language/ruby/dsl/catalogue.ts`**

```ts
/**
 * Ruby/Rails class-body declaration DSL catalogue — the SINGLE declarative
 * source of "this identifier is a class-body declaration of category X (and, if
 * method-declaring, synthesises these methods / redirects this alias)".
 *
 * THIS TABLE *IS* THE CATALOGUE — read it as documentation. Three consumers
 * project from it, each reading only the facet it needs (spec
 * `2026-05-27-ruby-dsl-descriptor-design.md`):
 *   - `ruby/chunking/class-body-chunker.ts` — `category` → chunk group (via its
 *     own `CATEGORY_TO_GROUP`; the group name is the chunker's policy, not an
 *     intrinsic fact, so it lives there not here).
 *   - `ruby/walker/macros.ts` — `declares(base)` → synthetic `MacroSymbol[]`.
 *   - `ruby/walker/walker.ts` — `redirectTarget` → alias redirect `CallRef`.
 *
 * Add a keyword ONCE here and every consumer derives its behaviour. RSpec /
 * FactoryBot testing-DSL keywords are deliberately ABSENT — they are chunked by
 * the separate `rspec-scope-chunker` and must not enter this Rails catalogue.
 * AST argument extraction (which symbols a macro call declares, where the alias
 * target is) stays in each consumer — the catalogue hands an already-parsed
 * `base` / a `redirectTarget` strategy, never the parsing.
 */

export type MethodKind = "instance" | "static";

export type DslCategory =
  // method-declaring macros (carry `declares`; alias also `redirectTarget`)
  | "accessor"
  | "delegation"
  | "alias"
  | "dynamic-method"
  // group-only Rails declaration keywords (no `declares`)
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

export interface RubyDslEntry {
  /** Intrinsic category. The ONLY thing group-only keywords carry. */
  category: DslCategory;
  /**
   * Synthetic methods declared, given an already-parsed base symbol name.
   * Present ONLY on method-declaring macros. The AST argument extraction that
   * produces `base` lives in the consumer matcher (`macros.ts`), not here.
   */
  declares?: (base: string) => { name: string; kind: MethodKind }[];
  /**
   * Only for `alias` / `alias_method`: how the walker locates the redirect
   * target (the OLD method name) to emit a new→old call edge.
   *   - `"second-symbol"`     → `alias_method :new, :old` (second positional symbol)
   *   - `"alias-keyword-old"` → `alias new old` (second identifier child)
   */
  redirectTarget?: "second-symbol" | "alias-keyword-old";
}

const accessorPair = (base: string, kind: MethodKind) => [
  { name: base, kind },
  { name: `${base}=`, kind },
];

export const RUBY_DSL: Record<string, RubyDslEntry> = {
  // ── method-declaring macros (declares / redirect) ──────────────────────────
  attr_accessor: { category: "accessor", declares: (b) => accessorPair(b, "instance") },
  attr_reader: { category: "accessor", declares: (b) => [{ name: b, kind: "instance" }] },
  attr_writer: { category: "accessor", declares: (b) => [{ name: `${b}=`, kind: "instance" }] },
  cattr_accessor: { category: "accessor", declares: (b) => accessorPair(b, "static") },
  cattr_reader: { category: "accessor", declares: (b) => [{ name: b, kind: "static" }] },
  cattr_writer: { category: "accessor", declares: (b) => [{ name: `${b}=`, kind: "static" }] },
  mattr_accessor: { category: "accessor", declares: (b) => accessorPair(b, "static") },
  mattr_reader: { category: "accessor", declares: (b) => [{ name: b, kind: "static" }] },
  mattr_writer: { category: "accessor", declares: (b) => [{ name: `${b}=`, kind: "static" }] },
  delegate: { category: "delegation", declares: (b) => [{ name: b, kind: "instance" }] },
  define_method: { category: "dynamic-method", declares: (b) => [{ name: b, kind: "instance" }] },
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

  // ── group-only accessor-family keywords (category only, NOT synthesised) ────
  attribute: { category: "accessor" },
  class_attribute: { category: "accessor" },
  has_one_attached: { category: "accessor" },
  has_many_attached: { category: "accessor" },

  // ── associations ────────────────────────────────────────────────────────────
  has_many: { category: "association" },
  has_one: { category: "association" },
  belongs_to: { category: "association" },
  has_and_belongs_to_many: { category: "association" },

  // ── validations ──────────────────────────────────────────────────────────────
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

  // ── scopes ────────────────────────────────────────────────────────────────────
  scope: { category: "scope" },

  // ── callbacks ─────────────────────────────────────────────────────────────────
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

  // ── includes / mixins ───────────────────────────────────────────────────────
  include: { category: "include" },
  extend: { category: "include" },
  prepend: { category: "include" },

  // ── nested attributes ──────────────────────────────────────────────────────
  accepts_nested_attributes_for: { category: "nested-attrs" },

  // ── delegation (group-only sibling of `delegate`) ────────────────────────────
  delegate_missing_to: { category: "delegation" },

  // ── enums / state machine / concern hooks / misc ────────────────────────────
  enum: { category: "enum" },
  aasm: { category: "state-machine" },
  included: { category: "concern-hook" },
  extended: { category: "concern-hook" },
  class_methods: { category: "concern-hook" },
  serialize: { category: "other" },
  store_accessor: { category: "other" },
};
```

- [ ] **Step 4: Create the barrel `src/core/domains/language/ruby/dsl/index.ts`**

```ts
export { RUBY_DSL } from "./catalogue.js";
export type { DslCategory, MethodKind, RubyDslEntry } from "./catalogue.js";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/core/domains/language/ruby/dsl/catalogue.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/domains/language/ruby/dsl/ tests/core/domains/language/ruby/dsl/catalogue.test.ts
git commit -m "feat(chunker): ruby/dsl catalogue — single class-body declaration vocabulary

RUBY_DSL maps each Ruby/Rails class-body keyword to its category + optional
declares (method synthesis) / redirectTarget (alias edge) facets. Not yet
consumed — consumers re-target in following tasks. RSpec/FactoryBot excluded.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `macros.ts` synthesis reads the catalogue

Behavior-preserving relocation: replace the local `RUBY_DSL_MACROS` table with
`RUBY_DSL[name].declares`. The per-macro AST argument extraction (delegate
leading symbols, alias_method first symbol, define_method literal, generic symbol
args, alias-keyword first identifier) STAYS — only the symbol-building table moves
to the catalogue.

**Files:**
- Modify: `src/core/domains/language/ruby/walker/macros.ts`
- Test: `tests/core/domains/language/ruby/walker/macros.test.ts` (existing — must stay green, do NOT edit)

> NOTE for the implementer: locate the existing macro test file first. It may be at `tests/core/domains/language/ruby/walker/macros.test.ts` or (pre-consolidation name) `tests/.../ruby-macros.test.ts`. Run it before AND after; assertions must not change.

- [ ] **Step 1: Run the existing macro tests to capture the green baseline**

Run: `npx vitest run` with the ruby macros test file path (find via `mcp__ripgrep__search` pattern `extractRubyMacroSymbols` in `tests/`). Record the pass count.

- [ ] **Step 2: Re-target `pushMacroSymbols` to the catalogue**

In `src/core/domains/language/ruby/walker/macros.ts`:

Add the import (sibling import within `domains/language/ruby/`):

```ts
import { RUBY_DSL } from "../dsl/index.js";
```

REMOVE the local `MacroBuilder` type and the entire `const RUBY_DSL_MACROS: Record<string, MacroBuilder> = { ... };` block.

In `pushMacroSymbols`, the generic builder lookup at the bottom currently reads:

```ts
  const builder = RUBY_DSL_MACROS[macroName];
  if (!builder) return;
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
  if (!args) return;
  for (const arg of args.namedChildren) {
    if (arg.type !== "simple_symbol") continue;
    const base = stripSymbolColon(arg.text);
    if (base.length === 0) continue;
    for (const m of builder(base)) {
      out.push({ name: m.name, kind: m.kind, startLine, endLine });
    }
  }
```

Replace with the catalogue-driven form (semantically identical for the
accessor-family macros, the only ones that reach this generic loop):

```ts
  const entry = RUBY_DSL[macroName];
  if (!entry?.declares) return;
  const args = node.childForFieldName("arguments") ?? node.children.find((c) => c.type === "argument_list");
  if (!args) return;
  for (const arg of args.namedChildren) {
    if (arg.type !== "simple_symbol") continue;
    const base = stripSymbolColon(arg.text);
    if (base.length === 0) continue;
    for (const m of entry.declares(base)) {
      out.push({ name: m.name, kind: m.kind, startLine, endLine });
    }
  }
```

The special-cased `delegate`, `alias_method`, `define_method` branches ABOVE this
loop are unchanged — they still parse their args their own way and push the
single resulting `{ name, kind: "instance" }`. (Their catalogue `declares` would
produce the same single symbol, but the early `return` in each branch keeps the
existing control flow; leave those branches as-is — behavior-preserving.)

- [ ] **Step 3: Run the macro tests — must stay GREEN at baseline count**

Run the same test file from Step 1.
Expected: PASS, same count. The accessor/cattr/mattr/delegate/define_method/alias macros emit identical `MacroSymbol[]` (the catalogue's `declares` builders are byte-equivalent to the removed `RUBY_DSL_MACROS` builders).

- [ ] **Step 4: tsc + commit**

Run: `npx tsc --noEmit` (clean).

```bash
git add src/core/domains/language/ruby/walker/macros.ts
git commit -m "refactor(chunker): ruby macro synthesis reads the dsl catalogue

extractRubyMacroSymbols recognises accessor-family macros via RUBY_DSL[name].declares
instead of the local RUBY_DSL_MACROS table (removed). Per-macro AST arg extraction
unchanged. Behavior-identical.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `walker.ts` alias redirect reads the catalogue

Behavior-preserving: the two hand-rolled redirect blocks consult
`RUBY_DSL[name].redirectTarget` to decide they are alias forms and which
extraction strategy to use. `ruby/walker/walker.ts` is DEEP-SILO — the commit
carries a `Why:` line.

**Files:**
- Modify: `src/core/domains/language/ruby/walker/walker.ts`
- Test: existing ruby-walker alias-redirect tests (must stay green, do NOT edit)

- [ ] **Step 1: Run the existing walker alias tests (baseline)**

Find via `mcp__ripgrep__search` pattern `alias_method / alias synthetic call edges` in `tests/` and run that file. Record the pass count.

- [ ] **Step 2: Re-target the `alias` keyword block**

In `src/core/domains/language/ruby/walker/walker.ts`, add the sibling import:

```ts
import { RUBY_DSL } from "../dsl/index.js";
```

The `alias` keyword block currently reads:

```ts
    if (node.type === "alias") {
      const idents = node.children.filter((c) => c.type === "identifier");
      const oldName = idents[1]?.text;
      if (oldName) {
        out.push({
          callText: node.text,
          receiver: null,
          member: oldName,
          startLine: node.startPosition.row + 1,
        });
      }
    }
```

Replace with the catalogue-gated form (same emission; the `alias-keyword-old`
strategy = second identifier child):

```ts
    if (node.type === "alias" && RUBY_DSL.alias?.redirectTarget === "alias-keyword-old") {
      const idents = node.children.filter((c) => c.type === "identifier");
      const oldName = idents[1]?.text;
      if (oldName) {
        out.push({
          callText: node.text,
          receiver: null,
          member: oldName,
          startLine: node.startPosition.row + 1,
        });
      }
    }
```

- [ ] **Step 3: Re-target the `alias_method` call block**

The `alias_method` call block currently reads:

```ts
      if (method.text === "alias_method" && receiverText === null) {
        const oldName = extractSecondLiteralSymbol(node);
        if (oldName !== null) {
          out.push({ callText: node.text, receiver: null, member: oldName, startLine });
        }
      }
```

Replace the guard with a catalogue check (same `second-symbol` extraction):

```ts
      if (receiverText === null && RUBY_DSL[method.text]?.redirectTarget === "second-symbol") {
        const oldName = extractSecondLiteralSymbol(node);
        if (oldName !== null) {
          out.push({ callText: node.text, receiver: null, member: oldName, startLine });
        }
      }
```

`extractSecondLiteralSymbol` is unchanged. (The only keyword with
`redirectTarget: "second-symbol"` is `alias_method`, so this is behavior-identical
— it fires for exactly the same call shape.)

- [ ] **Step 4: Run the walker alias tests — GREEN at baseline**

Run the file from Step 1. Expected: PASS, same count — redirect edges identical.

- [ ] **Step 5: tsc + commit (deep-silo → `Why:` line)**

Run: `npx tsc --noEmit` (clean).

```bash
git add src/core/domains/language/ruby/walker/walker.ts
git commit -m "refactor(chunker): ruby walker alias redirect reads the dsl catalogue

The alias-keyword and alias_method redirect blocks gate on
RUBY_DSL[name].redirectTarget instead of hardcoded keyword strings. Extraction
helpers (idents[1], extractSecondLiteralSymbol) unchanged. Behavior-identical.

Why: ruby/walker/walker.ts is deep-silo (single-owner, no reviewer pairing). The
change is a surgical gate-swap on the two existing alias blocks — same CallRef
emission, now sourced from the one shared catalogue so the alias vocabulary can't
drift from macros.ts / class-body-chunker. Trade-off: a catalogue lookup per alias
node, negligible vs the AST walk already happening.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `class-body-chunker` derives from catalogue + adds alias/dynamic grouping (TDD)

Derive the Rails `DECLARATION_KEYWORDS` from the catalogue via a local
`CATEGORY_TO_GROUP`, keep the RSpec/FactoryBot keywords as a separate hardcoded
set, and (intentional behavior addition) gain `aliases` / `dynamic_methods`
grouping for `alias` / `alias_method` / `define_method` lines.

**Files:**
- Modify: `src/core/domains/language/ruby/chunking/class-body-chunker.ts`
- Test: existing `tests/.../class-body-chunker` (or `tree-sitter-chunker`) grouping tests + NEW alias/dynamic-method tests

- [ ] **Step 1: Find + run the existing grouping tests (baseline)**

Find the class-body grouping tests via `mcp__ripgrep__search` pattern `classifyLine|groupLines|associations` in `tests/core/domains/language/ruby` and `tests/core/domains/ingest/pipeline/chunker`. Run them; record the pass count and note which file asserts `classifyLine` group outputs.

- [ ] **Step 2: Write the failing tests for the NEW grouping (TDD)**

Add to the class-body-chunker grouping test file (matching its existing `classifyLine` test style):

```ts
  it("groups alias and alias_method lines into 'aliases'", () => {
    const chunker = new RubyClassBodyChunker();
    expect(chunker.classifyLine("alias new_name old_name")).toBe("aliases");
    expect(chunker.classifyLine("alias_method :new_name, :old_name")).toBe("aliases");
  });

  it("groups define_method lines into 'dynamic_methods'", () => {
    const chunker = new RubyClassBodyChunker();
    expect(chunker.classifyLine("define_method(:foo) { 1 }")).toBe("dynamic_methods");
  });
```

(If the test file constructs `RubyClassBodyChunker` differently or tests through `groupLines`/`extractBodyChunks`, match that style — the assertion is that an `alias`/`alias_method` line lands in an `aliases` group and a `define_method` line in a `dynamic_methods` group.)

- [ ] **Step 3: Run them to verify they fail**

Run the grouping test file.
Expected: FAIL — `classifyLine` returns `undefined` (today these keywords aren't in `DECLARATION_KEYWORDS`).

- [ ] **Step 4: Derive `DECLARATION_KEYWORDS` from the catalogue**

In `src/core/domains/language/ruby/chunking/class-body-chunker.ts`:

Add the import:

```ts
import { RUBY_DSL, type DslCategory } from "../dsl/index.js";
```

Replace the entire hand-written `const DECLARATION_KEYWORDS: Record<string, string> = { ... };` block (the ~50-entry literal) with the catalogue derivation + the retained RSpec/FactoryBot set:

```ts
/**
 * Chunk group name per DSL category — the chunker's LOCAL policy (how it names
 * groups), not an intrinsic catalogue fact. `alias` → "aliases" and
 * `dynamic-method` → "dynamic_methods" are NEW groupings (previously these lines
 * fell through to continuation).
 */
const CATEGORY_TO_GROUP: Record<DslCategory, string> = {
  accessor: "attributes",
  delegation: "delegates",
  alias: "aliases",
  "dynamic-method": "dynamic_methods",
  association: "associations",
  validation: "validations",
  scope: "scopes",
  callback: "callbacks",
  include: "includes",
  enum: "enums",
  "state-machine": "state_machine",
  "concern-hook": "concern_hooks",
  "nested-attrs": "nested_attrs",
  other: "other",
};

/**
 * RSpec / FactoryBot testing-DSL keywords. These are NOT in the Rails catalogue
 * (`ruby/dsl/catalogue.ts`) — they belong to the separate testing DSL handled by
 * `rspec-scope-chunker`. Kept hardcoded here as a distinct set; their grouping
 * is likely dead (spec/factory files route through rspec-scope-chunker with
 * skipChildren=true). Removal is a separate follow-up (see the spec Non-Goals).
 */
const RSPEC_FACTORY_KEYWORDS: Record<string, string> = {
  let: "setup",
  subject: "setup",
  before: "hooks",
  after: "hooks",
  around: "hooks",
  shared_examples: "shared",
  shared_context: "shared",
  include_examples: "shared",
  it_behaves_like: "shared",
  include_context: "shared",
  factory: "factory",
  trait: "factory",
};

/**
 * First identifier on a line → chunk group type. The Rails subset is DERIVED
 * from the shared `RUBY_DSL` catalogue via `CATEGORY_TO_GROUP`; the testing-DSL
 * subset is the hardcoded `RSPEC_FACTORY_KEYWORDS` set above.
 */
const DECLARATION_KEYWORDS: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(RUBY_DSL).map(([keyword, entry]) => [keyword, CATEGORY_TO_GROUP[entry.category]]),
  ),
  ...RSPEC_FACTORY_KEYWORDS,
};
```

`classifyLine`, `groupLines`, and everything else are unchanged — they still read
`DECLARATION_KEYWORDS`.

- [ ] **Step 5: Run the NEW tests — verify they pass**

Run the grouping test file (the two new tests).
Expected: PASS — `alias`/`alias_method` → "aliases", `define_method` → "dynamic_methods".

- [ ] **Step 6: Run the FULL ruby grouping + chunker + codegraph suites; fix intentional-change assertions only**

Run: `npx vitest run tests/core/domains/language/ruby tests/core/domains/ingest/pipeline/chunker tests/core/domains/trajectory/codegraph`
Expected: all Rails keyword→group assertions stay green (the derivation reproduces the exact prior group for every Rails keyword — verify: associations/validations/scopes/callbacks/includes/attributes/delegates/enums/state_machine/concern_hooks/nested_attrs/other unchanged). 

IF a small number of EXISTING assertions fail because they asserted `define_method` / `alias` / `alias_method` lines were UNGROUPED (returned `undefined` or fell into a different group / continuation) — those are the intentional behavior change. Update ONLY those specific assertions to expect the new `aliases` / `dynamic_methods` grouping. Do NOT touch any other assertion. If a failure is NOT explainable by the alias/dynamic-method addition, STOP and report — it means the Rails derivation drifted.

- [ ] **Step 7: tsc + eslint + commit**

Run: `npx tsc --noEmit` (clean) and `npx eslint src/core/domains/language/ruby/chunking/class-body-chunker.ts` (clean).

```bash
git add src/core/domains/language/ruby/chunking/class-body-chunker.ts <the grouping test file>
git commit -m "feat(chunker): class-body-chunker derives groups from the dsl catalogue

Rails DECLARATION_KEYWORDS is now derived from RUBY_DSL via CATEGORY_TO_GROUP
(the ~50-entry hardcoded literal removed); RSpec/FactoryBot keywords kept as a
separate set. Intentional addition: alias / alias_method / define_method lines
now cluster into 'aliases' / 'dynamic_methods' groups (previously ungrouped).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Final verification + close beads

**Files:** none (verification only)

- [ ] **Step 1: Confirm no duplicate vocabulary remains**

Run `mcp__ripgrep__search`:
- pattern `RUBY_DSL_MACROS` across `src/` → expect ZERO (removed in Task 2).
- In `class-body-chunker.ts`: confirm the only keyword tables are `CATEGORY_TO_GROUP`, `RSPEC_FACTORY_KEYWORDS`, and the derived `DECLARATION_KEYWORDS` — no hand-written Rails keyword→group literal remains.
- Confirm `macros.ts`, `walker.ts`, `class-body-chunker.ts` all import `RUBY_DSL` from `../dsl/index.js` (sibling import within `domains/language/ruby/`).

- [ ] **Step 2: Full gates**

Run: `npx tsc --noEmit && npx eslint src --quiet && npm run build && npx vitest run`
Expected: tsc 0, eslint clean, build 0, full suite green. (If a pre-commit coverage hook fails, delegate to the `coverage-expander` subagent per `.claude/CLAUDE.md` — never lower thresholds.)

- [ ] **Step 3: Count-preservation check (domains-language rule)**

Confirm `it`/`test`/`describe` counts in the ruby walker (macros + alias-redirect) and class-body grouping test files are ≥ the base branch — every macro/alias corner case preserved (Tasks 2 & 3 added zero, Task 1 added the catalogue test, Task 4 added the two grouping tests + updated only the intentional-change assertions).

- [ ] **Step 4: Guard grep (no cross-domain imports)**

Run `mcp__ripgrep__search` pattern `from "(\.\./)*(domains/ingest|domains/trajectory)` in `src/core/domains/language/ruby/dsl/` → expect ZERO (the catalogue and its consumers stay within `domains/language/ruby/`).

- [ ] **Step 5: Close beads**

```bash
bd close tea-rags-mcp-4hd2 --reason "ruby/dsl catalogue created; macros.ts (declares), walker.ts (redirectTarget), class-body-chunker (category->group) all project from it; RUBY_DSL_MACROS + hardcoded Rails keyword literal removed; alias/dynamic_methods grouping added (TDD). RSpec/FactoryBot kept separate; singleton_class (zz7d) left untouched."
```

---

## Self-Review

**Spec coverage:**
- Catalogue (`RUBY_DSL` + `DslCategory` + `RubyDslEntry` + `declares`/`redirectTarget`) → Task 1. ✓ Full vocabulary enumerated from the real `RUBY_DSL_MACROS` + `DECLARATION_KEYWORDS` (no `/* … */` placeholders — every validates_*/callback expanded).
- macros.ts reads `declares` → Task 2. ✓
- walker.ts reads `redirectTarget` → Task 3. ✓
- class-body-chunker `category → group` + alias/dynamic-method grouping addition → Task 4. ✓
- Delete duplicates (RUBY_DSL_MACROS, hardcoded Rails literal) → inline in Tasks 2 & 4; verified Task 5. ✓
- RSpec/FactoryBot kept separate (not in catalogue) → Task 4 `RSPEC_FACTORY_KEYWORDS`. ✓
- zz7d singleton_class NOT touched → stated in header; Task 2 leaves the `macros.ts:98` class/module guard alone. ✓
- Migration order (catalogue → relocate consumers green → TDD addition → delete) → Tasks 1-5 follow it. ✓

**Placeholder scan:** none — full catalogue code, exact before/after edits, real test code.

**Type consistency:** `RubyDslEntry.declares` returns `{ name: string; kind: MethodKind }[]` (Task 1) consumed identically in Task 2 (`entry.declares(base)` → `MacroSymbol` push). `DslCategory` (Task 1) keys `CATEGORY_TO_GROUP` exhaustively in Task 4. `redirectTarget` union values (`"second-symbol"` / `"alias-keyword-old"`) match Task 3's gate checks. `RUBY_DSL` import path `../dsl/index.js` consistent across all three consumers.
