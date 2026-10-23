# Phase 3e — LAYERING — architecture-diagnostics

Loaded by `SKILL.md` Phase 3e.

No declared architecture needed: SCC condensation of the DOMAIN graph — every
facade directory is a unit, adoption notwithstanding (a vertical with an
unadopted facade counts ONCE, not once per subdirectory; a Go package too).
Longest-path levels: `level` = longest path from sinks (0 = foundation); `depth`
= longest path from roots (0 = nothing depends on it). Component with no
layering edge sits at level 0, depth 0.

| Summary field (`summary.layering`) | Read as                                                                                                              |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `levelCount`                       | distinct levels, 0-based; 0 = no layering edge at all                                                                |
| `coverage`                         | share of components outside multi-component knots — low = knot(s) dominate                                           |
| `coherence`                        | rank correlation level vs instability — high = low layers really are the stable ones                                 |
| `foundation`                       | `{components, terminalComponents?}` — L0 components with measured abstractness 1 (≥5 types); absent = none qualifies |
| `violationCount`                   | knots + backEdges + abstractionBypasses only — the layering debt                                                     |
| `informationalCount`               | compositionCycles + islands — findings, never debt                                                                   |

Violations first, informational last, in `violations` order:

| `kind`              | Meaning                                                                                                  | Read as                                                                                                                                                                                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knot`              | multi-component SCC — a cycle ACROSS directories                                                         | ranked by `instabilitySpread` (max−min member instability; > 0 = an SDP break INSIDE the cycle, 0 = a tangle of alike members); `feedbackArcSet` = lightest cut that levels the members (`cutEdgeCount`, `levelsAfterCut` = distinct levels once cut)      |
| `backEdge`          | minority-weight direction inside a knot pair                                                             | `callWeight` vs `counterFlowWeight` — unequal weights decide; equal never judged; `fileEdges` name where                                                                                                                                                   |
| `abstractionBypass` | consumer imports concrete component's type whose direct supertype lives in measured-abstract one beneath | `bypassedComponent`, `concreteAbstractness` / `bypassedAbstractness`, `implementedBy` (consumer file → implementer type/file → abstraction type/file); census-gated (≥5 types), same-knot pairs never judged; consumer subclassing implementer = no bypass |
| `compositionCycle`  | parent ↔ own nested directories cycling                                                                  | informational — `nestedPairs`; composition of a module with its sub-parts                                                                                                                                                                                  |
| `island`            | nothing depends on it AND it does not reach the top of the stack                                         | informational — `height`/`depth`, `afferentCount: 0`                                                                                                                                                                                                       |
