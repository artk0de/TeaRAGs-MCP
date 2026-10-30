# Phase 3d2 — HUB-LIKE DEPENDENCY — architecture-diagnostics

Loaded by `SKILL.md` Phase 3d2.

`violations.hubLikeDependency`, SAME components as SDP. Hub = Ca AND Ce both
past adaptive cut AND balanced (|Ca − Ce| / (Ca + Ce) < 1/4, Arcan) — many
depend on it, it depends on many. I near 0.5 → SDP silent, main sequence may
read healthy. Ce counts edges to non-foundation components; edges into contracts
are not efferent coupling. Ce cut drawn over Ce > 0 components only (leaves
never depress it). Fix direction: split by dependent cluster (`topDependents`)
or by dependency cluster (`topDependencies`).

| Summary field (`summary.hubLikeDependency`) | Read as                                                                                                                                                        |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `afferent` / `efferent`                     | per-axis cut: count > `median` AND ≥ `threshold`; `otsu` = log-scale cut (η ≥ 0.8), `median` = floor alone (few judged OR not bimodal, η reported if computed) |
| `judgedComponentCount`                      | components with Ca + Ce ≥ `minConnectionCount` — population both cuts drawn over; most below floor → median of few busy ones decides                           |
| `excluded.imbalanced`                       | busy on both axes but lopsided (I outside 0.375..0.625) — an SDP / main-sequence end, read there, not a hub                                                    |
| `churnSignal`                               | present = `evidence.churn` attached (`git.file.commitCount` mean per file); absent = no git data or no hub                                                     |

Evidence per line: Ca/Ce, `instability`, `dependentComponentCount` /
`dependencyComponentCount`, top-5 each side (`fileEdgeCount`, `callWeight`),
`transitiveImpact` (components reaching hub transitively), `churn`.
`compositionRoot: true` = declared composition root — wiring many to many is its
job; `compositionTable: true` = the hub holds a registration / routing table;
`parentSurface: true` = the hub is its parent's surface onto the parent's
internals. Triage data, never suppression.
