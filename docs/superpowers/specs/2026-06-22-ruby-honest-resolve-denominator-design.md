# Ruby "Honest bareCall Denominator" — External + Unresolvable Classification

- **Date**: 2026-06-22
- **Epic**: `tea-rags-mcp-cai0` (Ruby resolver precision) → child of
  `tea-rags-mcp-duzy`
- **Status**: Approved design
- **Base**: worktree `ruby-dsl-decomposition` at local main `2b5e3460`

## Problem

The Ruby codegraph `resolveSuccessRate` for the `bareCall` receiver-kind on
huginn is 1803/3617 (with 269 externalSkipped) → ~1545 "internal-miss". A
read-only investigation found that miss is **dominated by framework/gem methods
that can never resolve to a project file** — there is nothing to resolve _to_:

- **AR/AM class macros** invoked at class-body scope (`has_many`, `validates`,
  `before_save`, `scope`, `serialize`, `delegate`) — ~300–450 sites.
- **Controller / ActiveSupport instance helpers** (`params`, `render`,
  `redirect_to`, `head`, `respond_to`, `t`, `l`, `flash`) — ~250–400 sites.

These are counted as project misses today, depressing the metric. The genuine
resolver gap (ambiguous short-name needing type inference,
inherited-unreachable) is the minority. Two further idioms are mis-handled:

- `send(:literal)` / `obj.method(&:name)` symbol-proc shorthands reference a
  REAL method by literal name but currently do NOT resolve (`send` is a Kernel
  builtin → externalSkipped; `&:name` emits no call at all).
- `send(var)` / `public_send(var)` with a non-literal arg is **statically
  undeterminable** — not a resolver failure, but currently counted as one.

The current metric has only two outcome classes (resolved / miss) with one
exclusion (`callsExternalSkipped`, ykj7, only Ruby Kernel builtins). It cannot
express "framework call" vs "undeterminable" vs "genuine miss".

## Goals

Reclassify unresolved Ruby calls into THREE honest categories:

1. **EXTERNAL** — framework/gem, target exists outside the project → counted in
   the existing `callsExternalSkipped`, excluded from the denominator.
2. **UNRESOLVABLE** — statically undeterminable (dynamic `send(var)`) → a NEW
   `callsUnresolvable` counter, also excluded from the denominator.
3. **INTERNAL-MISS** — the genuine resolver gap, left for future type-inference.

Plus resolve `send(:literal)` / `&:sym` to their named method (real new edges).

`resolveSuccessRate = callsResolved / max(1, callsAttempted − callsExternalSkipped − callsUnresolvable)`.

### Non-Goals

- `store_accessor`-generated accessor CALLS cannot be told from typos without
  tracking the `store_accessor` declaration → deferred.
- `method_missing` dynamic dispatch → deferred (inherently unresolvable, but not
  cheaply detectable per-call-site).
- Type-inference for ambiguous short-name (bucket b) and include-mixin ancestry
  (bucket c) → separate future work (P3 local-type / RTA).

## Key facts (ground truth)

- `CallRef` (`contracts/types/codegraph.ts:451`) carries `callText`, `receiver`,
  `member`, `startLine`, `dispatch`, `dispatchArgs` — **NOT the call
  arguments**. So the resolver cannot see the `:foo` in `send(:foo)`. Anything
  needing the argument shape (send-literal, send-dynamic) requires a WALKER
  change (the walker has the AST).
- `targetsExternalImport(call, ctx)` (`ruby-resolver.ts:124`) is the resolver's
  external classifier — `receiver === null` branch checks
  `RUBY_KERNEL_BUILTINS`.
- The `CallResolver` contract (`codegraph.ts:546`) is implemented by all 5
  languages; `targetsExternalImport` is optional on it. Adding a method affects
  every implementor — AVOID.

## Design — two phases (each its own commit + isolated live-validation)

### Phase 1 — External classification (resolver-only, cheap, biggest move)

