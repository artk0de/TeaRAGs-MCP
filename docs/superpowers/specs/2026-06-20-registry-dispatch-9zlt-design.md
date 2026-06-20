# Registry-Literal Dispatch — `CONST[k].new.m` Method Edges (9zlt/pq02v)

**Date:** 2026-06-20. **Scope:** resolve registry-dispatch call sites
(`CONST[runtime_key].new.perform`) to method edges by reusing the existing
`dispatchTables` (bd n0zj) infrastructure rather than building the parallel
`registryTables` mechanism the bead originally prescribed. Ruby first; the
substrate generalizes to any language whose walker emits `dispatchTables`.

## Problem

The registry-dispatcher pattern (taxdome
`app/services/workflow/templates/clone.rb`):

```ruby
TEMPLATE_CLONE_KLASSES = {
  "JobTemplate" => Workflow::Templates::Job::Clone,
  # … ~20 entries
}.freeze

# dispatch site (possibly in another file):
TEMPLATE_CLONE_KLASSES[some_runtime_key].new.perform
```

The dispatch site is unresolvable today: the runtime key is unknown, so no
single target. But the **value set** — every value class in the literal — is
statically known. So `CONST[k].new.m` should fan out to each value class's `#m`.

`ki9v` (commit `6fc24de3`, reachable from HEAD) already emits chunk-level
reference CallRefs per collection-literal value-constant via
`collectRegistryConstantValueRefs`, giving the registry class-body chunk fanOut
to the N value **classes**. `pq02v` (this spec) adds the **method-level** edges
from the dispatch site to each `Class#m`.

## Key decision — reuse `dispatchTables`, drop `registryTables`

The bead prescribed a new `registryTables: Record<string,string[]>` on
`FileExtraction` + `CallContext`, a new `runRegistryTables` aggregation in the
provider, and a separate resolver path. **Rejected.** The codebase already has
the general `dispatchTables` mechanism (bd n0zj) that TypeScript uses for
exactly the `TABLE[k].member()` fan-out, and it is language-agnostic on every
layer except walker + resolver:

| Layer        | Already present (n0zj)                                                                                                | Registry need                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **contract** | `DispatchTable`, `DispatchRef{table,field,key}`, `DispatchTableDef`, `CallContext.dispatchTables`, `CallRef.dispatch` | **0 new fields** (doc note only)              |
| **provider** | `runDispatchTables` aggregation + threading into `CallContext` (provider.ts:1623), language-agnostic                  | **0 changes**                                 |
| **walker**   | TS `collectDispatchTables` + gate set + `call.dispatch` tag                                                           | Ruby flavor (entries = class FQ-names)        |
| **resolver** | TS `resolveDispatch → expandCandidate → selectTableDef` (import-disambiguated)                                        | Ruby flavor (entry = class, member from site) |

Building `registryTables` would duplicate the entire run-global aggregation +
threading + contract surface, diverge Ruby from TS for no infrastructural
reason, and add churn to the EXTREME-churn `provider.ts` (47 commits).

### Semantic gap (real, narrow)

In TS the table values are **functions** (`TABLE[k](x)` → entry IS the fn;
`TABLE[k].field()` → entry is `{field: fn}`). In the Ruby registry the values
are **classes**, and `CONST[k].new.perform` dispatches through `.new`
(instantiation) to the instance method `Class#perform`. So:

- `DispatchTable.entries` string-arm value = **class FQ-name** (TS: fn name).
- `DispatchRef.field` = the **dispatched instance method** (`perform`) taken
  from the call site (TS: wrapper-object field holding the fn).

Entry semantics are language-scoped (the resolver knows its own language), so
the overload is safe — recorded in a doc comment on `DispatchTable`, not a type
change.

## Architecture

### Contract (`contracts/types/codegraph.ts`) — doc only

No new fields. Extend the `DispatchTable` doc comment: the string-arm entry
value is a function name (TS) **or** a class FQ-name (Ruby registry); the
resolver interprets per language. Add a `MethodEdgeKind` member: `"registry"`
(see edge-kind section).

