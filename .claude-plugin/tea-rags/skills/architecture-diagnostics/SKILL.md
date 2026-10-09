---
name: architecture-diagnostics
description:
  Check if code laid out correctly — dependency direction, module borders,
  Stable Dependencies Principle violations, leaking abstractions (imports past
  an adopted facade), silent coupling (files changing together with no
  import/call between them), main-sequence distance (zone of pain / uselessness)
  hub-like dependencies (high Ca AND Ce) and the inferred layer stack
  (SCC-condensed levels, knots, back-edges, layer map, move candidates) with
  evidence per line, grouped into root causes. Use when asked "is architecture
  right", "layering violations", "layer map", "which layer", "levels", "move
  candidate", "wrong dependency direction", "SDP", "stable depends on unstable",
  "module borders", "facade bypass", "deep imports", "leaking abstraction",
  "hidden coupling", "change together", "shotgun surgery", "zone of pain", "main
  sequence", "abstractness", "hub-like dependency", "архитектурные нарушения" —
  NOT for risk/health of code (use risk-assessment), NOT for one failure (use
  bug-hunt), NOT for plain cycle listing (find_cycles).
argument-hint: "[scope — pathPattern, subsystem, or 'whole project']"
---

# Architecture Diagnostics

Question: laid out right? NOT: dangerous to touch? (→ risk-assessment).

## Phase Order (MANDATORY)

1. Phase 0 — GATE: codegraph on?
2. Phase 1 — REPORT: one `get_architecture_report` call
3. Phase 2 — ROOT CAUSES first (**never lead with flat violations**)
4. Phase 3 — residual violations, judged by evidence
5. Phase 3b — LEAKING ABSTRACTION (`detector: "leakingAbstraction"`)
6. Phase 3c — SILENT COUPLING (`detector: "silentCoupling"`)
   - Phase 3c2 — SHOTGUN SURGERY (`detector: "shotgunSurgery"`)
7. Phase 3d — MAIN SEQUENCE (`detector: "mainSequence"`), then 3d2 — HUB-LIKE
   DEPENDENCY (`detector: "hubLikeDependency"`)
8. Phase 3e — LAYERING (`detector: "layering"`)
9. Phase 3f — LAYER MAP (only when the request carried `layerMap`)
10. Phase 4 — EXCLUSIONS: say what not judged
11. Phase 5 — OUTPUT

## Top Anti-patterns

- **Reading flat `violations` first.** N violations into one target = ONE
  defect. Fix target, not N sources.
- **`edgeCount: 0` read as clean.** Nothing read ≠ no violations. No codegraph
  DB or empty graph — say so.
- **Ignoring `containment` / `lowConnectionCount`.** Excluded, not clean — see
  Phase 4.
- **Reading SDP as file-level.** SDP judged on COMPONENTS; file edges in
  `evidence.fileEdges` only show which files carry the dependency.
- **Using risk-assessment signals (churn, bugFixRate) here.** Other question.
  Combine only when user asks both. Exception: per-violation `maintenanceCost` —
  report's own fix PRIORITY, never verdict.
- **Proposing tolerance change.** Tolerance fixed, reported in
  `summary.stableDependencies.tolerance`. Not caller knob.
- **Prescribing a new module layout from leak lines.** Diagnosis, not
  prescription: a leak says importer walked past surface its peers use — not how
  module should be drawn.
- **Reading `facade-not-adopted` as a leak.** Nobody uses that facade → no
  boundary to leak past. Not judged, not clean.
- **`silentCoupling.built: false` read as clean.** No co-change build (git
  trajectory off, or no index run yet) — say "not built", never "no hidden
  coupling".
- **`mainSequence` judged 0 read as balanced.** `excluded.unmeasured` > 0 =
  index predates type census — say "needs codegraph recompute".
  `unobservableAbstractness` = language rarely declares abstractions (Ruby duck
  typing) — A 0 is idiom, not verdict.
- **`entryPoint: true` distance read as placement defect.** Declared cli/mcp
  entry surface — unstable end of main sequence is where it BELONGS; nothing
  imports it. Triage data, never suppression.
