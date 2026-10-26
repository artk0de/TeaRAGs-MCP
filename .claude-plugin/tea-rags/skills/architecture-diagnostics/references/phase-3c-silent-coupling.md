# Phase 3c — SILENT COUPLING — architecture-diagnostics

Loaded by `SKILL.md` Phase 3c.

Pair of files changing together strongly, no import / re-export / resolved call
between them. Coupling lives in heads, not code: wire protocol + its two ends,
descriptor + implementation it describes, sibling files edited as set. History
from codegraph co-change sub-graph (git window, mass-change commits dropped).

| Summary field (`summary.silentCoupling`) | Read as                                                                                                              |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `built`                                  | `false` = no co-change build → not judged, stop here                                                                 |
| `build`                                  | provenance: `head`, window, `commitCount`, mass cut `maxFilesPerBundle`                                              |
| `strengthThreshold`                      | cut this codebase got; strength must ALSO be > 0.5                                                                   |
| `strengthThresholdMethod`                | `otsu` = split over candidate strengths; `majority` = too few candidates (< 8) or strengths not bimodal (η < 0.8)    |
| `strongLinkedCount`                      | strong pairs code DOES link — declared coupling, context for `violationCount`                                        |
| `sharedNeighbourSignificance`            | per-pair chance of sharing a neighbour given both import counts (hypergeometric), BH q; absent = no dependency edges |
| `explainedPairCount`                     | TOTAL pairs a specific shared neighbour explains — cite this number                                                  |
| `explainedPairs`                         | the pairs themselves, only with `includeExplainedPairs: true`; `evidence.explainedBy` names the neighbour            |

`rootCauses` with `detector: "silentCoupling"` = file with ≥ 2 silent partners:
`relPath`, `violationCount`, `maxStrength`, `partners`. Read first — hub of
hidden coupling.

Pair undirected: `sourceRelPath` = lexicographically smaller. Evidence per line:

| Evidence                           | Read as                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `strength`                         | 95% Wilson lower bound on P(other changes \| one changes), stronger direction    |
| `support`                          | author bursts touching both, once per burst — thin support = hedge               |
| `confidenceAB` / `confidenceBA`    | P(target \| source) / P(source \| target); asymmetric = one drags other          |
| `lift`                             | co-change over independence (evidence only — admission is the significance gate) |
| `sampleCommits`                    | shas to cite; show one to prove                                                  |
| `structuralVisibility: one-walked` | other file not walked code (config, data, script) — coupling to non-code         |
| `directoryRelation: disjoint`      | crosses module border — rank highest                                             |
| `expectedSupport`                  | λ the null predicts from both change counts; `support` ≫ λ = real pull           |

Grouped finding (`kind: "group"`): ≥ 2 pairs share one endpoint → ONE violation,
`relPath` = shared file, `partners[]` = every pair (`support`,
`expectedSupport`, `strength`), `evidence.topPartners` = 3 strongest. Greedy,
most pairs first; pair in exactly one group. Typical: locale / key-addressed
file vs every component reading its keys — implicit coupling through string
keys, one finding not N. Drill in: `violationDrillDownHints.silentCoupling` is a
template naming the row's fields, not values — call
`find_co_changed(path: "<your working directory>", files: <row evidence.drillDown.files>, limit: <row evidence.drillDown.limit>)`.
`partners[]` stays whole; nested evidence lists cut to `evidenceLimit` carry
`<key>Count` (full length). `violationCount` stays pairs; `groupedFindingCount`
= findings; `limit` caps findings. review_changes architecture section: same
grouping, `partners` / `drillDown` on finding.

Fix direction: make coupling explicit (shared contract / generated table / one
owner) OR merge. Type-only imports ARE graph edges (callWeight 0) on indexes
walked at walker ≥ 4 — a pair joined only by `import type` reads
structurallyLinked and does not surface; an index walked before that change may
still miss the edge, so check before claiming "no link".
