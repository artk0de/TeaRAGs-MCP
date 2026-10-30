# Phase 3h — DIFF-TIME FINDINGS — architecture-diagnostics

Loaded by `SKILL.md` Phase 3h.

Applies to `review_changes` architecture findings (families
`stableDependencies`, `leakingAbstraction`, `cycles`, `mainSequence`,
`silentCoupling`, `facadeContract`, `splitCandidates`, `layeringBackEdge`,
`hubLike`) — not to the whole-repo report. Read per finding:

| Field                                                                                          | Read as                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `preExisting: true`                                                                            | held before the diff (meaning per family: Top Anti-patterns) — absent = the diff introduced it                                                                                                                                                                                                                                                                                     |
| `remedy`                                                                                       | cheap repair, dry-run-verified: `retargetImport` (`sourceRelPath`, `fromRelPath` → `toRelPath`, `importedNames`, optional `addExport`) or `restoreExport` (`facadeRelPath`, `names`)                                                                                                                                                                                               |
| `compositionRoot` / `compositionTable` / `parentSurface` / `entryPoint` / `foundationTerminal` | detector flags — evidence a finding stays unfixed; triage data, never suppression. `compositionTable` = carried by registration / routing tables (callWeight-0 wiring to more components than a geometric null fitted to the corpus admits, BH at q 0.05, `summary.*.compositionTableCut`); `parentSurface` = the source / hub is its parent's surface onto the parent's internals |

Classes (same triage as `$data-driven-generation` Step 7 "Fix-at-write loop" —
do not restate it):

- no `preExisting` → introduced: recommend the repair in this change.
- `preExisting` + `remedy` → cheap: quote the `remedy` in the recommendation.
- `preExisting`, no `remedy` → report-only line, no fix (`mainSequence`:
  `distanceBefore` already past threshold); `review_changes` counts these in
  `change.persisting`, not in findings.
- `change.nonLocal` → introduced away from the diff: recommend repair like
  introduced.

Recommendation loads `../../../repair/<family>.md` ONLY for families present
among the findings (`## Apply remedy` when `remedy` exists, else `## No remedy`;
`## Known false positives` before accepting). Never preload the directory.

Evidence rule: for each must-fix finding, check its detector flags (table above;
`compositionRoot` exempts hub-like) and the family's `## Known false positives`
entries. It stays unfixed ONLY with such a flag quoted from the finding, a
matching named entry with its evidence, or a cited project rule (file + quoted
line). Bare "by design" is never evidence. End every must-fix line with the
exact exemption sentence from `SKILL.md`. A family with `built: false` = "not
judged", never a clean pass.