- **`preExisting: true` cycle / leak read as diff-introduced.** The index
  already holds that edge — the diff touches a file on it, did not add it. Still
  a real cycle / leak; triage data, never suppression.
- **`layerMap` expected in a bare report.** `response.layerMap` appears ONLY
  when the request carried `layerMap` — absent = not asked, never "no layers".
- **`island` / `layerSkip` / `compositionCycle` read as violations.**
  Informational findings — count separately, say informational.
- **`knot` with `composition: true` read as a defect.** Every edge joins a
  directory to one nested inside it — composition of a module with its own
  sub-parts, not a layering defect.
- **Map `scopePathPattern` confused with report `pathPattern`.** The report's
  scopes JUDGED edges by source; the map's picks map MEMBERS (induced subgraph).
  Independent — one, both, or neither.

## Rules

1. **Execute YOURSELF** — no subagents.
2. **No built-in Search/Grep** — tea-rags tools only.
3. **One report call per scope.** Narrow via `pathPattern`, not re-calls with
   bigger `limit`.

## Phase 0 — GATE

prime `## Enrichment` lists `codegraph.symbols`? No → tool not registered. Say
"architecture report needs codegraph", stop. NEVER claim "no violations".

## Phase 1 — REPORT

```text
get_architecture_report(path: "<your working directory>", pathPattern?: "<glob>", limit?: 50, norms?: true,
                        layerMap?: { scopePathPattern?, granularity?: "directory"|"file", directoryDepth? })
```

- `pathPattern` scopes JUDGED edges by SOURCE file (SDP: component dependency
  judged when ≥1 carrying file edge's source matches; silent coupling: by EITHER
  file of pair). Instability, facade adoption, strength cut always whole-graph —
  scoped run sees same numbers as full run.
- `norms: true` adds the dependency-norms view (bd rpx0v): the project's own
  precedents per (roleSrc, roleDst, locality), roles = each file's PRIMARY
  type's role (naming's type-role layer; suffix-only roles stay weak — never
  asserted). `response.norms` carries one ledger + direction test per language
  family + findings; `norms` violations flag every edge AGAINST its role pair's
  established direction (`misfit`, with `establishedDirection`). Absent flag =
  no norms block, no `norms` violations.
- `domain: "<dir>"` judges one directory AS ITS OWN SYSTEM (bd xb669.1): the
  induced sub-graph — files under the root, edges with both endpoints inside —
  and EVERY metric recomputed inside it. Not `pathPattern`, which keeps
  whole-graph metrics and only filters findings. `response.domain` carries
  `componentCount` / `levelCount` (the same numbers `summary.layering` holds)
  plus the border: `boundaryOut` / `boundaryIn`, aggregated per (inner,
  external) component, each naming the external component and its
  `externalLevel` on the WHOLE-graph stack — the one thing an internal view
  cannot recompute. Read `domain` first; the violations then describe the
  domain's own internals. Facade-aggregation edges never count as border.
- Tooling paths (scripts, spikes, benchmarks, examples, fixtures) removed before
  any detector — `summary.nonProduction` counts them.
- Test support removed too — file imported only by tests / other support AND
  evidence: named after test importing it (`X.spec.presets.tsx` ← `X.spec.tsx`;
  `worker.ts` ← `worker.test.ts` = reverse, no evidence), or imports test-only
  dep (package/file tests import, no production file does; or manifest dev-only
  — `devDependencies`, Gemfile `:development`/`:test` — tests import; never
  `node:*`), or imports other support. `summary.testSupport` counts files
  - `testOnlyDependencyCount`. Worker loaded by module path, importing only
    production deps → stays production. Fixture importing only production code,
    not named after its test → stays production (no evidence) — low count ≠ bug.
    Dev-tool file (codegen type, lint script) only a test imports + importing a
    devDependency → may count as support.
- `limit` caps `violations` + `rootCauses` PER DETECTOR; each
  `summary.<detector>` keeps totals (`violationCount`, `rootCauseCount`).
  Totals > returned → say truncated.
