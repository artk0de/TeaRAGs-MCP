# Step 6: GENERATE — RED → GREEN → REFACTOR — data-driven-generation

Loaded by `SKILL.md` Step 6.

### 6a RED

Invoke `/test-first` with mode (Step 0) + change kind (CREATE/EXTEND, MODIFY
behaviour, refactor/move, bug fix). Behaviour source: spec / plan acceptance
criteria or test code verbatim when present, else one test per behaviour of the
task. Output = `RED` block: per-test failure reason (assertion / missing
behaviour — never import, compile, syntax, missing fixture) + baseline. **No
production edit without a recorded RED block** (or its one-line named
exception). MODIFY / bug fix / refactor-move: `tests-at-risk` pins + target's
own tests run GREEN BEFORE the first edit or move. Bug fix → then a reproduction
test asserting the reported correct output, run RED on that assertion, only then
patch. Refactor / move → no new test; the green baseline is the invariant
through 6b–6c and re-runs after the move, none edited.

### 6b GREEN

Minimal implementation that turns every RED test green and keeps every baseline
pin green.

Apply strategy + style + reuse manifest — call manifest helpers, NEVER
reimplement them. MODIFY: minimal diff per strategy.

Failing test → fix the CODE. Never edit a test to pass: business-logic tests are
immutable. Test genuinely wrong (contradicts spec) → report test + spec line to
the user, do not change it silently. Only a `PIN-UPDATED` pin from 6a changes,
and only there.

MODIFY, before the first edit:
`find_co_changed(project=<alias>, path=<your working directory>, files: [target])`
on the target file (registered when codegraph is on). Silent partners —
`structurallyLinked: false` — with `strength >= 0.5`, top 5: check whether the
change belongs in them too. Context, not a requirement — never expand the diff
on co-change alone.

Names come from the Step 5 vocabulary, built by the dominant shape. A word
outside it is `NEW_TERM` and gets one line in the output:
`NEW_TERM <term> — <why no project term denotes this>`.

**Pre-write simulation** (codegraph on) — ONLY task moves / merges / splits
existing files: bad move undone = every importer re-touched, judge first. Else —
in-file edit, new file, new import, cross-component edge — skip, zero calls:
Step 7 gate catches same detectors after write, repair = one edge.

- Planned change = ONE `get_architecture_report(path, restructure: [...])`
  hypothesis: `move{files,toComponent}`, `merge{components}`,
  `split{component,groups}` (+ `addEdge` / `removeEdge` per import move
  retargets). Delta `introduced` non-empty → other placement per
  `../../../repair/<family>.md` `## Ops recipe` (absent → `## Apply remedy`;
  that family only), re-simulate; output
  `SIM restructure: introduced=<n> → <placement from ## Ops recipe> → re-simulated introduced=0`.
  Move when `introduced` empty, or each left entry meets Step 7 evidence rules.
  Edge ops move structural detectors only — co-change families answer at Step 7
  gate.
- **Multi-step restructuring** (several remedies, order matters) →
  `/refactoring-planning`, not this step.

### 6c REFACTOR

Clean up under green: duplication, names, extraction. Re-run RED tests +
baseline after each refactor edit; any red → undo that edit. Then Step 7.
