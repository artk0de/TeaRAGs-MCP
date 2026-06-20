# Ruby Resolver Precision (cai0) — Syntactic Program Design

**Epic:** `tea-rags-mcp-cai0` (program). **Date:** 2026-06-17. **Scope:** all
syntactic slices that raise Ruby `resolveSuccessRate` from ~0.25 toward ~0.80,
**excluding** LSP (`tea-rags-mcp-2bib`, deferred P4).

Slices: `j431` (instrumentation), `2jet` (CHA devirtualization), `duzy`+`brg9`
(Rails DSL + YARD types), `wbj3` (dynamic-receiver dispatch), `9zlt` (registry
constant edges).

Substrate prerequisite (DONE): `f10y` `cg_symbols_inheritance` + reverse index +
`HierarchyView` injected as `ctx.hierarchy` (T8); `lz8t` precise Ruby kinds
(`super`/`include`/`extend`/`prepend`) validated on huginn (super=159,
include=96, extend=25, collision=0, `getSubtypes(Agent)`=72).

## Problem

The Ruby resolver binds each call-site to a `target_symbol_id`; unresolved →
`null` (dropped, no edge). Today’s misses, by receiver idiom:

| call-site                               | needs                      | today                    |
| --------------------------------------- | -------------------------- | ------------------------ |
| `user.save` (`user: User`)              | receiver type              | resolved (localBindings) |
| `User.find`                             | constant + ancestors       | resolved (walkAncestors) |
| `super`, `self.helper`                  | enclosing + classAncestors | resolved                 |
| `posts.each` (`posts` ← `has_many`)     | DSL-generated method       | **DROP → duzy**          |
| `agent.check` (`agent: Agent`, 72 subs) | which subclass?            | **DROP → 2jet**          |
| `items.map { }` / `obj[k].call`         | dynamic receiver           | **DROP → wbj3**          |
| `HANDLERS[:x].run` (registry literal)   | value class                | partial → 9zlt           |
| `x.bar` with `@param x [Foo]`           | YARD type                  | partial → brg9           |

External calls (`Math.sqrt`, gem calls) correctly resolve to `null` but inflate
the denominator (`ykj7`) — `j431` removes them from the rate.

## Architectural invariant

Every slice feeds the **existing three-state strategy chain**
(`resolved`/`drop`/`continue`) and is measured by one instrument (`j431`). No
slice mutates `collectRubyCalls` destructively — slices only add symbols,
strategies, or types. `external` receivers MUST never enter a cone.

## Slice 1 — j431 (instrumentation, measurement-only)

`RunStats` gains a per-receiver-kind breakdown of `callsAttempted`:
`{ constant, localVar, selfMember, super, bareCall, dynamic, coneCandidate, external }`.
`resolveSuccessRate` is recomputed **excluding `external`** (fixes the `ykj7`
denominator). Surfaced in `get_index_status` / run logs. **No resolution prod
code** — counters only. Establishes the huginn baseline so each later slice
proves a per-bucket delta.

## Slice 2 — 2jet (CHA devirtualization, variant A: bounded persist + query fallback)

**Schema (migration 006):** `cg_symbols_edges_method` gains `edge_kind`
(`'exact' | 'cone' | 'poly-base'`, default `'exact'`) and `confidence` (REAL,
default 1.0).

**Wiring (variant A — cone is fan-out, not a chain pass).** The cone expands one
call site to **N edges**, which the single-target `SymbolResolutionStrategy`
chain (`resolveViaChain` → one `SymbolResolutionTarget | null`) cannot express.
So the cone lives in the **existing fan-out contract**
`DispatchResolverComponent.resolveDispatch` — `RubyCallResolver.resolveDispatch`
becomes Ruby's first (and currently only) dispatch implementation.
`DispatchEdge` gains optional `edgeKind?: MethodEdgeKind` +
`confidence?: number` (defaulting to the persisted `'exact'`/`1.0` for the
existing lookup-table/callback fan-outs).

The provider's **normal-call branch** (`provider.ts`) tries the cone fan-out
**first**, falling back to the exact chain when the cone is empty. Cone-first
(not resolve-first) because the exact `localType` pass already produces a single
base / file-only edge for a polymorphic receiver (`agent.check`, `agent: Agent`
→ `Agent#check` or file-only) — it never returns `null` for an in-project type,
so a "fallback on null" cone would never fire. The cone returns `[]` for every
non-polymorphic call (no `localBinding`, or `T` has no overriding subtypes), so
exact precedence is preserved for everything except a real cone:

```
const cone = resolver.resolveDispatch?.(call, ctx) ?? [];   // [] unless polymorphic
if (cone.length > 0)
  for (const e of cone) push { ...e, edgeKind: e.edgeKind, confidence: e.confidence };
else {
  const target = resolver.resolve(call, ctx);               // exact chain (unchanged)
  if (target) push exact edge (kind='exact', conf=1.0);
}
```

`external` receivers carry no `localBinding` ⇒ `resolveDispatch` returns `[]` ⇒
exact path ⇒ invariant "external never cones" holds.

`RubyCallResolver.resolveDispatch` computes:

```
cone = ctx.hierarchy.getDescendants(T) ∩ { subtypes overriding m }
  |cone| == 0        → []                          (no expansion; provider drops)
  |cone| ≤ K (=8)    → N edges kind='cone' confidence=1/N
  |cone| >  K        → 1 edge to base-decl kind='poly-base' confidence=1.0
                       (query-time get_callees expands via getDescendants)
```

`T` is the receiver's static base type, resolved by the same local-type binding
the `localType` chain pass reads (`ctx.localBindings` + `resolveConstant`); an
`external` / unknown receiver yields no `T` ⇒ `[]` (invariant: external never
cones). `K` is env-tunable (`CODEGRAPH_RB_CONE_MAX`, default 8). First consumer
of `ctx.hierarchy` (precise `lz8t` kinds via the sync `getDescendants` view).
`get_callers`/`get_callees` learn to expand a `poly-base` edge through the
reverse index at query time. `confidence` follows the `stats.confidence`
dampening discipline.

## Slice 3 — duzy (+brg9), independent of 2jet

Walker/macros synthesize symbols for Rails DSL so callers resolve:
`has_many`/`belongs_to`/`has_one` → `User#posts`, `User#posts=`, `User#post_ids`
(+ edge to the associated model); `before_action :auth` → callback edge to
`#auth`; `alias_method`/`alias` (partial today) completed. `brg9`: YARD
`@return [T]` and `@param x [Array<T>]` (element type) into `localBindings`.

## Slice 4 — wbj3, independent

Dynamic receivers (`arr.map`, `obj[k].call`) resolve via short-name lookup with
a `confidence` discount instead of dropping. Low confidence beats `null`; the
`confidence` field marks it.

## Slice 5 — 9zlt, independent

Registry literals `CONST = { k => Klass }` / `[Klass]` → dispatch `CONST[k].m`
through the value class. The walker already emits constant-refs
(`collectRegistryConstantValueRefs`); `9zlt` completes the method edge.

## Testing / validation (per slice)

- TDD unit on the strategy/walker change.
- huginn live: `j431` per-bucket delta before/after; target symbols (`Agent`
  cone, `User#posts`).
- Regression: full vitest suite + `tsc` + `eslint`.
- Invariant check: `external` receivers always `continue`/`drop`, never cone.

## Sequence

`j431` (baseline) → `2jet` → `duzy`/`wbj3`/`9zlt` (independent, parallelizable).
Each slice is its own commit + live validation. Goal:
`resolveSuccessRate 0.25 → 0.80` syntactic. LSP post-pass (`2bib`) remains
deferred.