- Each detector's `violations` ranked costliest-first (before `limit`) by
  `maintenanceCost`. Carriers = files on edges that MAKE violation: named files;
  all file edges of component edge / knot cut; hub's boundary files;
  zone-of-pain's depended-on files; island / uselessness = all its files.
  `score` 0–1 = carriers' `meanPosition` (mean file `costPosition`) shrunk
  toward 0.5 by `n / (n + n₀)` — n = `measuredFileCount`, n₀ = (1/12) /
  between-violation variance over the WHOLE report, measured around the null
  mean 0.5 (empirical Bayes). A 1–2 file pair is pulled toward 0.5, a 7000-file
  knot keeps its mean, so scores compare ACROSS detectors; 0.5 = typical or
  unproven, all 0.5 = violations spread no more than noise. Use `meanPosition` +
  `measuredFileCount` for the raw reading. `hottestFile` = costliest carrier +
  churn/bugFix/recency positions + raw readings. Lead residual list with highest
  score. Absent = no git readings → detector order.
- Every finding carries `detector`: `stableDependencies` (Phases 2–3),
  `leakingAbstraction` (Phase 3b), `silentCoupling` (Phase 3c), `mainSequence`
  (Phase 3d), `hubLikeDependency` (Phase 3d2) or `layering` (Phase 3e). Never
  mix groups across detectors.

## Phase 2 — ROOT CAUSES

SDP unit = COMPONENT: module with measured facade (A4 active or not-adopted —
owns its directory subtree minus nested modules), else constant namespace path
spells (`componentKind: "namespace"`, `::Billing` — Zeitwerk autoload:
`app/models/billing/*` + `app/services/billing/*` = one), else plain directory.
Ca/Ce count distinct files across component border.

`rootCauses[]` ordered by `violationCount` desc, then `maxInstabilityDelta`.

| Field                 | Read as                                                       |
| --------------------- | ------------------------------------------------------------- |
| `targetComponent`     | unstable component stable components lean on                  |
| `violationCount`      | stable dependent components affected — severity               |
| `targetInstability`   | I = Ce/(Ca+Ce); high = depends on much, few depend on it      |
| `sources`             | the stable dependent components                               |
| `cycleWithDependents` | target depends on own dependents → instability self-inflicted |

`cycleWithDependents: true` = strongest finding. Base names its subclasses,
concern names its includers, registry names its entries. Fix: invert
back-reference (registry/lookup, DI, move knowledge to dependents) → every
violation of group disappears at once.

Confirm cycle (optional):
`find_cycles(scope: "file", pathPattern: "<target>/**")`; which files carry it:
`evidence.fileEdges` of the group's violations.

`cycleWithDependents: false`, count ≥ 3 → target too volatile for its role:
split stable core (what dependents use) from volatile rest.

## Phase 3 — RESIDUAL VIOLATIONS

Groups with `violationCount: 1`: judge each by `evidence`.

| Evidence                        | Weight                                                            |
| ------------------------------- | ----------------------------------------------------------------- |
| `directoryRelation: disjoint`   | crosses into sibling/cousin — the case borders are about; highest |
| `ancestor`                      | nested component reaching up into its parent; check direction     |
| `instabilityDelta`              | severity within the list                                          |
| `callWeight: 0`                 | type/const/re-export only — weaker coupling                       |
| `fileEdgeCount` 1               | one file carries it — cheap to move                               |
| Ca+Ce near `minConnectionCount` | thin support; instability can swing — flag as tentative           |

`evidence.fileEdges` (top 5 by call weight) = where to act.

## Phase 3b — LEAKING ABSTRACTION

Module = dir with entry file (`index.ts`/`index.tsx`/`index.js`, `__init__.py`,
`mod.rs`/`lib.rs`). Boundary judged ONLY where importers adopted facade: ≥3
external importers AND adoption > 0.5 AND adoption ≥ adaptive cut.

| Summary field (`summary.leakingAbstraction`) | Read as                                                                                                     |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `adoptionThreshold`                          | cut this codebase got; adoption must ALSO be > 0.5                                                          |
| `adoptionThresholdMethod`                    | `otsu` = split over module adoptions; `majority` = too few modules (< 8) or adoptions not bimodal (η < 0.8) |
| `adoptionSeparability`                       | η of the cut; near 1 = clean two-mode split. Present under `majority` too = the η that failed the gate      |
| `activeModules`                              | modules whose boundary is judged, with facade/deep importer counts                                          |
| `notAdoptedModules`                          | facade exists, importers ignore it — name, don't judge                                                      |

