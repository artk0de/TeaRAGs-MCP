# G4 — Instance-rooted self-dispatch template redirect (u7d9l v3)

Epic: `2026-07-10-ruby-graph-precision-wave2-epic.md`. Third increment of the
self-receiver dispatch mechanism
(`2026-07-06-ruby-self-receiver-dispatch-design.md`): v1 anchored constant
entries, v2 bridged the `self.call → new.call` class→instance delegation.
Both anchor ONLY constant receivers (`Const.member`).

## Measured evidence

- 39 of 44 discovered taxdome templates are instance-form concern hooks
  (`…#acceptable_payment_methods → firm`, `SoftDeletable#restore → update`,
  `KindOfService#call → perform`) — reached by INSTANCE dispatch, which v1/v2
  do not anchor.
- `#call` zero-caller: 71 of 85 (84 %).
- Shape: `service = Create.new(...); service.call` — `localBindings` already
  types `service` as `Create`; the resolve lands on the inherited
  `KindOfService#call` (the TEMPLATE node) instead of the per-entry
  `Create#perform`.

## Mechanism — one central post-resolution redirect

Do NOT thread template awareness through the 12 strategies. One redirect
function applied in `ruby-resolver.ts` `resolve()` AFTER the strategy chain
returns a resolved target:

```
resolvedTarget ∈ ctx.selfDispatchTemplates          // O(1) key lookup
  && receiverType := typeOf(call.receiver, ctx)     // localBindings / ivarTypes /
                                                    // chain propagation — existing sources
  && receiverType is concrete (not the template's own type)
  → redirect: resolveTypeInstanceMethod(receiverType, hook, ctx)
    — method-level target only; on miss, keep the ORIGINAL resolved target
      (never drop an edge that already existed)
```

- Same narrow-to-1 math as v1/v2, applied to typed-instance entries instead of
  constant entries. The edge stays entry-anchored
  (`enclosing(service.call) → Create#perform`).
- `typeOf` reuses the exact receiver-type sources the strategies already
  consult (`localBindings`, `ivarTypes`, `type-propagation` for chains) — no
  new inference. G1's association/query types AUTOMATICALLY widen this
  redirect's reach (a `belongs_to`-typed receiver calling a template method
  narrows too) — free compounding.
- Fallback semantics: redirect is a REFINEMENT. Any miss (untyped receiver,
  hook not defined on the concrete type, file-only target) keeps the original
  edge — strictly additive precision, zero recall risk.

## Responsibility placement

The redirect is resolver-owned (`domains/language/ruby/resolver/` — a small
`template-redirect.ts` beside `type-propagation.ts`), wired in
`ruby-resolver.ts`. The template map stays a codegraph pre-pass product
(`trajectory/codegraph/symbols/self-dispatch-discovery.ts`) threaded via
`CallContext.selfDispatchTemplates` — already in place, no contracts change.

## Performance

- O(1) map-key check per resolved call; the expensive branch (type lookup +
  instance-method resolve) runs only when the target IS a template (44 keys
  on taxdome).
- No new pass, no new context field.

## Scope boundaries

- IN: typed local vars, ivars, chain-typed receivers calling a template
  method.
- OUT: untyped receivers (stay on the template edge — still better than
  nothing); multi-hook templates (excluded by `foldSelfDispatchTemplates`,
  unchanged); stub-REDIRECT terminal (still gated on a walker
  `isAbstractStub` flag — beads `bcdfe`/`wceck` remain partial).

## Testing & validation

- TDD RED-first: localVar-typed redirect, ivar-typed redirect, chain-typed
  redirect, untyped keep-original, hook-missing keep-original, non-template
  target untouched, template's own abstract type NOT redirected.
- e2e through the provider two-pass (same harness style as
  `provider-self-dispatch-entry.test.ts`).
- Harness A/B target: `#call` zero-caller 71/85 → < 20; instance-form
  templates gain entry-anchored edges. Record numbers here before merge.
