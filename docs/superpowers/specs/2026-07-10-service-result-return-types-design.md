# G2 — Service `call` body last-expression return types

Epic: `2026-07-10-ruby-graph-precision-wave2-epic.md`. Absorbs bead
`tea-rags-mcp-lawlq.1` (scoped AST return-type inference from body
last-expression) — same mechanism, same bead, now with a measured target.

## Measured evidence

- `result.successful?` — 2 128 dynamic targets (top-2 fan-out expression in
  the live graph).
- `failed?` — 1 073 ambiguous-aggregate sites (30 candidates max).
- Shape: `result = SomeService.call(...); result.successful?` — the return
  type of the service entry is statically visible in the `call` body's last
  expression, but nothing extracts it.

## Mechanism

Walker-side type-source `body-last-expr` feeding the SAME `RubyTypeFactStore`:

- For a gated set of methods (below), inspect the method body's last
  expression; emit a fact when it is one of the conservative shapes:
  - `Const.new(...)` → `Const`
  - `Const.new(...).freeze` / `.tap { }` tail → `Const`
  - a local var whose LAST assignment in the body is `Const.new(...)` → `Const`
    (single-assignment only; reassigned vars → silence)
- Anything else (conditionals with divergent branches, method calls,
  ternaries) → NO fact. Precision over recall; a wrong return type poisons
  every chain hop after it.

### Performance gating — bounded, not corpus-wide

Body inspection runs ONLY for methods whose symbolId is in:

- `ctx.selfDispatchTemplates` keys + `selfInstantiatingClassMethods`
  (the u7d9l discovery already enumerates the service universe), and
- class-form `call` / `perform` / instance `call` defs (the service entry
  convention).

This keeps the pass O(services), not O(all 72 k methods). The gate reuses
run-global sets built at the existing pass-1→pass-2 barrier — no new pass.

### Store precedence

YARD > associations (G1) > body-last-expr. A body-inferred fact never
overrides an annotation or a macro-declared type.

## Wave placement

Wave 2 — lands AFTER G1's harness A/B is recorded, so G1's contribution is
measured in isolation (both feed the same store; precedence makes them
compatible, measurement discipline makes them attributable).

## Testing & validation

- TDD RED-first: each conservative shape; each silence case (branching
  return, reassigned local, non-const tail); gating (an ungated method's body
  is never inspected).
- Harness A/B target: `result.successful?` / `failed?` fan-outs collapse to
  exact edges into the Result class; ambiguous `failed?` aggregate sites drop.
  Record numbers here before merge.

## Findings (2026-07-21, harness A/B)

Run A' (G1+G2, self-dispatch OFF) = 18 763 distinct targets, 85.12 % —
**identical to G1-only: G2's corpus effect on the harness metrics is ZERO.**
Root cause (honest): the dominant taxdome service idiom is
`class_methods do; def call; instance = new(*a); instance.call; end` — a
METHOD-CALL tail, which the conservative shapes deliberately SILENCE; and the
instance template's `#call` ends in the abstract `perform` dispatch, not
`Const.new`. So the `result.successful?` fan-out is fed by entries G2's
last-expression shapes cannot type without widening (a precision risk not
taken). The mechanism is invariant-proven (25 tests) and correct on the
shapes it claims; a future increment able to type the KindOfService entry
would need template-aware return threading (class `.call` → instance `#call`
→ Result) — noted, not filed, until reindex numbers justify it.
