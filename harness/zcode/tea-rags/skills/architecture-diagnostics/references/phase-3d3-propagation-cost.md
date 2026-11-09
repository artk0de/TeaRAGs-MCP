# Phase 3d3 — PROPAGATION COST — architecture-diagnostics

Loaded by `SKILL.md` Phase 3d3.

`summary.propagationCost` — aggregate, NO violations, never in rootCauses.
MacCormack DSM over SAME file graph: `propagationCost` = reachable file pairs /
N² = mean share of system one change reaches. Higher = change ripples further.
No fixed "good" value — compare across runs / components, not to a constant.

| Field                                          | Read as                                                                                                                                           |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `largestCycleSize`                             | biggest file cycle — cyclic mass behind high cost                                                                                                 |
| `corePeriphery.shape`                          | `indeterminate` = a visibility cut is `majority` (no split found); else `corePeriphery` = cyclic core exists; else `hierarchical`                 |
| `corePeriphery.counts`                         | core = high fan-in AND fan-out AND in cycle; shared = in only; control = out only; peripheral = neither                                           |
| `corePeriphery.acyclicHighVisibilityFileCount` | high both but in no cycle — hierarchy waist, not core                                                                                             |
| `visibilityFanIn` / `visibilityFanOut`         | per-axis cut: > median AND ≥ `threshold`; `majority` = median fallback (not bimodal / < 8 files)                                                  |
| `components[]`                                 | top `limit` by `meanReach` (share of system a change to its files reaches); `propagationCost` = its own internal closure density; `coreFileCount` |

Core-periphery shape + large `coreShare` = tangled core; fix through cycle
breaking (Phase 3e knots), not per-file.

`indeterminate` = visibility not bimodal on at least one axis (Otsu η under
gate, or < 8 files): data says nothing about core vs hierarchy. Do NOT report it
as either. State shape undecided, cite the `majority` axis and its
`separability`, read cost from `propagationCost` + `largestCycleSize` alone;
`counts.core` there is triage data, not a core verdict.