`rootCauses` with `detector: "leakingAbstraction"` = one per module:
`violationCount`, `bypassCount`, `internalReachCount`, `sources`. Read first.

| `kind`           | Meaning                                                               | Fix direction                                   |
| ---------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| `bypass`         | facade exposes all importer takes — importer could use facade, didn't | switch import to facade                         |
| `internal-reach` | facade does not expose it — importer reaches unoffered code           | export it via facade OR question the dependency |

Kind decided by NAMES when index recorded them (`evidence.importedNames`):
facade exposes = names it re-exports (`export {a} from`, `export *` = all;
`__init__.py` also exposes what it imports). Any name not exposed →
`internal-reach`, listed in `evidence.nonExportedNames`. No names on either edge
(pre-names index, side-effect import) → file rule: facade imports target =
`bypass`. `importedNames` absent → kind is file-level, say so.

Evidence per line: `moduleDir` (innermost active module leaked past),
`facadeRelPath`, `adoption`, facade/deep importer counts, `callWeight` (0 =
type/const-only import).

`kind: "conventionPrivacy"` — privacy compiler does not enforce, broken anyway.
Evidence `sourceSymbolId`, `targetSymbolId`, `rule`:

| `rule`              | Meaning                                                                    |
| ------------------- | -------------------------------------------------------------------------- |
| `python-underscore` | `_name` member (not dunder) called from other package directory            |
| `ruby-send-private` | `send`/`public_send`/`__send__(:name)` into private/protected, other class |

Counts: `summary.leakingAbstraction.conventionPrivacy` (`candidateEdgeCount`,
`violationsByRule`). No module root cause — list per symbol pair. Candidates
come from resolved method edges only: unresolved call → not judged.

## Phase 3c — SILENT COUPLING

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
| `sharedNeighbourThreshold`               | Otsu cut over pairs' best shared-neighbour weight ln(N / fanIn); `none` = off (< 8 weights, or not bimodal, η < 0.8) |
| `explainedPairs`                         | pairs a specific shared neighbour explains; `evidence.explainedBy` names it                                          |

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
keys, one finding not N. Drill in: run `evidence.drillDown.hint` verbatim
(`find_co_changed(files: [...], limit: N)`). `violationCount` stays pairs;
`groupedFindingCount` = findings; `limit` caps findings. review_changes
architecture section: same grouping, `partners` / `drillDown` on finding.

Fix direction: make coupling explicit (shared contract / generated table / one
owner) OR merge. Type-only imports ARE graph edges (callWeight 0) on indexes
walked at walker ≥ 4 — a pair joined only by `import type` reads
structurallyLinked and does not surface; an index walked before that change may
still miss the edge, so check before claiming "no link".

## Phase 3c2 — SHOTGUN SURGERY

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
by file type or hub size. Knot mode omits it.