### Provider — no changes

`runDispatchTables` already aggregates `FileExtraction.dispatchTables` keyed by
table name (list per name, dedup by relPath) and threads the run-global map into
`CallContext.dispatchTables` (provider.ts:1623). The resolveDispatch loop
already calls `resolver.resolveDispatch` per call and threads `edgeKind` /
`confidence` from the returned `DispatchEdge[]` (bd 2jet-C). Cross-file
visibility (registry defined in file A, dispatched in file B) is solved
identically to TS.

### Walker (`ruby/walker/walker.ts`)

1. **`collectRubyDispatchTables(root)`** — refactor-extend
   `collectRegistryConstantValueRefs`. For each
   `CONST = <collection-literal>.freeze` (constant assignment whose RHS is a
   hash/array literal), build `DispatchTable{ entries }` keyed by the LHS
   constant name:
   - **hash literal** — each `pair`: string/symbol key → its literal text; value
     a `constant` / `scope_resolution` → class FQ-name (`readScopeResolution`,
     already present). Non-constant values (lambdas, calls, nested literals)
     dropped (m46z safety — no symbol to point at).
   - **array literal** — element constants recorded under their positional index
     (string-form key). `staticKeyOf` only narrows string/symbol literal
     indices, so an integer-literal index (`CONST[0]`) and a dynamic index both
     fan out the full entry set in the first cut; integer-key narrowing is a
     follow-up.
   - Tables with zero usable (constant-valued) entries are omitted.
   - Emit on `FileExtraction.dispatchTables` (the existing field) when
     non-empty.
   - The existing `collectRegistryConstantValueRefs` chunk-ref emission (ki9v)
     is preserved — the table build is additive over the same literal walk.

2. **gate set** — `dispatchTableNames = new Set(keys(dispatchTables))`. Unlike
   TS, Ruby constants are not imported by name; the run-global tables provide
   cross-file resolution in the resolver, so a file-local gate set of declared
   table names suffices for tagging local dispatch sites. (A dispatch site whose
   `CONST` is declared in another file is still tagged iff the same `CONST`
   token is a known table name locally — acceptable first cut; cross-file-only
   dispatch sites are a documented follow-up, not a regression over today's
   zero.)

