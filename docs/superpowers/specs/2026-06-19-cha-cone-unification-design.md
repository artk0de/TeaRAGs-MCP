# CHA Cone-Dispatch Unification — Language-Agnostic Design

**Date:** 2026-06-19. **Scope:** extract the Ruby CHA cone-dispatch engine into
a language-agnostic component and bring Python online as the second consumer
(N=2). Follows the Ruby cai0 program (cone landed in `241a5608`).

## Problem

`RubyConeDispatchResolver` (`ruby/resolver/strategies/ruby-cone-dispatch.ts`,
commit `241a5608`) implements `DispatchResolverComponent` but hardcodes Ruby
specifics — `resolveConstant` (Zeitwerk), `lastConstantSegment` (`::`),
scope-tail matching. The CHA algorithm itself is language-independent:

```
T = ctx.localBindings[receiver]
cone = ctx.hierarchy.getDescendants(T) ∩ { subtypes directly overriding m }
  |cone| == 0  → []                                  (provider falls back to exact)
  |cone| ≤ K   → N DispatchEdge kind='cone' confidence=1/N
  |cone| >  K  → 1 edge to base-decl kind='poly-base'
```

`HierarchyView`, `CallContext`, `DispatchEdge` already live in `contracts/` and
are shared across all 7 languages. The only language-specific operations are (a)
resolve a type-name → declaring file and (b) find a method declared directly on
a type (the override check).

## Architecture (domain-boundaries clean)

`contracts/` is pure-type (no runtime), so the engine lives beside the existing
shared `resolveViaChain` engine at `domains/language/resolver-chain.ts`.

| Component                                                                | Location                                                 | Responsibility                                                                                    |
| ------------------------------------------------------------------------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `ConeTypeLocator` (interface)                                            | `contracts/types/language.ts`                            | the two language-specific primitives                                                              |
| `ConeDispatchResolver` (generic, `implements DispatchResolverComponent`) | `domains/language/cone-dispatch.ts`                      | the whole generic algorithm: descendants ∩ override, K-threshold, fan-out / poly-base, confidence |
| `RubyConeTypeLocator`                                                    | `ruby/resolver/strategies/ruby-cone-type-locator.ts`     | `resolveConstant` (Zeitwerk) + scope-tail / `::` match                                            |
| `PythonConeTypeLocator`                                                  | `python/resolver/strategies/python-cone-type-locator.ts` | module-path resolution + scope-tail / `.` match                                                   |

```ts
export interface ConeTypeLocator {
  /** Resolve a (possibly qualified) type name to its declaring file, or null. */
  resolveTypeFile(typeName: string, ctx: CallContext): RelPath | null;
  /** Method declared DIRECTLY on `typeName` (the override pin), or null. */
  findDirectMethod(
    typeName: string,
    member: string,
    ctx: CallContext,
  ): SymbolResolutionTarget | null;
}
```

The engine owns the **poly-base policy** — `resolveBaseDecl` is NOT in the
locator; the engine composes it as
`findDirectMethod(T,m) ?? { resolveTypeFile(T), null }` so no language's
base-decl assumption leaks into the shared core.

**The provider is untouched** — the cone-first normal-call branch (increment C)
is already language-agnostic (`resolver.resolveDispatch` → fan-out). Any
language whose resolver returns cone edges is handled automatically.

## Slices

### Slice 1 — extract engine + locator + Ruby refactor (behavior-preserving)

- Add `ConeTypeLocator` to `contracts/types/language.ts`.
- Add `ConeDispatchResolver` to `domains/language/cone-dispatch.ts` (moves the
  generic algorithm out of `ruby-cone-dispatch.ts`).
- Add `RubyConeTypeLocator` (the `resolveConstant` + scope-tail logic extracted
  from `ruby-cone-dispatch.ts`).
- `RubyConeDispatchResolver` becomes a thin wrapper:
  `new ConeDispatchResolver(new RubyConeTypeLocator(cfg), cfg.coneMax)`, so the
  **7 existing cone tests pass unchanged** (the regression guard).
- New test: `ConeDispatchResolver` exercised with a fake `ConeTypeLocator`
  (fan-out / poly-base / K-threshold / empty cases) — the behavior tests migrate
  to the engine; the Ruby-specific resolution stays covered by the existing Ruby
  tests. Per the relocation-migration rule: relocate code → existing green →
  engine tests added last.

### Slice 2 — Python walker inheritance-edge emission (substrate, ⟂ Slice 1)

The reverse index (`getDescendants`) is built from persisted
`cg_symbols_inheritance` rows, populated from `InheritanceEdgeDecl`. The Python
walker today emits only `classExtends` (single first base, forward, in
`CallContext`) — NOT inheritance edges — so `getDescendants(T)` returns `[]` for
Python and any cone is inert.

- Add `collectPythonInheritanceEdges`: `class B(A, M):` →
  `InheritanceEdgeDecl{ source:"B", ancestor:"A"|"M", kind:"super", ordinal }`
  for ALL bases (Python multiple inheritance; `kind:"super"` since Python MRO
  has no include/extend/prepend distinction). Wire onto `FileExtraction` like
  the Ruby walker (lz8t) — `classExtends` stays for the phased forward path.
- TDD mirrors `tests/.../ruby/walker/walker-inheritance-edges.test.ts`.

### Slice 3 — Python cone (depends on Slice 1 + Slice 2)

- `PythonConeTypeLocator implements ConeTypeLocator` (Python module/type
  resolution + scope-tail with `.` separator).
- `PythonCallResolver.resolveDispatch` delegates to
  `new ConeDispatchResolver(new PythonConeTypeLocator(cfg), coneMax)`. Env
  `CODEGRAPH_PY_CONE_MAX` (default 8), mirroring `CODEGRAPH_RB_CONE_MAX`.
- Precondition check (in TDD): the Python walker emits `localBindings`
  (var→type) so `T = ctx.localBindings[receiver]` is populated; the
  `python-local-binding` strategy already consumes it, so it is. If absent the
  cone is inert and a localBindings slice precedes this.
- TDD mirrors the Ruby cone test on Python fixtures. N=2 proves the abstraction.

## Invariants / risks

- `external never cones` holds in the generic engine (no `localBinding` ⇒ no T ⇒
  `[]`).
- Hotspot churn (ruby-resolver 8.45, python-resolver 9.83): edits additive; the
  Ruby refactor is guarded by the 7 existing cone tests staying green.
- Slice 2 `kind:"super"` for all Python bases is a deliberate simplification —
  Python C3 MRO is linearized at runtime; the cone only needs the descendant
  set, not MRO order.

## Testing / validation

- TDD unit per slice; full `vitest` + `tsc` + `eslint` regression.
- Live (deferred, needs fresh index): a Python project with class hierarchies —
  confirm `getDescendants` non-empty and cone edges emit.

## Sequence

Slice 1 ∥ Slice 2 (disjoint files) → integrate → Slice 3. Each slice its own
commit.
