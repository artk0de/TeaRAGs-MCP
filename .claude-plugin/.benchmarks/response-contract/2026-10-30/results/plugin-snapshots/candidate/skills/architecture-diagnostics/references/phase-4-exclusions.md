# Phase 4 — EXCLUSIONS — architecture-diagnostics

Loaded by `SKILL.md` Phase 4.

`summary.stableDependencies.excluded` — edges read, NOT judged:

| Counter               | Unit      | Meaning                                                                    |
| --------------------- | --------- | -------------------------------------------------------------------------- |
| `intraComponent`      | file edge | both ends in one component — not a component dependency                    |
| `facadeAggregations`  | file edge | module facade re-exporting nested module's facade — aggregation            |
| `unwalkedEndpoints`   | file edge | endpoint never extracted by codegraph                                      |
| `containment`         | component | dependency on component nested inside source dir — composition, not peers  |
| `lowConnectionCount`  | component | an end's Ca+Ce below `minConnectionCount` — instability untrustworthy      |
| `outOfScopeEdgeCount` | component | no carrying file edge's source in `pathPattern` (present only when scoped) |

Reasons verbatim in `exclusionReasons`. Report them as "not judged", never as
"clean".

`summary.leakingAbstraction.excludedModules` — first three count modules NOT
judged; `intraParentConsumers` counts excluded importer pairs;
`deFactoSurfaceEdges` counts internal-reach edges spared because target child is
measured de-facto surface; `nestedEntryEdges` counts internal-reach edges into
exactly entry file of dir declaring own entry inside module — inner module's
facade edge, not outer leak (bypass still reported). Surfaces listed in
`summary.leakingAbstraction.deFactoSurfaces`
(`moduleDir, child, directImporterCount, backgroundRate, pValue`): child (first
path segment under module) importers reach directly far above module's
background deep rate — binomial + BH. Report as second surface module grew, not
leak; bypass into it still reported:

| Counter                | Meaning                                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `facadeNotAdopted`     | adoption ≤ 0.5 or below adaptive cut — importers don't use the facade                                                                                                            |
| `tooFewImporters`      | < 3 external importers — adoption untrustworthy                                                                                                                                  |
| `languageEnforced`     | Go package — compiler enforces boundary, nothing to leak                                                                                                                         |
| `intraParentConsumers` | importer inside module's PARENT dir component (parent holds entry file = assembly barrel) — sibling/assembly consumer, internal by two-seam model; counts consumers, not modules |

`summary.silentCoupling.excluded` — pairs read, NOT judged: `testEndpoints`,
`generatedEndpoints`, `documentationEndpoints`, `unwalkedEndpoints` (neither
file walked), `notSignificant` (support no more than the configuration null
predicts from the two files' change counts —
`summary.silentCoupling.cochangeSignificance` gives method, family, q,
familySize m, tested/admitted counts; a hub file that changes with everything
dies here), `explainedBySharedNeighbour` (both import a file, A→C→B, or a
registry consumes both — and sharing it is unlikely by chance given both files'
import counts; shared contract, not hidden coupling). A barrel / type-only /
object-literal module IS judged — its `import type` deps are edges, so a missing
edge is evidence.

`summary.mainSequence.excluded` — components NOT judged: `lowConnectionCount`
(SDP floor), `unmeasured` (no census — recompute), `fewTypes` (< `minTypeCount`
— A swings per type), `unobservableAbstractness` (expected abstract types < 1 at
language's share; reason in `exclusionReasons`). `stableConcreteCalm` is judged,
not skipped: stable + concrete past the D cut but calm (below the volatility
cut) — a settled utility, not pain; reason in `exclusionReasons`.
