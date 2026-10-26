# Review — reading review_changes

Call contract (changes.base, files, sections allowlist) = tool schema. This
guide = how to read each section of the answer. Impact tier, maintenanceCost,
hub cuts, norm ledgers = same as `tea-rags://guide/architecture`.

## Envelope

`workTree`, `base`, `mergeBase`, `changedFiles`, `indexLag`, `notices` (an empty
diff names the trees and bases it did not look at). A section NOT requested is
OMITTED from the map; a requested one whose substrate is missing answers
`built: false` + reason — absence is not not-built.

## naming

Verdicts on every declaration the change adds, judged against project vocabulary
— the complete list. Never hand-list a diff's names into get_naming_lexicon.

## incompleteChange

Co-change partners of the diff's files the diff does NOT touch.

- Findings pass the co-change significance gate (Poisson test vs configuration
  null n_p·n_q·Qs/M², BH q=0.05 over every pair touching the diff, history minus
  the diff's own commits; summary `cochangeSignificance` + `notSignificant`),
  then Wilson strength and the majority-floored Otsu cut over the corpus.
- partnerKind test-first; generated + version manifests excluded
  (`versionManifestPairs`); structurallyLinked ranks above history-only; cap 50.
- Missing test partner whose source a touched test has as SUBJECT (top scope's
  leading identifier = a symbol the source declares, and it imports the source,
  read from the working tree) = `coveredPartners` note naming that test, not a
  finding.

## cohesion

Per changed file: symbol co-change clusters + split candidates. File with no
data = notJudged `noCohesionData`, never zero (cap 50 reports).

## architecture

Findings in hand (deciding fix / report-only) → `tea-rags:architecture-diagnostics`
Phase 3h: load `repair/<family>.md` of every family present, one class line per
finding — no `preExisting` = introduced, must-fix (exempt only by
`compositionRoot` flag / Known-false-positive entry, never bare "by design");
`preExisting` + `remedy` = cheap fix; `preExisting`, no remedy = report-only.

The diff's added edges judged by the boundary detectors: stableDependencies,
leakingAbstraction, cycles, mainSequence delta, silentCoupling, facadeContract,
layeringBackEdge (added edge from lower inferred level up; evidence levels +
`closesKnot`; parent→own subdir never), hubLike (added edges carry component
past get_architecture_report's hub cuts; Ca/Ce before+after; Ce excludes
foundation edges).

- Finding = endpoints (typed by kind, get_architecture_report's endpoint
  fields), structured evidence, subject (endpoints as text), detail, optional
  `remedy` (dry-run-verified edge fix: retargetImport [+addExport] |
  restoreExport; absent = no cheap fix).
- Each family ranked costliest-first before the cap by maintenanceCost
  (get_architecture_report's shrunken mean over the files the finding names, n0
  estimated over this review's findings; <2 measured = 0.5; absent = no git
  readings).
- Findings cap 100, family-aware — every family keeps ≥1 slot; per-family
  `truncated` rides each detector row; `findingCount` stays the family's FULL
  total; rows reconcile findingCount = listed + truncated + persistingCount.
- findings = what the change INTRODUCED + any finding carrying a remedy. Rest
  collapse into `change`:
  - `introducedCount`
  - `nonLocal` — introduced violations no listed finding carries = effect away
    from the diff (e.g. SDP between untouched components) — triage like findings
  - `resolved`
  - `persisting` — `{family, subject}`, no evidence — not the change's
  - `indexLag?`
  - `maybeAlreadyCommitted` — index lacks the merge-base: introduced may hold
    already-committed edits
- Full detector set judged on index vs index+tree edges, keyed by endpoints,
  renames canonicalized. silentCoupling, shotgunSurgery, norms read git/type
  history no edge overlay moves; splitCandidates merge verdicts too = persisting
  by construction.
- `tier` (impact tier: structural | active | critical) rides findings and change
  entries — introduced = overlaid run's, else base run's; absent = family
  untierable or no co-change history; pairs touching the diff judged without the
  diff's own commits.
- `change.touchedActive` (`{family, subject, tier}`) = persisting
  active/critical violations the diff touches (finding names it or changed file
  on a carrying edge) — lifted out of persisting (lifted finding stays in its
  row's persistingCount): edit lands on a live cascade.
- Detector-row exclusions: mainSequence `excludedLowConnectionCount` (small-N
  components below connection floor), `excludedFlapCount` (|ΔD| ≤ 0.02 moves,
  not findings), `excludedBelowThresholdCount` (rises ending ≤ served
  distanceThreshold); silentCoupling `excluded` block (production taxonomy's
  counters). Zero over excluded classes is not a clean pass.
- silentCoupling pairs sharing an endpoint list as ONE finding (`partners[]` =
  every pair, `evidence.topPartners` = 3 strongest with expected support λ,
  drillDown = ready find_co_changed call) — row's `findingCount` counts pairs,
  `groupedFindingCount` the findings (= listed + truncated).
- Flags: `foundationTerminal: true` on a D-delta finding = every contributing
  edge ends in an abstract L0 foundation. `entryPoint: true` = touched component
  holds a facade nothing imports (an entry) — placement, not defect.
  `preExisting: true` on cycles/leakingAbstraction = index already holds that
  edge — diff touches a file on it, did not add it; on layeringBackEdge =
  another edge already carried the component pair; on hubLike = already a hub
  before (listed only with a remedy, else in `change.persisting`).

## norms

Each file edge the change ADDS (absent at merge-base) judged by
get_architecture_report's dependency-norm ledgers over the INDEXED graph
(change's own edges never precedent).

- MISFIT = against role pair's established direction; `expectedPath` = that
  direction + support.
- CONFORMS.
- NEW_PATTERN = pair with no history.
- UNJUDGED + reason (notIndexed = new file, untypedRole, weakRole + weakSide
  source|target|both, crossLanguage).
- `exclusionsUnchecked` = report exclusion classes not evaluated (no call data
  on added edges).
- MISFIT first, cap 100 + truncated; `verdictCounts` + `unjudgedReasonCounts`
  pre-cap; `removedEdgeCount` count only; test/tooling edges =
  `nonProductionEdgeCount`.
