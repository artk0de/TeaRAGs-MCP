# Ruby entry narrowing — template-only argument channel (bd tea-rags-mcp-emazx)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans
> to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** `FirmPolicy.authorize!(u, a, :manage_datev, firm)` resolves to
`FirmPolicy#can_manage_datev?` instead of the shared
`AbstractPolicy.authorize!`.

**Architecture:** The Ruby walker records two call-level facts: the positional
argument atoms of a call (identifier-shaped Symbol/String literal, or a bare
identifier) and, for `send`/`public_send`/`__send__`, the name TEMPLATE
(`prefix#{ident}suffix`, exactly one interpolation of a bare identifier). The
provider folds them PER FILE, to a fixpoint across same-file self-shaped
delegation hops, into the already-persisted `SelfDispatchMethodDecl.argTemplate`
(`prefix`, `suffix`, `param`, `via`), so the facts ride the existing `hydrate`
policy of `selfDispatchMethods` and survive an incremental run. The barrier only
indexes them (`collectSelfDispatchArgTemplates`) and publishes
`selfDispatchArgTemplates` on `CallContext`. Cross-file hop chains are out of
scope (bd tea-rags-mcp-h2clg). The entry strategy gains step 2d, run only after
v1/v2 decline: compose the hook from the literal at the template's position,
verify every hop resolves on the concrete constant to the same symbol it did on
the template type, then narrow through the existing
`resolveSelfDispatchHookTarget`.

**Tech Stack:** TypeScript, tree-sitter-ruby, vitest, DuckDB (provider e2e).

**Spec:** bead `tea-rags-mcp-emazx` (owner decision 2026-09-26, option A).
General interprocedural dataflow is `tea-rags-mcp-h2clg`, out of scope.

## Global Constraints

- Strategy index in the Ruby chain is untouched; 2d lives inside
  `RubySelfDispatchEntrySymbolResolutionStrategy`.
- Anything computed (non-param interpolation, two interpolations, non-literal
  argument, keyword pass-through, splat) declines → today's behaviour exactly.
- No new `FileExtraction` / `ChunkExtraction` channel (CallRef fields only) → no
  `merge-extraction.ts` rulebook row; ruby materialized-vs-native parity must
  stay green.
- `ruby.walker` already bumped this cycle → `npm run pin:lang-versions` only.

## tea-rags impact enrichment (rerank: blastRadius)

| File                   | Owner        | Signal                            |
| ---------------------- | ------------ | --------------------------------- |
| `resolution-runner.ts` | artk0de 100% | hub, fanIn 8, transitiveImpact 45 |
| `run-state.ts`         | artk0de 100% | transitiveImpact 46               |
| others                 | artk0de 100% | low fan-in                        |

---

### Task 1: Walker facts on CallRef

**Files:** `src/core/contracts/types/codegraph-extraction.ts` (CallRef
`positionalArgAtoms`, `sendNameTemplate`),
`src/core/domains/language/ruby/walker/call-collection.ts`; test
`tests/core/domains/language/ruby/walker/call-arg-atoms.test.ts`.

- [ ] RED: `FirmPolicy.authorize!(@user, @actor, :manage_datev, @firm)` → atoms
      `[null, null, {literal:"manage_datev"}]`;
      `new(u, a, res, o).authorize!(ability)` → `[{identifier:"ability"}]`;
      `send("can_#{ability}?")` → template
      `{prefix:"can_", suffix:"?", identifier:"ability"}`; `:"can_#{ability}?"`
      same; negatives: two interpolations, `#{ability.to_s}`, `#{x}` wrapped in
      method call → no template.
- [ ] GREEN, commit.

### Task 2: Discovery fold + barrier propagation (persisted)

**Files:** `codegraph-pass1.ts` (`SelfDispatchMethodDecl.argTemplate`),
`self-dispatch-discovery.ts` (`extractSelfDispatchMethods` per-file fold, new
`collectSelfDispatchArgTemplates`), `run-state.ts` (`selfDispatchArgTemplates`),
`run-global-map-registry.ts` (batchOnly: derived at seal),
`codegraph-resolution.ts` (CallContext), `resolution-runner.ts` (thread into
ctx).

- [ ] RED unit tests for extract + propagate (fixpoint through `.authorize!` →
      `#authorize!` → `#result`; computed arg declines; ancestor disagreement
      declines).
- [ ] GREEN, commit.

### Task 3: Entry strategy step 2d + e2e

**Files:** `ruby-self-dispatch-entry.ts`; tests
`ruby-self-dispatch-entry.test.ts`, `provider-self-dispatch-entry.test.ts`
(full + incremental: only caller file re-walked).

- [ ] RED: edge lands on `FirmPolicy#can_manage_datev?`; negatives (non-literal
      arg, keyword pass-through, subclass overriding a hop, hook undefined) keep
      today's target.
- [ ] GREEN, pin versions, commit.

### Task 4: Measurement

- [ ] Heavy lock; `incremental-runglobal-delta.ts --dump-full-edges` on the
      pre-change snapshot and on the branch (entry edges on
      `AbstractPolicy.authorize!/authorize/authorized?`, moved to `#can_*?`,
      other deltas), plus its windows mode for the full-vs-incremental delta.
      The delta harness drives the real run state and runner; the forensics
      harness builds its own `CallContext`, so it gets the new field threaded to
      stay faithful.