| Summary field (`summary.shotgunSurgery`)    | Read as                                                                                                              |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `built`                                     | `false` = no co-change build / no bundle membership (`reason`, same as splitMerge) → NOT judged, never report "none" |
| `widthThreshold` / `widthThresholdMethod`   | k = narrowest spread judged; `otsu` = majority-floored Otsu over per-commit widths, `floor` = 3 (never below 3)      |
| `burstCount`                                | bursts touching a component — the null's degree unit                                                                 |
| `unitCount` / `wideUnitCount`               | logical-change component sets (same set sharing a burst once) / those spanning ≥ k — few wide = little evidence      |
| `umbrellaTaskIdCut` / `umbrellaTaskIdCount` | breadth fence (distinct ids an id's commits carry) / ids above it, left out of the join                              |
| `typicalChangeWidth`                        | T: Tukey fence over change widths — wider changes weigh C(T,k)/C(w,k)                                                |
| `familySize` / `q`                          | BH family C(n, k): every set of exactly k components among n changed in ≥ 2 bursts; FDR q — multiple-testing price   |
| `candidateSetCount` / `admittedSetCount`    | k-sets wide commits of ≥ 2 bursts held whole (tested) / k-sets passing BH over the null                              |
| `spreadCount`                               | maximal spreads admitted k-sets merge into: closure = components EVERY holding commit touched; support = k-set's     |
| `explainedCount`                            | spreads dropped: one structural island (dependency or specific neighbour) explains                                   |
| `outOfScopeSetCount`                        | scoped only: unexplained spreads with no exemplar file in `pathPattern`                                              |

Evidence per line:

| Evidence                                          | Read as                                                                                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `support` / `weightedSupport` / `expectedSupport` | distinct changes holding whole spread / Σ their specificity weights / E[weighted] under the null; weighted ≫ expected = real |
| `strength`                                        | Wilson lower bound of support over component changes                                                                         |
| `islands`                                         | structurally connected groups (≥ 2) — where the missing link would go                                                        |
| `exemplarFiles`                                   | per component the file the holding commits touched most                                                                      |
| `carrierFiles`                                    | per component (aligned) files the holding changes touched, most-touched first (≤ 5) — recipe input                           |
| `sampleCommits`                                   | shas to cite — latest commit of each holding change, one per supporting burst                                                |
| `sampleChanges`                                   | per sample (aligned) every sha of that logical change — `git show` them to see what one change edited                        |
| `drillDown.hint`                                  | run verbatim (`find_co_changed`) for file-level partners                                                                     |

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

## Phase 3d — MAIN SEQUENCE

Stable Abstractions Principle over SAME components as SDP. A = abstract /
(abstract + concrete) types, from walker type census; I = component instability;
D = |A + I − 1|. Abstract = interface / abstract class / protocol / trait / ABC;
TS interface or object type alias counts only when exported AND declaring
behaviour (method/call signature, or majority function-typed members) — data
shapes and props are concrete-neutral, not counted. Ruby: class/module with a
`raise NotImplementedError` stub.

| `zone`        | Meaning                                                     | Fix direction                                   |
| ------------- | ----------------------------------------------------------- | ----------------------------------------------- |
| `pain`        | stable + concrete (A + I < 1) — every change hits many      | extract interfaces dependents code against      |
| `uselessness` | unstable + abstract (A + I > 1) — contracts nobody leans on | drop unused abstractions or merge into concrete |

| Summary field (`summary.mainSequence`) | Read as                                                                                                                                                                                |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `distanceThreshold` / `…Method`        | D must exceed it; `majority` = floor 0.5 decided, `otsu` = adaptive cut above (`distanceSeparability` under `majority` = η that failed the gate)                                       |
| `meanDistance`                         | whole-codebase D over judged components — trend number                                                                                                                                 |
| `abstractTypeShareByLanguage`          | abstract share per language — why a language's components are unobservable                                                                                                             |
| `volatility`                           | pain gate: `threshold`/`thresholdMethod` over mean commits per file; `fileMedian` = floor OR log population not bimodal (η < 0.8, reported); absent = gate off (no git data / no pain) |

Evidence per line: `distance`, `abstractness`, `instability`, type counts,
Ca/Ce, `unmeasuredFileCount` (> 0 = partial census, hedge), `volatility`
(`value` = mean `git.file.commitCount` per file vs `threshold`). A reported pain
component is volatile — it is rigid AND keeps changing, so it hurts now. Pain
with no `volatility` = no git reading for its files, hedge.

## Phase 3d2 — HUB-LIKE DEPENDENCY

`detector: "hubLikeDependency"`, SAME components as SDP. Hub = Ca AND Ce both
past adaptive cut AND balanced (|Ca − Ce| / (Ca + Ce) < 1/4, Arcan) — many
depend on it, it depends on many. I near 0.5 → SDP silent, main sequence may
read healthy. Fix direction: split by dependent cluster (`topDependents`) or by
dependency cluster (`topDependencies`).

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
job; triage data, never suppression.

## Phase 3d3 — PROPAGATION COST

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

## Phase 3e — LAYERING

No declared architecture needed: SCC condensation of the DOMAIN graph — every
facade directory is a unit, adoption notwithstanding (a vertical with an
unadopted facade counts ONCE, not once per subdirectory; a Go package too).
Longest-path levels: `level` = longest path from sinks (0 = foundation); `depth`
= longest path from roots (0 = nothing depends on it). Component with no
layering edge sits at level 0, depth 0.

| Summary field (`summary.layering`) | Read as                                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `levelCount`                       | distinct levels, 0-based; 0 = no layering edge at all                                                                             |
| `facadePartition`                  | `{componentCount, levelCount}` of the facade-adoption partition — its per-subdirectory split reads deeper levels; comparison only |
| `coverage`                         | share of components outside multi-component knots — low = knot(s) dominate                                                        |
| `coherence`                        | rank correlation level vs instability — high = low layers really are the stable ones                                              |

Violations first, informational last, in `violations` order:

| `kind`              | Meaning                                                                        | Read as                                                                                                                                                                                                                                               |
| ------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `knot`              | multi-component SCC — a cycle ACROSS directories                               | ranked by `instabilitySpread` (max−min member instability; > 0 = an SDP break INSIDE the cycle, 0 = a tangle of alike members); `feedbackArcSet` = lightest cut that levels the members (`cutEdgeCount`, `levelsAfterCut` = distinct levels once cut) |
| `backEdge`          | minority-weight direction inside a knot pair                                   | `callWeight` vs `counterFlowWeight` — unequal weights decide; equal never judged; `fileEdges` name where                                                                                                                                              |
| `abstractionBypass` | consumer takes a measured-concrete component, measured-abstract one beneath it | `bypassedComponent`, `concreteAbstractness` / `bypassedAbstractness`; census-gated (≥5 types), same-knot pairs never judged                                                                                                                           |
| `compositionCycle`  | parent ↔ own nested directories cycling                                        | informational — `nestedPairs`; composition of a module with its sub-parts                                                                                                                                                                             |
| `island`            | nothing depends on it AND it does not reach the top of the stack               | informational — `height`/`depth`, `afferentCount: 0`                                                                                                                                                                                                  |
| `layerSkip`         | dependency jumping ≥2 levels to a lower one, never between knot members        | informational, weakest — `skippedLevels`, `callWeight`; hints a missing middle layer                                                                                                                                                                  |

## Phase 3f — LAYER MAP

`response.layerMap` exists ONLY when the request carried `layerMap` — skip this
phase otherwise. The map is the layering model read as a VIEW: per-node `level`
/ `depth` / `inKnot` + inner afferent/efferent counts.

| Option             | Read as                                                                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scopePathPattern` | nodes whose path matches live INSIDE the map; absent = whole repository, no boundary findings                                                                               |
| `granularity`      | `"directory"` (default) nodes = components; `"file"` nodes = FILES leveled on raw file edges (partition excludes intra-component edges — component deps cannot level files) |
| `directoryDepth`   | with `"directory"`: collapse every directory DEEPER than this many segments below the scope root into its ancestor; `0` = one node                                          |

| Field            | Read as                                                                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `boundaryOut`    | edge leaving the scope — names the EXTERNAL component and its `externalLevel` in the WHOLE-repo stack                                                                                                                                |
| `boundaryIn`     | edge entering the scope — same shape                                                                                                                                                                                                 |
| `moveCandidates` | inner node, 0 inner afferents, every outward edge points into ONE other domain — move-it-there signal                                                                                                                                |
| `knots`          | cycles among the map's own nodes, with the cut that levels them; `composition: true` = parent ↔ own nested parts — the summary reports those as `compositionCycle`, not `knot`, so `knotCount` + `compositionCycleCount` = map knots |
| `summary.*`      | `nodeCount`, `innerEdgeCount`, `boundaryOutEdgeCount`, `boundaryInEdgeCount`                                                                                                                                                         |

Empty scope = empty map (`nodeCount: 0`), not an error. Bad `granularity` =
validation error naming the enum, before any detector runs.

## Phase 3g — DEPENDENCY NORMS

`response.norms` exists ONLY when the request carried `norms: true` — skip
otherwise. The project judged by ITS OWN precedents: ledgers of (roleSrc,
roleDst, locality) over every typed file edge, ONE LEDGER PER LANGUAGE FAMILY
(`norms.ledgers[]`; TypeScript + JavaScript are one family, every other language
its own) — a Ruby `form` and a TS `form` never pool. Each ledger runs own
direction test (`ledgers[].significance`, method `directionInversion`): per
unordered role pair {A, B}, A ≠ B, localities pooled, exact two-sided sign test
of n(A→B) vs n(B→A) at p = ½; Benjamini–Hochberg at `q` (0.05, co-change gate's
q) over every pair holding ≥1 edge (`familySize`). Pair BH rejects
(`significantPairCount`) has ESTABLISHED direction; every edge against it =
MISFIT. `oneWayPairCount` = significant pairs nothing runs against — direction
fixed, no finding. Everything else CONFORMS, not listed: mutual pair (62:61),
one-way pair, pair too small to establish anything (3:0, 2:1 never reach q),
same-role pair (A→A, out of scope). NEW_PATTERN (pair with no history) is NOT
whole-repo verdict — diff time only. `finding.family` names judging ledger. Edge
between two families never judged (`summary.excluded.crossLanguageEdgeCount`).
Roles = each file's PRIMARY type's role; `summary.roleFileCount` counts strong
ones, `weakRoleFileCount` / `untypedFileCount` never judge. Of weak ones,
`summary.ioShapeRoleFileCount` = files whose primary type only shapes I/O of
function file is named for (`useXParams`, `XProps`) — never a role.

| Finding  | Read as                                                                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `misfit` | edge runs against pair's established direction — `establishedDirection: { roleSrc, roleDst, support }` is the way the project goes (`Record -> Query` when `Query -> Record` holds 52:6) |

Every finding carries `pairSupport` (edges along the finding's own direction,
localities pooled — minority side), `establishedDirection.support` (majority)
and `pValue` (sign test, 3 significant digits). `pairSupport: 1` against
`support: 24` = strong; heavy minority (24 against 47) = established but
contested convention — read before calling it a mistake. `locality` = where THIS
edge sits (`sameDirectory` / `sameDomain` / `crossDomain`); test pools
localities, so it never changes the verdict.

`summary.excluded.constantReferenceEdgeCount` — typed edges whose only evidence
is a constant NESTED in the target's primary type
(`BaseAdapter::RateLimitError`, no definite call): a dependency on an error
class, not on the target's role — never judged, in no ledger.

`summary.excluded.uncalledEdgeCount` — typed edges carrying NO resolved call
(`callWeight` 0: factory `.new`, subtype registry, initializer config, type-only
import). Source names target, never runs its logic → never a finding. Still
ledger precedent: direction of knowledge counts every reference (a query reads
records through framework finders with no in-project call, yet that IS what
establishes query → record).

`summary.excluded.frameworkRoutedEdgeCount` — typed edges whose EVERY call went
through framework interface: call text names neither member it lands on nor its
owner's construction, along no inheritance edge (`Worker.perform_async(id)`
routed to `Worker#perform`). Source knows target's framework contract, not its
logic → never a finding; still precedent. Caveat: a project's own dispatcher
routing `Service.call(x)` → `#perform` reads the same.

`summary.excluded.displacedRoleEdgeCount` — typed edges touching a DISPLACED
role: head-noun role read where role does not live — file outside every
conventional directory of its role (`app/lib/x/fee_helper.rb` while helpers live
in `app/helpers`), or called on type itself (`class << self`) while role's home
carriers are called on instances (or reverse). Role stays precedent, edge never
judged. Edge-level reasons (constant, uncalled, framework-routed) count first.

`pathPattern` scopes the FINDINGS by source — ledgers and the test stay
whole-graph. Findings it drops count in `summary.outOfScopeFindingCount`, never
silently lost.

## Phase 4 — EXCLUSIONS

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
judged; `intraParentConsumers` counts excluded importer pairs:

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
dies here), `explainedBySharedNeighbour` (both import a low-fanIn file, or A→C→B
— shared contract, not hidden coupling; hub neighbour explains nothing). A
barrel / type-only / object-literal module IS judged — its `import type` deps
are edges, so a missing edge is evidence.

