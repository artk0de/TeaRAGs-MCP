# Architecture report — reading get_architecture_report

Call contract (params, modes, paging) = tool schema. This guide = how to read
the answer. Diagnosis, not prescription.

Use only for an explicit architecture diagnostic/audit request, explicit
`architecture-diagnostics` invocation or structural refactoring. Never call the
report to gather context for code overviews, behavior/contract questions or
routine implementation. Relevant source bodies and targeted edges answer those.

## Shape

- Typed violations, per-line evidence, per detector;
  scripts/spikes/benchmarks/examples/fixtures excluded.
- `violations` = one table per detector; group-wide drillDown hint in
  `violationDrillDownHints`. Evidence arrays cut to `evidenceLimit`, full length
  in `<key>Count`, `evidenceTrimmed` + `next` per cut group.
- Summary counts exclusions with named reasons.

## Impact tier

Tiered: stableDependencies, leakingAbstraction, norms, layering
backEdge/knot/abstractionBypass. Others untiered
(`summary.impactTiers.notApplicable`).

- structural = no carrying file edge co-changes beyond chance.
- active = ≥1 carrying edge pair admitted by silentCoupling's co-change gate
  (full family; test/generated/docs/version-manifest pairs never count).
- critical = active AND an admitted edge's source has transitive-dependent share
  ≥ reach cut (Otsu over per-file dependents, median floor; method majority =
  fallback).
- `tierEvidence` = admitted/total carrier pairs over FULL edge list, ≤3 pairs,
  `sourceReach`. rootCause tier = max of members.
- `summary.impactTiers` = counts per detector, `reachCut`,
  `cochangeSignificance`; `built: false` = no co-change history, no tier (not
  structural).

## Ordering and cost

- Each family ordered tier first (critical > active > structural > untiered),
  then maintenanceCost, BEFORE limit. Each detector's violations (shotgunSurgery
  excepted) ranked costliest-first within tier by maintenanceCost.
- File cost = churn·(1+bugFix+recency)/3, each signal = file's position in
  collection's own git.file distribution (commitCount, bugFixRate, ageDays
  inverted); `costPosition` = cost's mid-rank among all files.
- Carriers = files on the edges that make the violation (named files; all file
  edges of a component edge or knot cut; hub's boundary files; zone-of-pain's
  depended-on files; island/uselessness = all its files).
- `score` 0–1 = carriers' meanPosition shrunk to 0.5 by n/(n+n0), n = measured
  carriers, n0 = (1/12)/between-violation variance over whole report, measured
  around null mean 0.5 (empirical Bayes; all 0.5 when means sit no further from
  0.5 than noise) — few carriers pulled to 0.5, many keep their mean, comparable
  across families.
- `hottestFile` = costliest carrier with raw readings; absent = no git readings,
  detector order kept.

## Detectors

**stableDependencies** (Stable Dependencies Principle): stable COMPONENT
depending on less stable one. Component = facade directory (any adoption), else
directory. Evidence = instabilities, Ca/Ce, delta, carrying file edges;
dependency on nested component not judged. rootCauses by unstable target
component; `cycleWithDependents` = target depends on own dependents.

**leakingAbstraction**: import past a module facade (`index.ts` / `__init__.py`
/ `mod.rs`) its importers adopted (≥3 importers, adoption >0.5 and ≥ adaptive
cut — Otsu when adoptions split bimodally, else floor; summary gives threshold,
method, separability). Kinds: bypass = facade re-exports what import takes (by
imported names when indexed, else target file); internal-reach = it does not
(`nonExportedNames`); conventionPrivacy = Python `_name` used from other package
or Ruby `send(:private)` from outside its class. Evidence carries
`origin: "model"`, `model`, `p` only when a residual model verdict produced the
edge — verdict with probability p, not static fact. rootCauses per module.

**silentCoupling**: file pair co-changing strongly in git history with no
import/re-export/resolved call between them (support, P(B|A), P(A|B), lift,
strength = Wilson lower bound, sample commits, structuralVisibility).

- Pair judged only when it beats configuration null n_p·n_q·Qs/M² (Poisson tail,
  BH q=0.05 over all pairs of files changed in ≥2 bundles;
  `summary.silentCoupling.cochangeSignificance`, `excluded.notSignificant`) —
  hub files (locales, version manifests) die there.
