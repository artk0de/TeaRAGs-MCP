# rvw34 — Chain-HEAD typing to fire existing Rails association type-source

**Date:** 2026-06-30
**Beads:** `tea-rags-mcp-rvw34` (cai0 program, relates `7ukxt` local type env)
**Status:** approved

## Problem

On un-annotated Rails the consume-side of Ruby receiver type inference is already
complete — `resolveChain` / `returnTypeOf` / the Rails association walk
(`associationTypes`) / `resolveIvarType` will devirtualize `@status.account`
**iff the chain HEAD is typed**. The gap is 100% on the **produce** side: the only
instance-variable type-source is `@x = Const.new` / finder
(`constInstanceType`). The dominant service/controller ivars never match it, so
their heads stay untyped and every call on them fans out.

### Evidence (real mastodon `PostStatusService`)

The whole file pivots on two ivars, **both untyped today**:

| Line | Site | Why missed |
| --- | --- | --- |
| 43 | `@account = account` | RHS is param `account` (identifier), not `Const.new` → `constInstanceType`=null. The YARD `@param [Account] account` (line 24) is never consulted by the ivar collector. |
| 85 | `@status = @account.statuses.new(...)` | RHS is a chain; `constInstanceType` requires a constant receiver → null. |
| 73–185 | `@account.user/.statuses/.id/...`, `@status.save!/.account/.id/.poll/.account_id/...` | head untyped → ~30 fan-out sites in one file |

Mastodon baseline (live): `account` 29360, `account_id` 11904 dynamic edges.

The Const.new chain head is also unresolved: `typeOfReceiver("PostStatusService.new")`
splits to head `PostStatusService` (a constant) → `resolveLocalBinding`=undefined →
chain undefined. `PostStatusService#call` shows `get_callers=[]` (honest hole).

## Decisions

- **Precision-only, zero fabrication.** Data-flow typing (follow the actual
  assignment RHS) over name-classification. Name-classification (`@status`→Status
  by name alone) is **dropped** — it is the only fabrication-risky source and the
  precise sources cover both dominant ivars.
- **schema.rb column type-source is OUT of scope** — sibling task. It types the
  column ACCESSOR (`Status#account_id`→Integer); rvw34 types the receiver HEAD.
  They compose later.
- **No resolver / consume-side changes.** Only the produce side (type-sources)
  changes; the existing `classFieldTypes` / `ivarTypes` channels carry the result.

## Design — three precise sources

### Component 1 — Const.new-chain head seed (gap b)

`resolver/type-propagation.ts` (`resolveChain`): when the chain head is a bare
constant `C` (regex `^[A-Z]\w*(::[A-Z]\w*)*$`, no cross-domain `YARD_CONST`
import) AND the first link ∈ `RUBY_INSTANCE_RETURNING` (`new`, `find`,
`create!`, …) → seed `{form:"instance", name:C}`, consume that link, continue
threading. A bare-constant head with no instance-returning first link stays
`undefined` (never type `Foo.bar`).

Effect: `typeOfReceiver("PostStatusService.new")` → `{instance, PostStatusService}`
→ `.call` resolves exact.

Open detail (resolve in TDD): receiver text from `.new(args)` does not split on
`.` cleanly — strip a trailing `(...)` from a link if the live receiver capture
includes args.

### Components 2 + 3 — ivar typing from data-flow (gap a)

`walker/local-bindings.ts` — widen `collectRubyIvarFieldTypes` (the
`classFieldTypes` producer) from `constInstanceType`-only into a class-scoped
data-flow collector. Same output shape `Record<class, Record<@ivar, type>>` →
**zero consume-side change**. Sources by precedence:

1. **(exists)** `@x = Const.new` / finder.
2. **(C2 — typed-copy)** `@x = ident` where `ident` is a param with a YARD type
   (`collectYardParamTypes`) or an AST-typed local → bind `@x` to that type.
   Catches `@account = account` with `@param [Account]`.
3. **(C3 — chain-RHS)** `@x = a.b.c` → thread through `associationTypes` (as
   `bindCompoundReceiverChains` does) with an instance-returning tail
   (`.new`/`.create!`/`.first` on a relation → the element model). Catches
   `@status = @account.statuses.new` → Status. Hardest slice.

Inputs threaded into the collector (mirroring `bindCompoundReceiverChains`):
`associationTypes` (`collectRubyClassAssociationTypes`), YARD param map, and the
per-method local-binding state.

If the file grows, extract the ivar collector into
`walker/type-sources/ivar-inference.ts` (peer to `ast-inference.ts`) — decided in
the plan by file size.

## Data flow

```
walker: collectRubyIvarFieldTypes(root, associationTypes, yardParams)
  → classFieldTypes["PostStatusService"] = { "@account": "Account", "@status": "Status" }
  → out.classFieldTypes
resolve: @status.account
  → resolveIvarType("@status") → "Status"            (classFieldTypes)
  → returnTypeOf(Status, "account") → "Account"      (associationTypes — already works)
```

## Testing

- C1: unit in `type-propagation` tests — `Const.new.method` chain.
- C2/C3: unit in `ruby-walker.test.ts` (`classFieldTypes` section) — param-copy +
  chain-RHS fixtures (PostStatusService slice).
- Live-validation on `bench-mastodon`: resolveSuccessRate delta + drop in
  `account`/`account_id` dynamic fan-out, with **no precision regression**
  elsewhere. Reindex is user-gated.

## Out of scope

- schema.rb column type-source (sibling task).
- Name-classification AR-convention heuristic (dropped).
- Cross-file ivar typing beyond the per-file walk.
