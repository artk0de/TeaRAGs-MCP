# Phase 3c2 — SHOTGUN SURGERY — architecture-diagnostics

Loaded by `SKILL.md` Phase 3c2.

`detector: "shotgunSurgery"`, SAME components as SDP. ONE logical change
reaching into ≥ k components, spread recurring beyond chance, components in ≥ 2
structural islands. Logical change = commits joined by shared task id (commit
message) ONLY, across bursts; else one commit. Umbrella/epic ids (breadth =
distinct ids on their commits above a Tukey fence) join nothing. Shared files
and dependency edges never join (hub files chain whole bursts). Support =
distinct changes where ONE change held all k; changes sharing a burst once.
Burst union never unit (parallel sessions chain unrelated commits). Each change
weighs 1 up to typical width T, C(T,k)/C(w,k) beyond — sweeps say ~nothing about
one triple; null = same weighted count. Silent coupling's N-way sibling: pair =
file level, MERGE = two components, this = one change's fan-out. Never filtered
by file type or hub size. Knot mode omits it. Mechanical commits (per-file
(added, deleted) counts repeating beyond chance — rename/import/flag sweep, BH)
dropped from whole history: degrees, units, umbrella breadth. Echoes (revert /
flag removal mirroring earlier commit's per-file net lines, permutation test,
BH) join original as one change — never zeroed. Retiring change (files
net-negative beyond corpus rate — flag/dead-code removal; binomial, BH) counts
as support only when spread's OLDEST; spread left < 2 genuine changes = RETIRED:
neither violation nor explained. Chain join: members a, b join when a → x → b
(or b → x → a) and x touched by a genuine supporting change — change walked a
render/call chain, edited the link. Common dependency / common dependent is NO
chain (shared dependency = the shotgun mechanism).

List order = `familyEvidence` desc, most surprising first; `limit` cuts THAT
order. `maintenanceCost` rides along as a tag only — carrier cost ranked gold no
better than chance. `strength` = cohesion (max for members never changed outside
the spread, e.g. a page and the panels born with it) — NOT severity; never
re-rank by it.