- strong = >0.5 and ≥ adaptive cut (Otsu when strengths split bimodally, else
  floor).
- Strong pair sharing a neighbour unlikely by chance given both import counts
  (hypergeometric, BH q=0.05;
  `summary.silentCoupling.sharedNeighbourSignificance`) = explainedPairs, not
  violation (count by default; list via `includeExplainedPairs`).
- rootCauses = file with ≥2 silent partners.
- Pairs sharing an endpoint list as ONE `kind: group` finding (greedy, most
  pairs first): `partners[]` = every pair (support, expectedSupport = null λ,
  strength), `evidence.topPartners` = 3 strongest, `evidence.drillDown` = ready
  find_co_changed call. limit caps findings; `violationCount` stays pairs,
  `groupedFindingCount` = findings.
- `summary.silentCoupling.built: false` = no co-change build, not clean.

**splitMerge**: component partition vs history over same sub-graph.

- splitCandidate = one component whose stored internal pairs cluster ≥2 groups,
  largestWeightShare < 0.7 (cohesion's cut), files = per-cluster exemplars (≤8).
- mergeCandidate = two components whose admitted bundles overlap (support =
  bundles touching both, changesA/B = bundles touching each, strength = Wilson
  lower bound of support/changes, same >0.5 + Otsu cut, ONE draw over
  internal-pair and component-pair strengths).
- excluded counts `unpartitionedEndpoints` / `crossComponentPairs`.
- `summary.splitMerge.built: false` = no co-change build or no persisted bundle
  membership (pre-042 index), not clean.

**shotgunSurgery**: one change (author burst) spanning ≥k components (k = Otsu
over burst widths, ≥3), recurring beyond a component-level configuration null
(fitted inclusion propensity, Poisson tail, BH q=0.05), components in ≥2
structural islands (no dependency, chain a→x→b with x touched by a genuine
supporting change (`summary.chainExplainedCount`), specific shared neighbour, or
feature subtree of ≤ T changed components).

- History cleaning: commits whose per-file (added, deleted) counts repeat beyond
  chance (mechanical sweep, BH) left out; revert or flag removal mirroring an
  earlier commit's per-file net lines (permutation test, BH) joins it as one
  change; later commit retiring exactly lines an earlier one added (net −x for
  +x on shared files; null = max(corpus revisit rate, file's own rate),
  Poisson-binomial, BH) joins it too; change whose files go net-negative beyond
  corpus rate (binomial, BH) counts as support only when it is the spread's
  oldest — spreads left under 2 genuine changes retired
  (`summary.retiredSpreadCount`; neither violation nor explained).
- Evidence: support, expectedSupport, strength (cohesion, not severity),
  familyEvidence = −log10 p − log10 C(n2,m) (list order; cost tags only),
  islands, exemplarFiles, drillDown = find_co_changed.
- Findings maximal — one inside another rides in its `evidence.nested`
  (`summary.nestedFindingCount`).
- Summary `mechanicalCommitCount` / `echoPairCount` / `lifecyclePairCount` /
  `retiredSpreadCount` absent = line counts or commit timestamps not recorded;
  `renameSweepCommitCount` = identifier-rename sweeps dropped, absent = not
  assessed; `built: false` = same reasons as splitMerge.

**mainSequence** (Stable Abstractions Principle): component far from A+I=1 —
pain = stable+concrete, uselessness = unstable+abstract. A from walker type
census, D > max(0.5, Otsu cut). Components whose language rarely declares
abstractions excluded (`unobservableAbstractness`); census needs codegraph
recompute. Pain also needs volatility (mean git.file.commitCount per file >
max(median file, log-scale Otsu cut)), calm ones counted as
`stableConcreteCalm`. Evidence `entryPoint: true` = component holds a facade
nothing imports (an entry) — distance is placement, not defect (triage data,
never suppression).

**hubLikeDependency**: component with BOTH Ca and Ce above adaptive cuts (per
axis: > median and ≥ log-scale Otsu cut when bimodal; Ca+Ce floor as SDP) AND
balanced (|Ca−Ce|/(Ca+Ce) < 1/4, Arcan; lopsided = `excluded.imbalanced`) — I
near 0.5, so SDP misses it. Ce skips edges into layering foundation
(`summary.layering.foundation`), Ce cut over Ce>0 components. Evidence = top
dependents/dependencies, transitiveImpact (components reaching it), churn (mean
git.file.commitCount); `compositionRoot` / `compositionTable` /
`parentSurface: true` = triage data.

**summary.propagationCost** (aggregate, no violations; MacCormack DSM):
reachable file pairs / N² = mean share of system one change reaches.
corePeriphery classes files by visibility fan-in/out cuts (Otsu, else median) —
core = high both AND in a cycle, shared = in only, control = out only; shape =
indeterminate when either cut fell back to median (no evidence of a split either
way), else corePeriphery when core > 0, else hierarchical. Components (top limit
by meanReach) carry internal propagationCost.

**layering**: inferred layers without a declared architecture — SCC-condensed
DOMAIN graph (every facade directory is a unit, adoption notwithstanding — a
vertical with an unadopted facade counts once, not once per subdirectory — same
partition SDP, mainSequence, hubLike and shotgun judge), levels by longest path
(L0 = foundation), per-knot greedy weighted feedback arc set (cut these N edges
→ k levels).

- knot lists top-20 members by Ca + memberCount, top-10 cut edges by weight +
  `cutEdgeCount` total; `evidence.drillDown` names the knotOf handle.
- knotOf answer = that knot (members with I/Ca/Ce, cut edges with keepCost —
  `recollapsedMemberCount` 0 = needless cut, paged) plus only the findings
  inside it on offset 0, not the project report (summary stays whole-project).
- Violations: knot (ranked by member-instability spread — spread > 0 is an SDP
  break inside the cycle) / backEdge (minority-weight direction, equal weights
  never guessed) / abstractionBypass (consumer imports a measured-concrete
  component's type whose direct supertype is declared in a measured-abstract one
  beneath; `evidence.implementedBy` names consumer file, implementer,
  abstraction).
- Informational: compositionCycle / island (nothing depends on it, below the
  top).
- `summary.layering` (foundation = abstractness-1 L0 components): coverage,
  levelCount, coherence (rank correlation level vs instability).

## Options

- **layerMap**: map VIEW — levels per node in scopePathPattern (file|directory
  granularity, directoryDepth collapse), boundary edges with the outside
  component's global level, move candidates; absent unless asked.
- **domain**: judge one directory AS ITS OWN SYSTEM (induced sub-graph, every
  metric recomputed inside — unlike pathPattern which filters findings only);
  `response.domain` carries its layering counts + border edges naming the
  external component and its whole-graph level.
- **norms**: project's own dependency precedents per (roleSrc, roleDst,
  locality) from primary-type roles, one ledger per language family
  (cross-family edges unjudged). norms violations flag MISFIT edges: against
  their role pair's established direction (exact sign test of n(A→B) vs n(B→A),
  BH q=0.05 over the pairs; evidence = both counts, p, established direction).