`summary.mainSequence.excluded` — components NOT judged: `lowConnectionCount`
(SDP floor), `unmeasured` (no census — recompute), `fewTypes` (< `minTypeCount`
— A swings per type), `unobservableAbstractness` (expected abstract types < 1 at
language's share; reason in `exclusionReasons`). `stableConcreteCalm` is judged,
not skipped: stable + concrete past the D cut but calm (below the volatility
cut) — a settled utility, not pain; reason in `exclusionReasons`.

## Phase 5 — OUTPUT

```text
Architecture report: [scope] — [violationCount] SDP violations, [rootCauseCount] root causes
[componentCount] components ([moduleComponentCount] modules); judged [judgedEdgeCount] of [componentEdgeCount] component deps (excluded: containment N, low support N); tooling excluded: [nonProduction.excludedFileCount] files; test support excluded: [testSupport.excludedFileCount] files

## Root causes
| # | Target component | I | Dependents | Cycle | Fix direction |

## Cross-component violations (disjoint)
| # | Source → Target | I src → tgt | Δ | file edges (top) | calls |

## Local violations
[count] — list only on request

## Leaking abstractions — [violationCount] (bypass N, internal-reach N)
Threshold [adoptionThreshold] ([method], η [separability]); [activeModuleCount] of [moduleCount] modules judged
| # | Module | Adoption (facade/deep) | Bypass | Internal-reach | Sources |

## Silent coupling — [violationCount] ([strongLinkedCount] strong pairs linked in code)
Threshold [strengthThreshold] ([method], η [separability]); history [commitCount] commits since [windowSince] @ [head]
| # | File A ↔ File B | Strength | Support | P(B|A) / P(A|B) | Visibility | Sample commit |
Grouped: | # | Shared file | Partners (N) | Top 3 (support / λ / strength) | Drill (`drillDown.hint`) |

## Shotgun surgery — [violationCount]; k [widthThreshold] ([widthThresholdMethod]); [wideUnitCount]/[unitCount] wide commit sets over [burstCount] bursts; admitted [admittedSetCount] k-sets of family C(n,k) [familySize] (q [q]) → [spreadCount] spreads
| # | Components | Islands | Support / λ | Strength | Exemplar files | Sample commit | Drill (`drillDown.hint`) |

## Main sequence — [violationCount] (pain N, uselessness N); mean D [meanDistance]
Threshold [distanceThreshold] ([method]); volatility cut [volatility.threshold] ([volatility.thresholdMethod]); judged [judgedComponentCount]; excluded: unmeasured N, unobservable N, calm N
| # | Component | Zone | D | A (abstract/types) | I | Ca/Ce | Commits/file |

## Hub-like dependencies — [violationCount]; cuts Ca > [afferent.threshold] ([method]), Ce > [efferent.threshold] ([method]); judged [judgedComponentCount]
| # | Component | Ca/Ce | I | Top dependents | Top dependencies | Reach | Commits/file |

## Propagation cost — [propagationCost]; shape [corePeriphery.shape], core [counts.core] ([coreShare]); largest cycle [largestCycleSize]
| # | Component | Files | Mean reach | Internal PC | Core files |

## Layering — [levelCount] levels; coverage [coverage], coherence [coherence]
knots [knotCount] (composition N), backEdges [backEdgeCount], bypasses [abstractionBypassCount]; islands N, skips N, composition cycles N
| # | Kind | Components | Evidence (cut / weights / abstractness) |

## Layer map — [levelCount] levels, [nodeCount] nodes ([granularity], scope [scope|whole repo])
boundary-out N (→ top external: [component] at L[externalLevel]), boundary-in N; move candidates N
| # | Level | Node | depth | inKnot | inner in/out |

## Domain [path] — [componentCount] components, [levelCount] levels (domain mode)
boundary-out N (heaviest → [externalComponent] at L[externalLevel]), boundary-in N
| # | Dir | Inner component | External component | L ext | calls |

## Dependency norms — [violationCount] MISFIT; per family [family]: [significantPairCount]/[familySize] pairs directed ([oneWayPairCount] one-way); [roleFileCount] typed files
excluded constant-reference N, cross-language N, uncalled N, framework-routed N, displaced-role N; typed [typedEdgeCount] of graph edges
| # | Family | Edge (src → dst) | Roles | Locality | Against (established → support) | Minority | p |
```

Every line cites evidence numbers from report. No evidence → no claim.
