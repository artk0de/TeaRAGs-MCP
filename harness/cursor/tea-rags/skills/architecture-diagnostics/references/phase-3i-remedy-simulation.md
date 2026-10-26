# Phase 3i — REMEDY SIMULATION — architecture-diagnostics

Loaded by `SKILL.md` Phase 3i.

Every recommendation that MOVES code (file move, layer-map move candidate, split
candidate, merge candidate, extraction into another component) gets simulated
before it is ranked. One `get_architecture_report` call per remedy,
`restructure` = that remedy alone (delta is joint — never batch rival remedies):

| Remedy                        | `restructure` op                                           |
| ----------------------------- | ---------------------------------------------------------- |
| move files X into component Y | `{move: {files: [X…], toComponent: Y}}`                    |
| A5 split candidate            | `{split: {component, groups: <candidate files[] as is>}}`  |
| A5 merge candidate / fold B→A | `{merge: {components: [A, B]}}` (later fold into first)    |
| combined plan step            | ops of ONE step in one call (≤ 20); each step its own call |

Names: components as findings spell them (`sourceComponent`, `component`,
`componentDir`), files repo-relative production paths — else typed error
(`INPUT_UNKNOWN_RESTRUCTURE_*`), fix the name, never drop the remedy.

Read `delta`: `net` (introduced − resolved; negative = removes violations),
`byFamily`, `introduced` / `resolved` subjects (capped by `limit`, counts
whole). Rank remedies by `net`, then fewest `introduced` of tier
critical/active. Remedy with `introducedCount > 0` → name what it introduces
next to what it resolves; never present it as pure win. `net ≥ 0` → not a remedy
for these detectors, say so. Moved file's file-keyed findings match their base
path (persist, not resolved+introduced); split groups appear as
`<component>~split<k>`. `unavailable: "noCodegraph"` → simulation not run, rank
unsimulated.

Output row per remedy:
`| # | Remedy | ops | net | resolved (by family) | introduced (subjects) |`.

Several remedies, order matters, or plan wanted → `/refactoring-planning`
(edge-op recipes + `restructurePlan` ordering + plan Tasks).