## Modes

- **plannedEdges**: judge edges BEFORE writing them vs indexed graph's norms,
  detectors not run (`detectorFamilies` notRun). Per edge:
  - CONFORMS
  - MISFIT — `expectedPath.established` = reverse direction + support; transit =
    roles via third role, both legs established
  - NEW_PATTERN — pair nobody wrote, no established direction; transit when one
    exists
  - UNJUDGED — reason newFile, nonProduction, untypedFile, weakRole + weakSide
    source|target|both, crossLanguage, inheritance, constantReference,
    displacedRole, noCodegraph

  `exclusionsUnchecked` = classes no call data can check yet.

- **restructure**: what-if `move{files,toComponent}` |
  `merge{components; later fold into first}` | `split{component,groups}`,
  applied in order (a later op may name what an earlier one produced); full
  detectors on base vs relabelled facts, delta by violation key:
  introduced/resolved subjects, counts, net, byFamily. Edge ops
  `addFile{file,component?,abstract?}` | `addEdge{from,to}` |
  `removeEdge{from,to}` (base paths) move structural detectors only; co-change
  detectors read history and do not respond. One hypothesis per call.
- **restructurePlan**: greedy ordered plan over candidate hypotheses
  `{id,rationale?,ops}` (+ report split/merge candidates); per round judges
  prefix+candidate, picks by net critical > active > structural > blast radius;
  trade-offs (introduce critical/active) never selected.

## Paging

Answer's `reportId` + limit/offset re-cuts the held judgement (8 reports, ~10
min, MCP server memory). Evicted, expired, other scope or tree counts moved →
`empty.reason` reportStale, re-call without reportId.