Extend `RubyCallResolver#targetsExternalImport` `receiver === null` branch:

```ts
if (receiver === null) {
  return (
    RUBY_KERNEL_BUILTINS.has(call.member) || // ykj7 (Ruby core)
    call.member in RUBY_DSL || // catalogue-derived (AR/AM macros)
    RAILS_RUNTIME_BUILTINS.has(call.member) // controller/AS instance helpers
  );
}
```

- **catalogue-derived**: `member in RUBY_DSL` — any no-receiver call to a known
  class-body DSL macro keyword (`has_many`/`validates`/`before_save`/`scope`/
  `delegate`/...) is a framework macro invocation with zero project defs. Reuses
  the decomposed catalogue; OCP — adding a framework macro to the catalogue
  auto-classifies it external. Import `RUBY_DSL` from `../dsl/index.js`
  (resolver → dsl, same domain, allowed).
- **`RAILS_RUNTIME_BUILTINS`**: a NEW curated set in
  `ruby/resolver/rails-runtime-builtins.ts` (sibling of `kernel-builtins.ts`,
  same shape) for controller/ActiveSupport INSTANCE helpers that are NOT DSL
  macros: `params`, `render`, `redirect_to`, `head`, `respond_to`,
  `respond_to?`, `flash`, `session`, `cookies`, `request`, `response`,
  `helper_method`, `layout`, `rescue_from`, `t`, `l`, `logger`, `redirect_back`,
  `url_for`, `polymorphic_url` (curated from huginn + standard Rails controller
  surface).

**Safety (ykj7 invariant):** a project method that SHADOWS one of these names
resolves first via the strategy chain and never reaches `targetsExternalImport`
(only UNRESOLVED calls reach it). So a project `render` def is unaffected — no
false external. Verified during investigation: `has_many`/`validates`/`params`
have zero project defs in huginn.

**Effect:** moves ~550–850 huginn bareCalls from internal-miss →
externalSkipped. Denominator shrinks; `resolveSuccessRate` bareCall ≈ 53.9% →
65–72% (+12–18pp). Honest denominator correction, NOT new resolution. No counter
change, no walker change.

### Phase 2 — send / symbol-proc (walker + new `callsUnresolvable` counter)

The walker (`ruby/walker/walker.ts`, where the AST is available) owns this:

**2a — resolution (real new edges), walker-only:**

- `send(:foo)` / `send("foo")` / `obj.send(:foo)` → emit a normal `CallRef`
  whose `member` is the literal target (`foo`), `receiver` preserved (`obj`, or
  `null` for implicit self). Resolves via the existing chain — no resolver
  change. (Bonus: `send(:foo)` is externalSkipped today because `send ∈ Kernel`;
  after 2a it becomes a RESOLVED edge — an honest improvement.)
- `x.map(&:name)` / any `&:symbol` block-pass → emit a `CallRef` with
  `member = name` (receiver: the block's element type is unknown → treat as a
  bare/dynamic short-name call, resolves via the same chain that handles
  `dynamic`/`bareCall`). The `&:sym` shape is an argument node today and emits
  no call; 2a makes the walker emit one.

**2b — unresolvable, walker tag + new counter:**

- `send(var)` / `public_send(var)` / `__send__(var)` where the first arg is NON-
  literal (an identifier / method call / interpolation) → the walker tags the
  `CallRef` as dynamically-undeterminable. Mechanism: a new optional
  `CallRef.dynamicSend?: true` flag (additive to the contract,
  codegraph-internal, does NOT touch the 5-language `CallResolver` interface).
- The codegraph provider's resolve loop (`provider.ts`, where `callsAttempted` /
  `callsResolved` / `callsExternalSkipped` are tallied) reads the flag: a
  `dynamicSend` call that did not resolve increments the NEW `callsUnresolvable`
  counter instead of being an internal-miss.

**New counter plumbing:**

- `contracts/types/codegraph.ts`: add `callsUnresolvable` to the run-stats shape
  (`RunStats` / `ReceiverKindTally`) and `unresolvable` to `ResolveRunStatsRow`.
