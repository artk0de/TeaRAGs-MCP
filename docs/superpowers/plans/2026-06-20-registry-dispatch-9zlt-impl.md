# Registry-Literal Dispatch (`CONST[k].new.m`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> dinopowers:test-driven-development per task (RED→GREEN), then
> dinopowers:executing-plans / dinopowers:verification-before-completion to land
> the combined commit. Steps use checkbox (`- [ ]`) syntax for tracking. Do NOT
> use the raw superpowers variants — the dinopowers wrappers run tea-rags
> enrichment first.

**Goal:** Resolve Ruby registry-dispatch call sites
`CONST[runtime_key].new.perform` (where `CONST` is a frozen hash/array constant
mapping keys → value-classes) into method edges that fan out to each value
class's `#perform`.

**Architecture:** Reuse the existing language-agnostic `dispatchTables` infra
(bd n0zj) — NOT the parallel `registryTables` the bead prescribed. The contract
(`DispatchTable`/`DispatchRef`/`DispatchTableDef`/`CallContext.dispatchTables`)
and the provider's run-global aggregation + threading are already
language-neutral. Only two Ruby-specific layers are added: (1) the walker builds
a `DispatchTable` per frozen registry constant and tags `CONST[k].new.m` sites
with a `DispatchRef`; (2) a new `RubyTableDispatchResolver` (a
`DispatchResolverComponent`) fans the ref out by resolving each value-class
FQ-name's `#field` method. Edge provenance is a new `MethodEdgeKind` member
`"registry"`.

**Tech Stack:** TypeScript, tree-sitter-ruby AST, Vitest. No new deps.

## Global Constraints

- **Reuse `dispatchTables` — 0 new contract fields.** Only a `MethodEdgeKind`
  member and a doc-comment extension on `DispatchTable`.
- **Provider: 0 changes.** `runDispatchTables` already aggregates
  `FileExtraction.dispatchTables` (dedup by relPath) and threads the run-global
  map into `CallContext.dispatchTables` (provider.ts:1623); the resolveDispatch
  loop already threads `edgeKind`/`confidence` per bd 2jet-C.
- **TDD RED→GREEN per task; NO intermediate commits.** All three layers land in
  ONE combined commit (Task 4) to avoid the lint-staged partial-state
  coverage-gate trap (lint-staged stashes unstaged files and runs aggregate
  coverage on the staged-only tree).
- **Additive only on the 226-LOC `collectRubyCalls`** — silo-owned (Korochansky
  87%), churning (12d). No rewrite of existing branches; add one `dispatch` tag
  path. Lean on the existing `ruby-walker.test.ts` registry/dispatch corpus as
  the regression guard.
- **m46z safety (never guess):** non-constant registry values dropped; ambiguous
  table name (same `CONST` in >1 file, no in-file decl) dropped; unresolvable
  class / method dropped. A wrong edge is worse than a missing edge.
- **Typed errors / no `throw new Error`** — not applicable here (pure
  walker/resolver data paths, no error surface added).
- **Quality gates:** `tsc=0`, `eslint=0` (no `eslint-disable`), `vitest` full
  green. Existing ruby cone/dynamic dispatch tests MUST stay green (precedence
  regression guard). Do NOT lower coverage thresholds.
- **Commit message** ends with
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Scope `trajectory`
  (or `signals`), conventional-commit header ≤100 chars.
  `contracts/types/codegraph.ts` is NOT a deep-silo file (per
  `.claude/rules/silo-pairing.md` list) → no mandatory `Why:` line, but include
  one anyway documenting the reuse-over-duplicate decision.

---

## File Structure

| File                                                                        | Responsibility                  | Change                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/contracts/types/codegraph.ts`                                     | Shared codegraph types          | Add `"registry"` to `MethodEdgeKind`; extend `DispatchTable` doc comment (string-arm = fn name TS / class FQ-name Ruby). 0 new fields.                                                                                 |
| `src/core/domains/language/ruby/walker/walker.ts`                           | Ruby AST → `FileExtraction`     | Add `collectRubyDispatchTables(root)` + key/entry helpers; thread `dispatchTableNames` gate set into `collectRubyCalls`; add `exprToRubyDispatchRef` dispatch-site tagging; emit `dispatchTables` on `FileExtraction`. |
| `src/core/domains/language/ruby/resolver/strategies/ruby-table-dispatch.ts` | NEW — registry fan-out resolver | `RubyTableDispatchResolver implements DispatchResolverComponent`.                                                                                                                                                      |
| `src/core/domains/language/ruby/resolver/strategies/index.ts`               | strategies barrel               | Export `RubyTableDispatchResolver`.                                                                                                                                                                                    |
| `src/core/domains/language/ruby/resolver/ruby-resolver.ts`                  | `RubyCallResolver`              | Construct `this.table`; wire precedence table→cone→dynamic in `resolveDispatch`.                                                                                                                                       |
| `tests/.../ruby/walker/ruby-walker.test.ts`                                 | walker tests                    | Add `dispatchTables` + dispatch-site-tagging describe.                                                                                                                                                                 |
| `tests/.../ruby/resolver/strategies/ruby-table-dispatch.test.ts`            | NEW — resolver tests            | Fan-out + edge-kind + precedence-isolation cases.                                                                                                                                                                      |

---

### Task 1: Contract — `MethodEdgeKind += "registry"` + `DispatchTable` doc

**Files:**

- Modify: `src/core/contracts/types/codegraph.ts:865` (`MethodEdgeKind`),
  `:25-38` (`DispatchTable` doc + interface)
- Test: `tests/core/contracts/types/codegraph-method-edge-kind.test.ts` (Create)

**Interfaces:**

- Produces:
  `MethodEdgeKind = "exact" | "cone" | "poly-base" | "dynamic" | "registry"`.
  Task 3 emits `"registry"`.

`contracts/` has no Zod and no runtime — a type union cannot be asserted at
runtime directly. The RED test is a **type-level** assertion compiled by
`tsc`/vitest: a `satisfies` check that `"registry"` is assignable to
`MethodEdgeKind`. This fails to compile until the member is added.

- [ ] **Step 1: Write the failing test**

```typescript
// tests/core/contracts/types/codegraph-method-edge-kind.test.ts
import { describe, expect, it } from "vitest";

