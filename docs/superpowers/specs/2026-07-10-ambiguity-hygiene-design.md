# G3 — Ambiguity hygiene: classification residuals + conf-floor policy

Epic: `2026-07-10-ruby-graph-precision-wave2-epic.md`. Two independent halves:
G3a (Wave 1, investigation + fix) and G3b (Wave 2, gated policy decision).

## G3a — external-classification residual + spec/ classification

### Measured evidence

- `spec/support/dnd_helpers.rb` STILL records `cg_ambiguous_fanout` rows
  (`perform` cand=215, `action` cand=134) in the live index — despite the
  DEFECT-1 gate (`chainRootConstantIsExternal`, commit `45df6d86`, Jul 06 20:30)
  being present in the build that produced the index (built Jul 06 21:26,
  indexed Jul 08 00:56).
- The live shape:
  `Capybara.current_session.driver.browser.action .move_to(...).click_and_hold...perform`
  — chain root `Capybara` IS a constant.
- 338 aggregate rows originate from `spec/` paths while
  `CODEGRAPH_EXCLUDE_TESTS=true` was set.

### Hypotheses (ranked) and the investigation

1. **Gem-group gating:** external-constant classification activates gems from
   the Gemfile's main group only; `capybara` lives in group `:test` → `Capybara`
   is NOT classified external → the gate never fires. Fix: activate ALL Gemfile
   groups (`:test`, `:development`) for external classification. (Gemfile ≫ lock
   lesson from `lawlq.3` applies.)
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
`mailers/previews/`) classifies as test for codegraph extraction when the flag
is on. One rule, tests for the boundary paths.

## G3b — conf-floor policy: NOT IMPLEMENTED (verdict 2026-07-26)

The gate fired and the work was built, then **reverted** — measurement showed
the population it targets is already invisible to every consumer. Recorded here
because the reasoning, not the code, is the deliverable.

### What the gate said

Post-G1 residual on the live taxdome index `code_27622aef_v9` (2026-07-26, 161
781 method edges):

| Population                               | Edges                                       |
| ---------------------------------------- | ------------------------------------------- |
| `confidence < 0.1`                       | 48 334 (29.9 % of the graph) on 4 816 sites |
| … of those on sites fanning out past ten | 28 082 (17.4 % of the graph)                |

The gate ("residual > 5 000 → implement") fires 5.6×.

### Why writer-side was rejected

Those edges feed `fanIn` / `fanOut` / `pageRank` / `transitiveImpact`.
Collapsing them into aggregates at write time would remove 17.4 % of the graph
from every centrality computation, silently shifting the calibrated prime
thresholds that the `blastRadius` / `architecturalHub` presets are built on —
and biasing centrality toward statically-resolved code and against dynamic
dispatch, i.e. making the metric lie about the architecture of a Ruby corpus. A
confidence threshold is also presentation policy: baking it into persisted state
means a 25-minute reindex per iteration, versus a constant edit read-side.

### Why read-side was ALSO rejected — the population is already hidden

`isNavigationVisibleEdge` (`api/internal/facades/graph-facade.ts`, bd xlnub)
shows a `dynamic` edge only at confidence 1.0; every other kind is always shown.
Applied to the same index:

| Slice of `confidence < 0.1`                   | Edges  |
| --------------------------------------------- | ------ |
| total                                         | 48 334 |
| `dynamic` — **already hidden by navigation**  | 48 334 |
| non-`dynamic` — what a floor would newly hide | **0**  |

Non-dynamic kinds cannot reach the floor: `exact` is 1.0 by construction, and
`cone` spans 0.25–1.0 because the cone cap (`CODEGRAPH_RB_CONE_MAX`, default 8)
bounds fan-out at 8 ⇒ minimum confidence 0.125 > 0.1. A read-side floor is a
strict no-op under any configuration with a cone cap ≤ 10.

Implemented read-side (facade floor + `includeLowConfidence` flag +
`lowConfidenceCallers` summary, 7 invariant tests, all green) and then reverted:
shipping an MCP input and a response field that provably never fire adds surface
every consuming agent must read past, for zero behaviour. A second defect
surfaced during the build and reinforced the call — `sites` and `edges` in the
summary are provably always equal (the method-edge PK is
`(source, call_expression, target)` and the query pins the target, so one row
per site), so the field would have emitted two identical numbers inviting agents
to infer a difference that cannot exist.

### The real lesson — the gate measured the wrong universe

The threshold was set against raw `cg_symbols_edges_method` rows without
applying the read-path filter that `get_callers` has used since bd xlnub. The
premise stated when the gate was authored — "`get_callers` shows 13–25 phantom
callers per hook" — was false: navigation had been suppressing them all along.

Same class of error as the DEFECT-2 harness overstating its win by comparing
against an OFF baseline weaker than the production resolver. **Rule for future
gates: measure the population as the CONSUMER sees it, and make the threshold
carry a cost term, not only a magnitude term** — this gate would have fired
"correctly" straight into a 17.4 % centrality regression.

### What remains open (not this bead)

Navigation hides 80 266 of 161 781 edges (49.6 %) — the untyped-dispatch
residual. The honest open question is the mirror image of this one: how often
does `get_callers` return `[]` for a symbol that DOES have hidden dynamic
callers, i.e. how often does navigation trade a phantom-caller for a false
negative? That is a recall question about the navigation rule itself, worth its
own measurement before anyone touches confidence policy again.

## Testing & validation

- G3a: failing test reproducing the Capybara-shape aggregate; gem-group
  activation unit tests; file-classification boundary tests (`spec/support/`,
  `spec/mailers/previews/`).
- G3b (if in): fan-out band tests (N=10 boundary), aggregate-not-edges
  assertion, `includeAmbiguous` surfacing unchanged.
- Live check rides the Wave-2 reindex: dnd_helpers rows gone = DEFECT-1 finally
  live-confirmed (bead `ckjfz`).
