# G3 — Ambiguity hygiene: classification residuals + conf-floor policy

Epic: `2026-07-10-ruby-graph-precision-wave2-epic.md`. Two independent halves:
G3a (Wave 1, investigation + fix) and G3b (Wave 2, gated policy decision).

## G3a — external-classification residual + spec/ classification

### Measured evidence

- `spec/support/dnd_helpers.rb` STILL records `cg_ambiguous_fanout` rows
  (`perform` cand=215, `action` cand=134) in the live index — despite the
  DEFECT-1 gate (`chainRootConstantIsExternal`, commit `45df6d86`, Jul 06
  20:30) being present in the build that produced the index (built Jul 06
  21:26, indexed Jul 08 00:56).
- The live shape: `Capybara.current_session.driver.browser.action
  .move_to(...).click_and_hold...perform` — chain root `Capybara` IS a
  constant.
- 338 aggregate rows originate from `spec/` paths while
  `CODEGRAPH_EXCLUDE_TESTS=true` was set.

### Hypotheses (ranked) and the investigation

1. **Gem-group gating:** external-constant classification activates gems from
   the Gemfile's main group only; `capybara` lives in group `:test` →
   `Capybara` is NOT classified external → the gate never fires. Fix:
   activate ALL Gemfile groups (`:test`, `:development`) for external
   classification. (Gemfile ≫ lock lesson from `lawlq.3` applies.)
2. **Wrong build at reindex:** the Jul-8 run may not have used the worktree
   build. Falsified/confirmed for free by the Wave-2 reindex with the current
   main build.

Investigation is harness-first: reproduce the dnd_helpers shape in-process,
assert which hypothesis holds, THEN fix with TDD. If (1): the fix is in the
gem-gating activation path, not in the resolver gate itself.

### spec/ classification

`spec/support/**` files are extracted and record aggregates while
`CODEGRAPH_EXCLUDE_TESTS=true`. Clarify the flag's semantics and close the
classification gap in `infra/file-classification` (single source of truth —
per-file enrichment policy epic `sjxz`): `spec/**` (including `support/`,
`mailers/previews/`) classifies as test for codegraph extraction when the
flag is on. One rule, tests for the boundary paths.

## G3b — conf-floor policy (Wave 2, measured decision)

### Evidence

30 992 edges with conf < 0.05 (avg fan-out 13.1). These make `get_callers`
show 13–25 phantom callers per hook with confidence ~0.04–0.08 noise.

### Gate (fixed with user)

Measure AFTER G1 lands (G1 is expected to kill 60–80 % of these by typing the
receivers). If the residual conf < 0.1 population is **> 5 000 edges**:
implement the floor. Else: record the verdict here, skip.

### Mechanism (if gated in)

Writer-side in the codegraph provider fan-out path: an N-way dynamic fan-out
whose per-edge confidence would be < 0.1 (N > 10) records ONE
`cg_ambiguous_fanout` aggregate row instead of N edges — exactly what the
over-cap path already does; this aligns the under-cap band with it. Consumers
already surface aggregates via `includeAmbiguous`. No schema change; the
representation contract (edges = plausible, aggregates = ambiguous) becomes
uniform across N.

## Testing & validation

- G3a: failing test reproducing the Capybara-shape aggregate; gem-group
  activation unit tests; file-classification boundary tests
  (`spec/support/`, `spec/mailers/previews/`).
- G3b (if in): fan-out band tests (N=10 boundary), aggregate-not-edges
  assertion, `includeAmbiguous` surfacing unchanged.
- Live check rides the Wave-2 reindex: dnd_helpers rows gone = DEFECT-1
  finally live-confirmed (bead `ckjfz`).