| Summary field (`summary.shotgunSurgery`)             | Read as                                                                                                                                                                                                                   |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `built`                                              | `false` = no co-change build / no bundle membership (`reason`, same as splitMerge) → NOT judged, never report "none"                                                                                                      |
| `widthThreshold` / `widthThresholdMethod`            | k = narrowest spread judged; `otsu` = majority-floored Otsu over per-commit widths, `floor` = 3 (never below 3)                                                                                                           |
| `burstCount`                                         | bursts touching a component through a non-mechanical commit — the null's degree unit                                                                                                                                      |
| `mechanicalTestedCount` / `mechanicalCommitCount`    | commits tested for line-count uniformity (BH family) / sweeps dropped from history. Absent = line counts not recorded (pre-migration index), not "no sweeps"                                                              |
| `echoCandidatePairCount` / `echoPairCount`           | wide commit pairs sharing ≥ 3 components (BH family) / echoes joined into one change. Absent = line counts not recorded (pre-migration index), not "no echoes"                                                            |
| `lifecycleCandidatePairCount` / `lifecyclePairCount` | wide commit pairs sharing ≥ 3 components (BH family, = echo's) / lifecycles (newer exactly retires lines older added) joined into one change. Absent = line counts or commit timestamps not recorded, not "no lifecycles" |
| `retirementTestedCount` / `retirementUnitCount`      | wide changes testable for retirement (BH family) / retiring changes (net-negative files beyond corpus rate). Absent = line counts or commit timestamps not recorded                                                       |
| `retiredSpreadCount`                                 | spreads left < 2 genuine changes once retiring support newer than another discounted — neither violation nor explained. Absent = same as above, not "none retired"                                                        |
| `unitCount` / `wideUnitCount`                        | logical-change component sets (same set sharing a burst once) / those spanning ≥ k — few wide = little evidence                                                                                                           |
| `umbrellaTaskIdCut` / `umbrellaTaskIdCount`          | breadth fence (distinct ids an id's commits carry) / ids above it, left out of the join                                                                                                                                   |
| `typicalChangeWidth`                                 | T: Tukey fence over change widths — wider changes weigh C(T,k)/C(w,k)                                                                                                                                                     |
| `familySize` / `q`                                   | BH family C(n, k): every set of exactly k components among n changed in ≥ 2 bursts; FDR q — multiple-testing price                                                                                                        |
| `candidateSetCount` / `admittedSetCount`             | k-sets wide commits of ≥ 2 bursts held whole (tested) / k-sets passing BH over the null                                                                                                                                   |
| `spreadCount`                                        | maximal spreads admitted k-sets merge into: closure = components EVERY holding commit touched; support = k-set's                                                                                                          |
| `explainedCount`                                     | spreads dropped: one island (dependency, chain through touched x, specific neighbour, or feature subtree ≤ T changed components) explains                                                                                 |
| `chainExplainedCount`                                | part of `explainedCount`: spreads ONLY a chain a → x → b (x touched by a genuine supporting change) joins — violations without it                                                                                         |
| `outOfScopeSetCount`                                 | scoped only: unexplained spreads with no exemplar file in `pathPattern`                                                                                                                                                   |

Evidence per line:

| Evidence                                          | Read as                                                                                                                       |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `support` / `weightedSupport` / `expectedSupport` | distinct changes holding whole spread / Σ their specificity weights / E[weighted] under the null; weighted ≫ expected = real  |
| `strength`                                        | Wilson lower bound of support over component changes — cohesion, not severity                                                 |
| `familyEvidence`                                  | −log10 p − log10 C(n₂, m): gate's tail bound at the spread's width m, charged for every m-set of the n₂ twice-changed; order  |
| `islands`                                         | connected groups (≥ 2; dependency, chain through touched x, specific neighbour, one feature subtree) — missing link goes here |
| `exemplarFiles`                                   | per component the file the holding commits touched most                                                                       |
| `carrierFiles`                                    | per component (aligned) files the holding changes touched, most-touched first (≤ 5) — recipe input                            |
| `sampleCommits`                                   | shas to cite — latest commit of each holding change, newest change first                                                      |
| `sampleChanges`                                   | per sample (aligned) every sha of that logical change — `git show` them to see what one change edited                         |
| `drillDown.hint`                                  | run verbatim (`find_co_changed`) for file-level partners                                                                      |

Explain EVERY reported spread before recommending (server judges recurrence, not
meaning — semantics is agent's job). Recipe, per spread:

1. Changed symbols: per component,
   `find_symbol(relativePath: <carrierFiles[i][0]>)` → outline; pick a member
   `sampleChanges[0]` edited (`git show <sha> -- <file>` when unclear);
   `find_symbol(symbol: <member>, metaOnly: true)` → its chunk `id` (row whose
   `relativePath` matches).
2. Cross-component similarity:
   `find_similar(positiveIds: [<id>], pathPattern: "{<B carrierFiles, comma-joined>}", limit: 3, metaOnly: true)`
   → cross score. Baseline: same call, `pathPattern` = A's OTHER carrier files →
   within score. Cross ≥ within = candidate duplicate; then `find_symbol` both
   top hits and READ them — same logic under different names confirms, same
   vocabulary only does not. Repeat per island pair.
3. Classify:

| Verdict                 | Evidence                                                                                                                                                   | Report as                                                                                      |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `duplicatedConcept`     | step 2 cross ≥ within AND reading confirms same logic, same role                                                                                           | TRUE shotgun — quote BOTH fragments (path:line); fix Move Method / Extract Module              |
| `featureSlice`          | no cross-component hit; components carry different architectural roles (`get_architecture_report` dependency-norms roles, or layer map levels)             | expected coupling of a vertical feature — deprioritise, no refactor                            |
| `crossLanguageContract` | components in different languages share field / key identifiers (`get_naming_lexicon` names[] per component, or `hybrid_search` on the shared identifiers) | real implicit contract — recommend shared schema / codegen; cite the identifiers on both sides |

No verdict fits → report raw with evidence, say "unexplained", never guess. Fix
direction (`duplicatedConcept`): one owner for the reason to change — collapse
the spread behind one module / contract; `islands` show where the missing link
would go.