import type { MethodEdgeKind } from "../../../../../src/core/contracts/types/codegraph.js";

describe("MethodEdgeKind (bd tea-rags-mcp-pq02v registry dispatch)", () => {
  it("admits the 'registry' provenance for registry-literal fan-out edges", () => {
    const kind = "registry" satisfies MethodEdgeKind;
    expect(kind).toBe("registry");
  });

  it("still admits the pre-existing kinds (no regression)", () => {
    const kinds = [
      "exact",
      "cone",
      "poly-base",
      "dynamic",
    ] satisfies MethodEdgeKind[];
    expect(kinds).toHaveLength(4);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/contracts/types/codegraph-method-edge-kind.test.ts`
Expected: FAIL — `tsc` error
`Type '"registry"' does not satisfy the expected type 'MethodEdgeKind'` (vitest
reports a transform/type error, the test does not pass).

- [ ] **Step 3: Add the member + extend the docs**

Edit `MethodEdgeKind` (codegraph.ts:850-865) — add the union member and a doc
bullet:

```typescript
 * - `dynamic`   — dynamic-receiver short-name fan-out (bd tea-rags-mcp-wbj3): a
 *                 receiver with no static type (`arr.map`, `obj[k].call`) that
 *                 would otherwise drop is resolved by short-name lookup with a
 *                 confidence discount (`< 1`). Distinguishable from `cone` (which
 *                 has a static base type) so ranking can discount name-only edges.
 * - `registry`  — registry-literal dispatch fan-out (bd tea-rags-mcp-pq02v): a
 *                 `CONST[key].new.m` site whose `CONST` is a frozen hash/array of
 *                 value-classes. The candidate set is STATICALLY COMPLETE (every
 *                 value class is known from the literal) but the runtime key picks
 *                 one — distinct from `cone` (CHA descendants, possibly partial
 *                 across compilation units) and from `dynamic` (no type evidence).
 *                 `confidence = 1/N` over the N value classes; a static literal key
 *                 narrows to one entry and is emitted as `exact`/1.0 instead.
 */
export type MethodEdgeKind = "exact" | "cone" | "poly-base" | "dynamic" | "registry";
```

Extend the `DispatchTable` doc comment (codegraph.ts:25-35) — append the Ruby
class-entry overload note:

```typescript
/**
 * A const dispatch table defined in one file (bd tea-rags-mcp-n0zj).
 * `entries` preserves the source key→value mapping so a static
 * string-literal key (`TABLE["ts"]`) resolves to the ONE matching entry
 * while a dynamic key (`TABLE[ext]`) fans out to ALL of them. The value
 * is either a function name (S2 direct-function map `{ k: fn }`) or a
 * `fieldName → fnName` map (S1 wrapper-object map `{ k: { field: fn } }`).
 * Only entries / fields whose value is a plain identifier are recorded —
 * inline arrows, spreads, and computed values carry no symbol to point at
 * and are dropped (m46z safety rule).
 *
 * Ruby registry overload (bd tea-rags-mcp-pq02v): for a frozen registry
 * constant (`CONST = { "k" => A::B::Klass }.freeze`) the string-arm entry
 * value is a CLASS fully-qualified name (not a function name), and the
 * dispatched member comes from the call site's `DispatchRef.field`
 * (`CONST[k].new.perform` → `field: "perform"`), NOT from the entry. The
 * resolver interprets the entry per language (it is language-scoped), so the
 * overload is type-safe without a shape change.
 */
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/contracts/types/codegraph-method-edge-kind.test.ts`
Expected: PASS (2 passing).

- [ ] **Step 5: DO NOT COMMIT.** Proceed to Task 2 (combined commit lands in
      Task 4).

---

### Task 2: Ruby walker — dispatch tables + dispatch-site tagging

**Files:**

- Modify: `src/core/domains/language/ruby/walker/walker.ts` — add helpers (after
  `collectRegistryConstantValueRefs`, ~line 620); change `extractFromRubyFile`
  (82-132) to build + emit `dispatchTables`; change `collectRubyCalls` (555-781)
  signature + add dispatch tag.
- Test: `tests/core/domains/language/ruby/walker/ruby-walker.test.ts` (Modify —
  add a describe block; preserve all existing `it`/`describe`).

**Interfaces:**

- Consumes: `DispatchTable`, `DispatchRef` from `contracts/types/codegraph.js`
  (already imported by walker.ts).
- Produces:
  - `collectRubyDispatchTables(root: Parser.SyntaxNode): Record<string, DispatchTable>`
    — keyed by LHS `CONST` name.
  - `collectRubyCalls(root: Parser.SyntaxNode, dispatchTableNames: ReadonlySet<string>): CallRef[]`
    — second param NEW.
  - `FileExtraction.dispatchTables` populated for files with ≥1 registry
    constant.
  - Dispatch sites carry `CallRef.dispatch = { table, field, key }`.

#### AST shapes (tree-sitter-ruby)

- `CONST = { "k" => A::B::C }.freeze` → `assignment` { left:
  `constant`/`scope_resolution`, right: `call` (`.freeze`) → receiver `hash` }.
  `hash` children are `pair` { key, value }.
- `CONST = [A, B].freeze` → right unwraps to `array`; elements are
  `constant`/`scope_resolution`.
- `TEMPLATE_CLONE_KLASSES[key].new.perform` → `call`{ method: `perform`,
  receiver: `call`{ method: `new`, receiver: `element_reference`{ object:
  `constant` `TEMPLATE_CLONE_KLASSES`, child index `[key]` } } }.

- [ ] **Step 1: Write the failing tests**

Add to `tests/core/domains/language/ruby/walker/ruby-walker.test.ts` (mirror the
existing ki9v registry describe's parse harness — `new Parser()` +
`tree-sitter-ruby`,
`extractFromRubyFile({ tree, code, relPath, language: "ruby", chunks: [] })`):

```typescript
describe("extractFromRubyFile — registry dispatch tables (bd tea-rags-mcp-pq02v)", () => {
  const parse = (code: string) => {
    const parser = new Parser();
    parser.setLanguage(Ruby);
    return parser.parse(code);
  };
  const extract = (code: string, relPath = "app/services/clone.rb") =>
    extractFromRubyFile({
      tree: parse(code),
      code,
      relPath,
      language: "ruby",
      chunks: [],
    });

  it("builds a DispatchTable keyed by the LHS constant name for a frozen hash", () => {
    const code = [
      "TEMPLATE_CLONE_KLASSES = {",
      "  'JobTemplate' => Workflow::Templates::Job::Clone,",
      "  'PipelineTemplate' => Workflow::Templates::Pipeline::Clone,",
      "}.freeze",
    ].join("\n");
    const out = extract(code);
    expect(out.dispatchTables).toEqual({
      TEMPLATE_CLONE_KLASSES: {
        entries: {
          JobTemplate: "Workflow::Templates::Job::Clone",
          PipelineTemplate: "Workflow::Templates::Pipeline::Clone",
        },
      },
    });
  });

  it("builds positional entries for a frozen array registry", () => {
    const code = "HANDLERS = [Alpha::Handler, Beta::Handler].freeze";
    const out = extract(code);
    expect(out.dispatchTables).toEqual({
      HANDLERS: { entries: { "0": "Alpha::Handler", "1": "Beta::Handler" } },
    });
  });

  it("omits a table whose entries are all non-constant (no symbol to point at)", () => {
    const code = "CALLBACKS = { a: -> { 1 }, b: ->(x) { x } }.freeze";
    const out = extract(code);
    expect(out.dispatchTables).toBeUndefined();
  });

  it("tags a dynamic-key dispatch site CONST[k].new.m with a DispatchRef (key null)", () => {
    const code = [
      "TCK = { 'JobTemplate' => Jobs::Clone }.freeze",
      "class Runner",
      "  def call(key)",
      "    TCK[key].new.perform",
      "  end",
      "end",
    ].join("\n");
    const out = extract(code);
    const dispatched = out.chunks
      .flatMap((c) => c.calls)
      .filter((c) => c.dispatch);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].dispatch).toEqual({
      table: "TCK",
      field: "perform",
      key: null,
    });
  });

  it("tags a static-key dispatch site CONST['k'].new.m with the literal key", () => {
    const code = [
      "TCK = { 'JobTemplate' => Jobs::Clone }.freeze",
      "class Runner",
      "  def call",
      "    TCK['JobTemplate'].new.perform",
      "  end",
      "end",
    ].join("\n");
    const out = extract(code);
    const dispatched = out.chunks
      .flatMap((c) => c.calls)
      .filter((c) => c.dispatch);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].dispatch).toEqual({
      table: "TCK",
      field: "perform",
      key: "JobTemplate",
    });
  });

  it("does NOT tag a plain local-array index call arr[i].m (object not a table constant)", () => {
    const code = [
      "class Runner",
      "  def call(arr, i)",
      "    arr[i].new.perform",
      "  end",
      "end",
    ].join("\n");
    const out = extract(code);
    expect(
      out.chunks.flatMap((c) => c.calls).filter((c) => c.dispatch),
    ).toHaveLength(0);
  });

  it("preserves the ki9v chunk-reference edges to value classes (additive, not replaced)", () => {
    const code = "TCK = { 'JobTemplate' => Jobs::Clone }.freeze";
    const out = extract(code);
    const refs = out.chunks
      .flatMap((c) => c.calls)
      .filter((c) => c.member === "Jobs::Clone");
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/ruby-walker.test.ts -t "registry dispatch tables"`
Expected: FAIL — `out.dispatchTables` is `undefined` and no `call.dispatch` is
set (the new code does not exist yet). The "preserves ki9v" case may already
pass (chunk-refs predate this) — that is fine, it is the regression guard.

- [ ] **Step 3: Add walker helpers**

Add after `collectRegistryConstantValueRefs` (~line 620). Shared key
normalization so the build side and the call-site side produce identical key
strings:

```typescript
/**
 * Normalize a Ruby hash key node to the string used in `DispatchTable.entries`
 * keys AND in `DispatchRef.key` (bd tea-rags-mcp-pq02v). String literal →
 * inner text without quotes; symbol (`:k` / `k:` hash-key sugar) → bare name.
 * Returns null for a non-literal / computed key (the entry is then unkeyed and
 * its constant value is dropped — m46z, never guess a runtime key).
 */
function rubyDispatchKeyText(node: Parser.SyntaxNode | null): string | null {
  if (!node) return null;
  if (node.type === "string") {
    const inner = node.namedChildren.find((c) => c.type === "string_content");
    return inner ? inner.text : node.text.replace(/^['"`]|['"`]$/g, "");
  }
  if (node.type === "simple_symbol") return node.text.replace(/^:/, "");
  if (node.type === "hash_key_symbol") return node.text; // `k:` sugar → bare `k`
  return null;
}

/**
 * Extract a class FQ-name from a registry VALUE node (bd tea-rags-mcp-pq02v).
 * `scope_resolution` → full `A::B::C` via readScopeResolution; bare `constant`
 * → its text. Anything else (lambda, call, nested literal) → null (dropped).
 */
function rubyDispatchValueConstant(
  node: Parser.SyntaxNode | null,
): string | null {
  if (!node) return null;
  if (node.type === "scope_resolution")
    return readScopeResolution(node) || null;
  if (node.type === "constant") return node.text;
  return null;
}

/**
 * Build the per-constant dispatch tables for registry-literal dispatch
 * (bd tea-rags-mcp-pq02v). Mirrors the TS `collectDispatchTables` shape but for
 * Ruby `CONST = <hash|array>.freeze` assignments. Entry values are class
 * FQ-names (see DispatchTable doc overload). A hash key uses its literal text; an
 * array element uses its positional index. Tables with zero constant-valued
 * entries are omitted. Shares the assignment/literal detection with
 * `collectRegistryConstantValueRefs` (which keeps emitting the chunk-ref edges).
 */
function collectRubyDispatchTables(
  root: Parser.SyntaxNode,
): Record<string, DispatchTable> {
  const out: Record<string, DispatchTable> = {};
  walk(root, (node) => {
    if (node.type !== "assignment") return;
    const left = node.childForFieldName("left");
    if (!left || (left.type !== "constant" && left.type !== "scope_resolution"))
      return;
    const name =
      left.type === "scope_resolution" ? readScopeResolution(left) : left.text;
    const literal = unwrapTrailingCalls(node.childForFieldName("right"));
    if (!literal) return;
    const entries: Record<string, string> = {};
    if (literal.type === "hash") {
      for (const pair of literal.namedChildren) {
        if (pair.type !== "pair") continue;
        const key = rubyDispatchKeyText(pair.childForFieldName("key"));
        const value = rubyDispatchValueConstant(
          pair.childForFieldName("value"),
        );
        if (key !== null && value !== null) entries[key] = value;
      }
    } else if (literal.type === "array") {
      let i = 0;
      for (const el of literal.namedChildren) {
        const value = rubyDispatchValueConstant(el);
        if (value !== null) entries[String(i)] = value;
        i++;
      }
    } else {
      return;
    }
    if (Object.keys(entries).length > 0) out[name] = { entries };
  });
  return out;
}

/**
 * Abstract-interpret a Ruby callee chain to its dispatch reference
 * (bd tea-rags-mcp-pq02v). Composes through `element_reference` (the table
 * subscript), the `.new` instantiation (pass-through), and the outer `.member`
 * call (the dispatched method). Returns null when the chain is not rooted at a
 * known dispatch-table constant.
 *
 *   CONST            → (not a ref on its own)
 *   CONST[k]         → { table: CONST, field: null, key: staticKeyOf }
 *   CONST[k].new     → same ref, field stays null (Kernel#new pass-through)
 *   CONST[k].new.m   → { table: CONST, field: "m", key }
 */
function exprToRubyDispatchRef(
  node: Parser.SyntaxNode,
  tableNames: ReadonlySet<string>,
): DispatchRef | null {
  if (node.type === "element_reference") {
    const obj = node.childForFieldName("object") ?? node.namedChildren[0];
    if (!obj) return null;
    const objName =
      obj.type === "scope_resolution"
        ? readScopeResolution(obj)
        : obj.type === "constant"
          ? obj.text
          : null;
    if (objName === null || !tableNames.has(objName)) return null;
    // The subscript index is the named child after the object.
    const index = node.namedChildren[1] ?? null;
    return { table: objName, field: null, key: rubyDispatchKeyText(index) };
  }
  if (node.type === "call" || node.type === "method_call") {
    const receiver = node.childForFieldName("receiver");
    const method = node.childForFieldName("method");
    if (!receiver || !method) return null;
    const inner = exprToRubyDispatchRef(receiver, tableNames);
    if (!inner) return null;
    // `.new` on a table-bound chain is a pass-through (instantiation, no edge).
    if (method.text === "new" && inner.field === null) return inner;
    // Outer `.member` on an entry-ref (field still null) → select the member.
    if (inner.field === null)
      return { table: inner.table, field: method.text, key: inner.key };
  }
  return null;
}
```

- [ ] **Step 4: Thread the gate set + emit the tables in `extractFromRubyFile`**

In `extractFromRubyFile` (walker.ts:82-132), change the `collectRubyCalls` call
and add the emit. Targeted edits only:

```typescript
const dispatchTables = collectRubyDispatchTables(input.tree.rootNode);
const dispatchTableNames = new Set(Object.keys(dispatchTables));
const calls = collectRubyCalls(input.tree.rootNode, dispatchTableNames);
```

and before `return out;` (after the `classPrependedAncestors` block):

```typescript
if (Object.keys(dispatchTables).length > 0) out.dispatchTables = dispatchTables;
```

- [ ] **Step 5: Tag dispatch sites inside `collectRubyCalls`**

Change the signature (line 555):

```typescript
function collectRubyCalls(root: Parser.SyntaxNode, dispatchTableNames: ReadonlySet<string>): CallRef[] {
```

In the `call` / `method_call` branch, at the point where the receiver-member
CallRef is pushed (the
`if (receiverText !== null) { out.push(...) } else { ... }` block, ~line 740),
compute the dispatch ref ONCE for the node and attach it to the pushed ref.
Replace that push block with:

```typescript
const dispatch = exprToRubyDispatchRef(node, dispatchTableNames);
const callRef: CallRef = {
  callText: node.text,
  receiver: receiverText,
  member: method.text,
  startLine,
};
if (dispatch?.field) callRef.dispatch = dispatch;
out.push(callRef);
```

(Only the OUTER `.member` call yields `dispatch.field` non-null; the inner
`.new` node's `exprToRubyDispatchRef` returns `field: null`, so
`if (dispatch?.field)` skips it — no double tag. The `element_reference` node
itself is not a `call`, so it is never pushed.)

- [ ] **Step 6: Run tests to verify they pass**

Run:
`npx vitest run tests/core/domains/language/ruby/walker/ruby-walker.test.ts`
Expected: PASS — the new `registry dispatch tables` describe is green AND every
pre-existing describe (registry constant-hash ki9v, localBindings, dispatch,
ancestors, …) stays green. If any pre-existing `it` broke, the additive change
leaked — revert the push-block edit and re-isolate.

- [ ] **Step 7: DO NOT COMMIT.** Proceed to Task 3.

---

### Task 3: Ruby resolver — `RubyTableDispatchResolver` + precedence wiring

**Files:**

- Create:
  `src/core/domains/language/ruby/resolver/strategies/ruby-table-dispatch.ts`
- Modify: `src/core/domains/language/ruby/resolver/strategies/index.ts` (export)
- Modify: `src/core/domains/language/ruby/resolver/ruby-resolver.ts`
  (construct + wire precedence)
- Test:
  `tests/core/domains/language/ruby/resolver/strategies/ruby-table-dispatch.test.ts`
  (Create)

**Interfaces:**

- Consumes: `DispatchResolverComponent`
  (`{ resolveDispatch: (call, ctx) => DispatchEdge[] }`), `DispatchRef`,
  `DispatchTable`, `DispatchTableDef`, `DispatchEdge`, `SymbolResolutionTarget`,
  `CallContext`, `CallRef`, `MethodEdgeKind` from contracts; `resolveConstant`,
  `lastConstantSegment`, `isRubyPath`, `ResolverConfig` from `./shared.js`.
- Produces: `RubyTableDispatchResolver` (constructed with `ResolverConfig`);
  precedence in `RubyCallResolver.resolveDispatch` = table → cone → dynamic.

Resolution model (Ruby-specific, mirrors TS `expandCandidate` but value =
CLASS):

- `selectTableDef(ref.table, ctx)`: single global def → use; multiple → prefer
  the in-file def (`relPath === ctx.callerFile`), else drop. (A registry `CONST`
  is not in `fileScope` and not Zeitwerk-autoloaded, so `resolveConstant` cannot
  disambiguate a table NAME — in-file + sole-global is the Ruby-correct subset
  of the TS import-map disambiguation.)
- `candidateClasses(table, ref)`: `ref.key !== null` → that one entry; else all
  entries. Each entry value is a class FQ-name string.
- For each class FQ-name `C`: `classRelPath = resolveConstant(C, ctx)`; then
  resolve the method `C#field`. Primary:
  `ctx.symbolTable.lookup(`${C}#${field}`)` filtered to `classRelPath`;
  fallback: `lookupByShortName(field)` filtered to `relPath === classRelPath`
  AND innermost scope segment === `lastConstantSegment(C)`. Pick single (mode).
  Dedup by `(targetRelPath, targetSymbolId)`. Drop unresolvable.
- Edge kind/confidence: `ref.key !== null` (static) → `edgeKind: "exact"`,
  `confidence: 1.0`. Dynamic → `edgeKind: "registry"`,
  `confidence: 1 / targets.length`.

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/core/domains/language/ruby/resolver/strategies/ruby-table-dispatch.test.ts
import { describe, expect, it } from "vitest";

import {
  DEFAULT_AMBIGUOUS_RESOLVE_MODE,
  type CallContext,
  type CallRef,
  type GlobalSymbolTable,
  type SymbolDefinition,
} from "../../../../../../../src/core/contracts/types/codegraph.js";
import { RubyTableDispatchResolver } from "../../../../../../../src/core/domains/language/ruby/resolver/strategies/index.js";

// Minimal in-memory symbol table — only the lookups the resolver uses.
function symbolTable(defs: SymbolDefinition[]): GlobalSymbolTable {
  return {
    upsertFile: () => {},
    removeFile: () => {},
    lookup: (fq) => defs.filter((d) => d.fqName === fq),
    lookupByShortName: (n) => defs.filter((d) => d.shortName === n),
    size: () => defs.length,
    hydrate: () => {},
  };
}

const def = (
  fqName: string,
  relPath: string,
  scope: string[],
): SymbolDefinition => ({
  symbolId: fqName,
  fqName,
  shortName: fqName.split(/#|::/).pop() ?? fqName,
  relPath,
  scope,
});

const cfg = { mode: DEFAULT_AMBIGUOUS_RESOLVE_MODE };

function ctxWith(
  defs: SymbolDefinition[],
  tables: NonNullable<CallContext["dispatchTables"]>,
  callerFile = "app/services/runner.rb",
): CallContext {
  return {
    callerFile,
    callerScope: [],
    imports: [],
    symbolTable: symbolTable(defs),
    dispatchTables: tables,
  };
}

describe("RubyTableDispatchResolver (bd tea-rags-mcp-pq02v)", () => {
  const dispatchCall = (
    table: string,
    field: string,
    key: string | null,
  ): CallRef => ({
    callText: `${table}[k].new.${field}`,
    receiver: null,
    member: field,
    startLine: 1,
    dispatch: { table, field, key },
  });

  it("fans a dynamic-key registry call out to each value class's #method (registry, 1/N)", () => {
    const defs = [
      def("Jobs::Clone#perform", "app/jobs/clone.rb", ["Jobs", "Clone"]),
      def("Pipelines::Clone#perform", "app/pipelines/clone.rb", [
        "Pipelines",
        "Clone",
      ]),
    ];
    const tables = {
      TCK: [
        {
          relPath: "app/services/registry.rb",
          table: {
            entries: {
              JobTemplate: "Jobs::Clone",
              PipelineTemplate: "Pipelines::Clone",
            },
          },
        },
      ],
    };
    const edges = new RubyTableDispatchResolver(cfg).resolveDispatch(
      dispatchCall("TCK", "perform", null),
      ctxWith(defs, tables),
    );
    expect(edges).toHaveLength(2);
    expect(edges.every((e) => e.edgeKind === "registry")).toBe(true);
    expect(edges.every((e) => e.confidence === 0.5)).toBe(true);
    expect(edges.map((e) => e.targetSymbolId).sort()).toEqual([
      "Jobs::Clone#perform",
      "Pipelines::Clone#perform",
    ]);
  });

  it("narrows a static-key call to the one entry as an exact edge (1.0)", () => {
    const defs = [
      def("Jobs::Clone#perform", "app/jobs/clone.rb", ["Jobs", "Clone"]),
      def("Pipelines::Clone#perform", "app/pipelines/clone.rb", [
        "Pipelines",
        "Clone",
      ]),
    ];
    const tables = {
      TCK: [
        {
          relPath: "app/services/registry.rb",
          table: {
            entries: {
              JobTemplate: "Jobs::Clone",
              PipelineTemplate: "Pipelines::Clone",
            },
          },
        },
      ],
    };
    const edges = new RubyTableDispatchResolver(cfg).resolveDispatch(
      dispatchCall("TCK", "perform", "JobTemplate"),
      ctxWith(defs, tables),
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      targetSymbolId: "Jobs::Clone#perform",
      edgeKind: "exact",
      confidence: 1,
    });
  });

  it("drops a value class with no matching #method (never fabricates)", () => {
    const defs = [
      def("Jobs::Clone#perform", "app/jobs/clone.rb", ["Jobs", "Clone"]),
    ];
    const tables = {
      TCK: [
        {
          relPath: "r.rb",
          table: { entries: { a: "Jobs::Clone", b: "Pipelines::Missing" } },
        },
      ],
    };
    const edges = new RubyTableDispatchResolver(cfg).resolveDispatch(
      dispatchCall("TCK", "perform", null),
      ctxWith(defs, tables),
    );
    expect(edges.map((e) => e.targetSymbolId)).toEqual(["Jobs::Clone#perform"]);
  });

  it("returns [] for a non-dispatch call (no call.dispatch) — leaves cone/dynamic untouched", () => {
    const plain: CallRef = {
      callText: "x.perform",
      receiver: "x",
      member: "perform",
      startLine: 1,
    };
    const edges = new RubyTableDispatchResolver(cfg).resolveDispatch(
      plain,
      ctxWith([], {}),
    );
    expect(edges).toEqual([]);
  });

  it("drops an ambiguous table name declared in >1 file with no in-file def", () => {
    const defs = [
      def("Jobs::Clone#perform", "app/jobs/clone.rb", ["Jobs", "Clone"]),
    ];
    const tables = {
      TCK: [
        { relPath: "a.rb", table: { entries: { a: "Jobs::Clone" } } },
        { relPath: "b.rb", table: { entries: { a: "Jobs::Clone" } } },
      ],
    };
    const edges = new RubyTableDispatchResolver(cfg).resolveDispatch(
      dispatchCall("TCK", "perform", null),
      ctxWith(defs, tables, "app/services/runner.rb"),
    );
    expect(edges).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/ruby-table-dispatch.test.ts`
Expected: FAIL — `RubyTableDispatchResolver` is not exported (import error /
undefined constructor).

- [ ] **Step 3: Create the resolver**

```typescript
// src/core/domains/language/ruby/resolver/strategies/ruby-table-dispatch.ts
import type {
  CallContext,
  CallRef,
  DispatchEdge,
  DispatchRef,
  DispatchTable,
  DispatchTableDef,
  SymbolResolutionTarget,
} from "../../../../../contracts/types/codegraph.js";
import type { DispatchResolverComponent } from "../../../../../contracts/types/language.js";
import {
  isRubyPath,
  lastConstantSegment,
  resolveConstant,
  type ResolverConfig,
} from "./shared.js";

/**
 * Registry-literal dispatch fan-out (bd tea-rags-mcp-pq02v). A
 * `CONST[key].new.member` site whose `CONST` is a frozen hash/array of
 * value-classes (the walker tagged it with `CallRef.dispatch`) fans out to each
 * value class's `#member`. The candidate set is statically COMPLETE (every value
 * class is in the literal); a dynamic key fans to all (`registry`, `1/N`), a
 * static literal key narrows to one (`exact`, `1.0`).
 *
 * Implements `DispatchResolverComponent` (fan-out, per-edge confidence) — NOT the
 * single-target `SymbolResolutionStrategy` chain. Composed FIRST in
 * `RubyCallResolver.resolveDispatch` (most specific: concrete `CONST` + static
 * value set); returns `[]` for every non-dispatch call so cone/dynamic stay the
 * default. Never fabricates: an unresolvable table / class / method is dropped.
 */
export class RubyTableDispatchResolver implements DispatchResolverComponent {
  constructor(private readonly cfg: ResolverConfig) {}

  resolveDispatch(call: CallRef, ctx: CallContext): DispatchEdge[] {
    const ref = call.dispatch;
    if (!ref) return [];
    const def = this.selectTableDef(ref.table, ctx);
    if (!def) return [];

    const targets: SymbolResolutionTarget[] = [];
    const seen = new Set<string>();
    for (const className of candidateClasses(def.table, ref)) {
      const target = this.resolveClassMethod(className, ref.field, ctx);
      if (!target) continue;
      const key = `${target.targetRelPath}::${target.targetSymbolId ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      targets.push(target);
    }
    if (targets.length === 0) return [];

    const isStatic = ref.key !== null;
    const confidence = isStatic ? 1 : 1 / targets.length;
    return targets.map((t) => ({
      sourceSymbolId: null,
      targetRelPath: t.targetRelPath,
      targetSymbolId: t.targetSymbolId,
      edgeKind: isStatic ? "exact" : "registry",
      confidence,
    }));
  }

  /**
   * Pick the `DispatchTableDef` for a table name. Single global def → use.
   * Multiple → prefer the in-file declaration (a registry CONST is not in
   * fileScope nor Zeitwerk-autoloaded, so the table name cannot be import-
   * disambiguated); else drop rather than guess (m46z).
   */
  private selectTableDef(
    name: string,
    ctx: CallContext,
  ): DispatchTableDef | null {
    const defs = ctx.dispatchTables?.[name];
    if (!defs || defs.length === 0) return null;
    if (defs.length === 1) return defs[0];
    const inFile = defs.filter((d) => d.relPath === ctx.callerFile);
    return inFile.length === 1 ? inFile[0] : null;
  }

  /**
   * Resolve `Class#field` for a value-class FQ-name. The class FQ-name resolves
   * to its declaring file via `resolveConstant`; the method is then looked up by
   * exact `Class#field` fqName (filtered to that file) with a short-name
   * fallback scoped to the class's last segment. Ruby files only.
   */
  private resolveClassMethod(
    className: string,
    field: string,
    ctx: CallContext,
  ): SymbolResolutionTarget | null {
    const classRelPath = resolveConstant(className, ctx);
    if (classRelPath === null || !isRubyPath(classRelPath)) return null;

    const fq = `${className}#${field}`;
    const direct = ctx.symbolTable
      .lookup(fq)
      .filter((d) => d.relPath === classRelPath);
    if (direct.length === 1)
      return {
        targetRelPath: direct[0].relPath,
        targetSymbolId: direct[0].symbolId,
      };

    const shortSeg = lastConstantSegment(className);
    const byShort = ctx.symbolTable
      .lookupByShortName(field)
      .filter(
        (d) =>
          d.relPath === classRelPath &&
          d.scope[d.scope.length - 1] === shortSeg,
      );
    if (byShort.length === 1)
      return {
        targetRelPath: byShort[0].relPath,
        targetSymbolId: byShort[0].symbolId,
      };

    return null;
  }
}

/**
 * Value-class FQ-names a `DispatchRef` selects from a Ruby registry table.
 * Static key → the one matching entry; dynamic key → every entry. Ruby registry
 * entries are always class-FQ-name strings (the `field` is the dispatched method
 * from the call site, NOT a sub-key of the entry — unlike the TS S1 wrapper map).
 */
function candidateClasses(table: DispatchTable, ref: DispatchRef): string[] {
  const keys = ref.key !== null ? [ref.key] : Object.keys(table.entries);
  const classes: string[] = [];
  for (const key of keys) {
    const entry = table.entries[key];
    if (typeof entry === "string") classes.push(entry);
  }
  return classes;
}
```

- [ ] **Step 4: Export from the strategies barrel**

Add to `src/core/domains/language/ruby/resolver/strategies/index.ts` (alongside
the other dispatch exports):

```typescript
export { RubyTableDispatchResolver } from "./ruby-table-dispatch.js";
```

- [ ] **Step 5: Run the resolver tests — verify GREEN**

Run:
`npx vitest run tests/core/domains/language/ruby/resolver/strategies/ruby-table-dispatch.test.ts`
Expected: PASS (5 passing).

- [ ] **Step 6: Wire precedence in `RubyCallResolver`**

In `ruby-resolver.ts`: add the import to the existing `./strategies/index.js`
import block (line 45-58):

```typescript
  RubyTableDispatchResolver,
```

Add the field (after line 77):

```typescript
  private readonly table: RubyTableDispatchResolver;
```

Construct it in the constructor (after `this.dynamic = ...`, line 95):

```typescript
this.table = new RubyTableDispatchResolver(cfg);
```

Rewrite `resolveDispatch` (121-125) — table FIRST, then the existing
cone→dynamic:

```typescript
  resolveDispatch(call: CallRef, ctx: CallContext): DispatchEdge[] {
    const table = this.table.resolveDispatch(call, ctx);
    if (table.length > 0) return table;
    const cone = this.cone.resolveDispatch(call, ctx);
    if (cone.length > 0) return cone;
    return this.dynamic.resolveDispatch(call, ctx);
  }
```

Update the `resolveDispatch` doc comment (102-120) to list the table component
as step 1 (registry-literal, most specific), shifting cone→2 and dynamic→3,
noting a non-dispatch call (`call.dispatch` absent) makes the table component
return `[]` immediately so cone/dynamic are unaffected.

- [ ] **Step 7: Run the resolver dispatch regression — verify cone/dynamic
      untouched**

Run: `npx vitest run tests/core/domains/language/ruby/resolver/` Expected: PASS
— the new strategy test plus every pre-existing
`ruby-resolver-dispatch.test.ts`, `strategies/ruby-cone-dispatch.test.ts`,
`strategies/ruby-dynamic-dispatch.test.ts` stay green (precedence is additive:
table returns `[]` for the typed-receiver / dynamic-receiver shapes those tests
exercise, because those calls carry no `call.dispatch`).

- [ ] **Step 8: DO NOT COMMIT.** Proceed to Task 4.

---

### Task 4: Full regression + combined commit

**Files:** none new — stages Tasks 1-3.

- [ ] **Step 1: Type-check**

Run: `npx tsc --noEmit` Expected: exit 0, no errors.

- [ ] **Step 2: Lint**

Run:
`npx eslint src/core/domains/language/ruby src/core/contracts/types/codegraph.ts`
Expected: 0 problems. Fix any issue in the CODE (never add `eslint-disable`,
never touch linter config).

- [ ] **Step 3: Full test suite**

Run: `npx vitest run` Expected: all green. Pay attention to: ruby walker, ruby
resolver (all dispatch variants), TS walker/resolver dispatch (unchanged —
confirms the contract change didn't regress the n0zj path), codegraph
normalizer/persistence (confirms `"registry"` edgeKind round-trips through
migration 006 like `"dynamic"` did).

- [ ] **Step 4: Stage everything in ONE commit (avoid partial-state
      coverage-gate trap)**

```bash
git add \
  src/core/contracts/types/codegraph.ts \
  src/core/domains/language/ruby/walker/walker.ts \
  src/core/domains/language/ruby/resolver/strategies/ruby-table-dispatch.ts \
  src/core/domains/language/ruby/resolver/strategies/index.ts \
  src/core/domains/language/ruby/resolver/ruby-resolver.ts \
  tests/core/contracts/types/codegraph-method-edge-kind.test.ts \
  tests/core/domains/language/ruby/walker/ruby-walker.test.ts \
  tests/core/domains/language/ruby/resolver/strategies/ruby-table-dispatch.test.ts
```

- [ ] **Step 5: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(trajectory): registry-literal dispatch (CONST[k].new.m) method edges (9zlt/pq02v)

Resolve Ruby registry-dispatch sites CONST[runtime_key].new.perform to method
edges fanning out to each value class's #perform. Reuses the existing
dispatchTables infra (n0zj) instead of the parallel registryTables the bead
prescribed: 0 new contract fields, 0 provider changes.

- contract: MethodEdgeKind += "registry"; DispatchTable doc records the Ruby
  class-entry overload (string-arm = class FQ-name, member from call site).
- walker: collectRubyDispatchTables builds a DispatchTable per frozen
  hash/array registry constant; exprToRubyDispatchRef tags CONST[k].new.m sites
  (.new is a pass-through). ki9v chunk-refs preserved.
- resolver: RubyTableDispatchResolver fans the ref out (resolveConstant per
  value class + Class#field lookup), wired FIRST in resolveDispatch precedence
  (table -> cone -> dynamic). Static key -> exact/1.0; dynamic key -> registry/(1/N).

Why: the general dispatchTables mechanism already models TABLE[k].member()
fan-out language-agnostically; duplicating it as registryTables would diverge
Ruby from TS and churn the EXTREME-churn provider for no infra gain. The TS
fn-entry vs Ruby class-entry semantic gap is absorbed by the language-scoped
resolver interpreting DispatchTable entries, documented in a doc comment rather
than a type split.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

The pre-commit hook runs lint-staged (prettier + eslint --fix + tsc + vitest
--coverage). If coverage fails on the staged tree, delegate to the
`coverage-expander` subagent (MANDATORY per CLAUDE.md) — do NOT lower thresholds
or inline tests. Do NOT push (ephemeral branch; push only on explicit
instruction).

---

## Deferred (NOT part of this plan — separate session)

- **Live validation** (needs `npm run build && npm link` → reconnect MCP →
  `force_reindex tea-rags`, the codegraph schema is already drifting so a full
  reset is due anyway): index taxdome, confirm
  `app/services/workflow/templates/clone.rb`
  `TEMPLATE_CLONE_KLASSES[k].new.perform` emits N `registry`-kind rows in
  `cg_symbols_edges_method` to each value class's `#perform`.
- **Merge to main** + post-merge build+relink per `.claude/CLAUDE.md` "MCP
  Integration Testing".

## Out of scope (YAGNI — do NOT implement)

- Generic table-dispatch engine (TS fn-entry vs Ruby class-entry diverge at N=2
  — a shared engine would be forced abstraction).
- Cross-file-only dispatch sites where `CONST` is never a local table name (the
  run-global table still resolves targets; widening the gate to the run-global
  name set is a follow-up).
- Integer-key narrowing for `CONST[0]` (a literal integer index fans the full
  set in the first cut).
- Non-constant registry values (procs, factory calls) — dropped, no symbol.

## Self-Review

- **Spec coverage:** contract doc+enum → Task 1; walker
  `collectRubyDispatchTables` + gate + `exprToRubyDispatchRef` tagging → Task 2;
  `RubyTableDispatchResolver` + precedence → Task 3; provider 0-changes
  confirmed (no task); edge-kind static/dynamic → Task 3 Step 3; out-of-scope
  items enumerated. ✓
- **Type consistency:**
  `collectRubyDispatchTables`/`exprToRubyDispatchRef`/`rubyDispatchKeyText`/`rubyDispatchValueConstant`
  (walker);
  `RubyTableDispatchResolver`/`candidateClasses`/`resolveClassMethod`/`selectTableDef`
  (resolver) — names stable across tasks. `DispatchRef` shape
  `{table, field, key}` matches contract. `resolveConstant(C, ctx): string|null`
  (relPath) used as defined. `MethodEdgeKind` member `"registry"` referenced
  consistently. ✓
- **Placeholder scan:** every code step has real code; no TBD/TODO. ✓
- **Semantic-gap guard:** Ruby `candidateClasses` reads only the string-arm
  (class FQ-name) and applies `ref.field` at method-resolution time — does NOT
  reuse the TS S1 `entry[field]` object-arm. Documented in the function
  comment + DispatchTable doc. ✓