- `provider.ts`: accumulate per-(language, receiverKind); persist via
  `recordRunStats`.
- `status-module.ts` (`summarizeCodegraphResolve` / `buildByReceiverKind`):
  surface `unresolvable` in the byReceiverKind rows and compute
  `resolveSuccessRate = resolved / max(1, attempted − externalSkipped − unresolvable)`.
- `CodegraphResolveKindRow` DTO (`api/public/dto` / `types.ts`): add
  `unresolvable`.

**Effect:** 2a adds real resolved edges (send-literal/&:sym); 2b moves dynamic
send from internal-miss → unresolvable. Both live-validated on huginn,
attributed separately via the per-receiver-kind counters.

## Components & boundaries

| Unit                                                     | Responsibility                                                       | Depends on                       |
| -------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------- |
| `ruby/resolver/rails-runtime-builtins.ts` (NEW)          | curated Rails instance-helper name set                               | nothing (pure data)              |
| `ruby/resolver/ruby-resolver.ts` `targetsExternalImport` | external classification (kernel + catalogue + rails-runtime)         | `RUBY_DSL`, the two builtin sets |
| `ruby/walker/walker.ts`                                  | rewrite send-literal/&:sym → CallRef; tag send-dynamic `dynamicSend` | AST                              |
| `contracts/types/codegraph.ts`                           | `CallRef.dynamicSend?`; run-stats `callsUnresolvable`                | —                                |
| `trajectory/codegraph/symbols/provider.ts`               | tally `callsUnresolvable` from the flag                              | run-stats shape                  |
| `ingest/pipeline/status-module.ts`                       | surface `unresolvable` + new denominator                             | DTO                              |

## Testing

- **Phase 1**: unit — `targetsExternalImport` returns true for a no-receiver
  `has_many`/`validates`/`params`/`render`, false for a project method name and
  for receiver-qualified calls; the catalogue check covers a representative
  macro; RAILS_RUNTIME covers representative helpers. Shadowing test: a resolved
  project method never reaches the hook (chain-order invariant). Live: huginn
  force-reindex → bareCall externalSkipped jumps, resolveSuccessRate +12–18pp.
- **Phase 2a**: walker unit — `send(:foo)` emits a CallRef member=`foo`
  (receiver preserved); `x.map(&:name)` emits member=`name`; dynamic `send(var)`
  does NOT emit a literal call. Codegraph: send-literal resolves to the project
  method.
- **Phase 2b**: provider unit — a `dynamicSend` unresolved call increments
  `callsUnresolvable`, not internal-miss; denominator excludes it.
  status-module: byReceiverKind row carries `unresolvable`; rate uses the new
  denominator.
- Live: huginn reindex per phase, attribute external / unresolvable / resolved
  deltas separately from the per-receiver-kind counters.

## Metric attribution (honest)

- Phase 1 external = **denominator correction** (reclassification), NOT new
  resolution. ~+12–18pp on bareCall.
- Phase 2a send-literal/&:sym = **real new resolved edges** (small).
- Phase 2b dynamic-send = **honest exclusion** (unresolvable), small denominator
  shrink.

The point is an HONEST metric, not a vanity number — every reclassified call
genuinely is framework / undeterminable, verified against the resolver's
chain-order safety.

## Risks

- `ruby-resolver.ts` is a hub (fanIn 9, high relativeChurn) — touch only the
  `targetsExternalImport` branch; do not disturb the resolve chain.
- The walker send-rewrite must not double-emit (the existing `send` call AND the
  rewritten target). The walker emits ONE CallRef per send site (the target),
  replacing the `send` member.
- RAILS_RUNTIME_BUILTINS is a curated list — a project method named `render` is
  safe (chain-order), but an over-broad list could mask a genuine miss of a rare
  same-named project method. Keep it to high-confidence framework names; the
  chain-order invariant is the backstop.