3. **`collectRubyCalls(root, dispatchTableNames)`** — tag the dispatch site.
   `exprToRubyDispatchRef(callee)` abstract-interprets the callee chain:
   - `element_reference` whose `object` is a `constant`/`scope_resolution` in
     `dispatchTableNames` → `{ table: CONST, field: null, key: staticKeyOf }`.
     `staticKeyOf` = string/symbol literal index → that key; dynamic index →
     `null` (fan out all entries).
   - `.new` method call on a dispatch-ref receiver → **pass-through**
     (Kernel#new is not a project edge), `field` stays `null`.
   - outer `.member` (`perform`) on a dispatch-ref receiver → set
     `field: member`.
   - Result on the dispatch site: `{ table: CONST, field: "perform", key }` →
     `call.dispatch`. Plain `arr[i].m` on a local variable is NOT tagged (object
     not a constant / not a table name).

### Resolver (`ruby/resolver`)

**`RubyTableDispatchResolver implements DispatchResolverComponent`**
(`strategies/ruby-table-dispatch.ts`):

- For `call.dispatch` (a `DispatchRef`): `selectTableDef(ref.table, ctx)` —
  run-global per-name disambiguation. With one global def → use it; multiple
  defs for the same name → prefer the def whose `relPath` the caller resolves
  the constant to (via `resolveConstant`), else a sole global, else drop (m46z —
  never guess).
- `candidateClasses(table, ref)` — `ref.key` set → that one entry; `null` → all
  entries. Each entry value is a class FQ-name string.
- For each class FQ-name `C`: `resolveConstant(C, ctx)` → declaring file, then
  look up `C#field` (`field` = `perform`) in the symbol table → a
  `SymbolResolutionTarget`. Dedup by `(targetRelPath, targetSymbolId)`. Drop
  unresolvable classes / members (never fabricate). The `.new` was already
  elided by the walker.
- Emit `DispatchEdge[]` (`sourceSymbolId: null`) with `edgeKind` / `confidence`
  per the edge-kind section.

**Precedence in `RubyCallResolver.resolveDispatch`** — table FIRST (most
specific: the call carries a concrete `CONST` + static value set), then cone,
then dynamic:

```ts
resolveDispatch(call, ctx) {
  const table = this.table.resolveDispatch(call, ctx);
  if (table.length > 0) return table;
  const cone = this.cone.resolveDispatch(call, ctx);
  if (cone.length > 0) return cone;
  return this.dynamic.resolveDispatch(call, ctx);
}
```

A non-dispatch call (`call.dispatch` absent) makes the table component return
`[]` immediately, so cone/dynamic are unaffected.

### Edge kind / confidence

- **static key** (`CONST["JobTemplate"].new.perform`) → exactly one entry →
  `edgeKind = "exact"`, `confidence = 1.0`.
- **dynamic key** (`CONST[runtime].new.perform`) → N classes, statically
  complete set, exactly one runs → fan-out, **`edgeKind = "registry"`**,
  `confidence = 1 / N`.

A new `"registry"` member of `MethodEdgeKind` (not reuse of `"cone"` or
`"dynamic"`): `"cone"` is documented as CHA devirtualization
(`descendants ∩ override`) — a different provenance; `"dynamic"` is a short-name
guess with no type evidence, which understates a registry whose candidate set is
exact and statically complete. Persistence already carries arbitrary `edge_kind`
/ `confidence` (migration 006); wbj3 added `"dynamic"` by the same pattern, so
the cost is one enum member.

## Out of scope (YAGNI)

- **No generic table-dispatch engine** (unlike `ConeDispatchResolver`). TS entry
  = fn vs Ruby entry = class + member: the candidate-expansion semantics
  diverge, so a shared engine would be forced at N=2. Keep the Ruby table
  dispatch Ruby-specific; flag a future unification only if a third consumer
  shares the class-entry semantics.
- **Cross-file-only dispatch sites** where `CONST` is never a local table name
  (dispatch in file B, no local re-declaration). First cut tags only sites whose
  `CONST` token is a known local table name; the run-global table still resolves
  the targets. Widening the gate (run-global name set) is a follow-up.
- **Non-constant registry values** (procs, factory calls) — dropped, no symbol.

## Testing / validation

- TDD per layer (RED → GREEN), mirroring the n0zj TS test corpus and the Ruby
  cone/dynamic dispatch tests:
  - walker: `CONST = { "k" => A::B::C }.freeze` → `dispatchTables` entry
    `CONST → { k: "A::B::C" }`; `CONST[x].new.m` tagged with
    `dispatch = { table: "CONST", field: "m", key: null }`; static-key
    `CONST["k"].new.m` → `key: "k"`; plain `arr[i].m` NOT tagged.
  - resolver: dynamic key fans out to each `Class#m` (`registry`, `1/N`); static
    key → one `Class#m` (`exact`, `1.0`); unresolvable class dropped; cross-file
    table via run-global `ctx.dispatchTables`.
  - precedence: a tagged call returns the table edges; cone/dynamic untouched
    for untagged calls (existing cone/dynamic tests stay green — regression
    guard).
- Full `vitest` + `tsc` + `eslint` regression.
- Live (deferred, needs link-flip + reindex): taxdome `clone.rb` — confirm the
  `TEMPLATE_CLONE_KLASSES[k].new.perform` site emits N `registry`-kind method
  edges to each value class's `#perform` in `cg_symbols_edges_method`.

## Sequence

Walker (table build + call tagging) ∥ contract doc/enum (disjoint) → resolver
component + precedence wiring → live validation. One commit (combined, to avoid
the partial-state coverage-gate trap), or walker+contract then resolver if each
stays green standalone.
