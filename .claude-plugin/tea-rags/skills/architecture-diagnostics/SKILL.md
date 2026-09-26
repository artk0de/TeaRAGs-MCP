---
name: architecture-diagnostics
description:
  Check if code laid out correctly — dependency direction, module borders,
  Stable Dependencies Principle violations, leaking abstractions (imports past
  an adopted facade), silent coupling (files changing together with no
  import/call between them) and main-sequence distance (zone of pain /
  uselessness) with evidence per line, grouped into root causes. Use when asked
  "is architecture right", "layering violations", "wrong dependency direction",
  "SDP", "stable depends on unstable", "module borders", "facade bypass", "deep
  imports", "leaking abstraction", "hidden coupling", "change together",
  "shotgun surgery", "zone of pain", "main sequence", "abstractness",
  "архитектурные нарушения" — NOT for risk/health of code (use risk-assessment),
  NOT for one failure (use bug-hunt), NOT for plain cycle listing (find_cycles).
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
7. Phase 3d — MAIN SEQUENCE (`detector: "mainSequence"`)
8. Phase 4 — EXCLUSIONS: say what not judged
9. Phase 5 — OUTPUT

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
  Combine only when user asks both.
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
get_architecture_report(project: "<alias>", pathPattern?: "<glob>", limit?: 50)
```

- `pathPattern` scopes JUDGED edges by SOURCE file (SDP: component dependency
  judged when ≥1 carrying file edge's source matches; silent coupling: by EITHER
  file of pair). Instability, facade adoption, strength cut always whole-graph —
  scoped run sees same numbers as full run.
- Tooling paths (scripts, spikes, benchmarks, examples, fixtures) removed before
  any detector — `summary.nonProduction` counts them.
- `limit` caps `violations` + `rootCauses` PER DETECTOR; each
  `summary.<detector>` keeps totals (`violationCount`, `rootCauseCount`).
  Totals > returned → say truncated.
- Every finding carries `detector`: `stableDependencies` (Phases 2–3),
  `leakingAbstraction` (Phase 3b), `silentCoupling` (Phase 3c) or `mainSequence`
  (Phase 3d). Never mix groups across detectors.

## Phase 2 — ROOT CAUSES

SDP unit = COMPONENT: module with measured facade (A4 active or not-adopted —
owns its directory subtree minus nested modules), else plain directory. Ca/Ce
count distinct files across component border.

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

| Summary field (`summary.leakingAbstraction`) | Read as                                                                  |
| -------------------------------------------- | ------------------------------------------------------------------------ |
| `adoptionThreshold`                          | cut this codebase got; adoption must ALSO be > 0.5                       |
| `adoptionThresholdMethod`                    | `otsu` = split over module adoptions; `majority` = too few modules (< 8) |
| `adoptionSeparability`                       | η of Otsu cut; near 1 = clean two-mode split; low = cut is soft, hedge   |
| `activeModules`                              | modules whose boundary is judged, with facade/deep importer counts       |
| `notAdoptedModules`                          | facade exists, importers ignore it — name, don't judge                   |

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

| Summary field (`summary.silentCoupling`) | Read as                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------ |
| `built`                                  | `false` = no co-change build → not judged, stop here                           |
| `build`                                  | provenance: `head`, window, `commitCount`, mass cut `maxFilesPerBundle`        |
| `strengthThreshold`                      | cut this codebase got; strength must ALSO be > 0.5                             |
| `strengthThresholdMethod`                | `otsu` = split over candidate strengths; `majority` = too few candidates (< 8) |
| `strongLinkedCount`                      | strong pairs code DOES link — declared coupling, context for `violationCount`  |

`rootCauses` with `detector: "silentCoupling"` = file with ≥ 2 silent partners:
`relPath`, `violationCount`, `maxStrength`, `partners`. Read first — hub of
hidden coupling.

Pair undirected: `sourceRelPath` = lexicographically smaller. Evidence per line:

| Evidence                           | Read as                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------- |
| `strength`                         | 95% Wilson lower bound on P(other changes \| one changes), stronger direction |
| `support`                          | commits (or author sessions) touching both — thin support = hedge             |
| `confidenceAB` / `confidenceBA`    | P(target \| source) / P(source \| target); asymmetric = one drags other       |
| `lift`                             | co-change over independence; always > 1 here                                  |
| `sampleCommits`                    | shas to cite; show one to prove                                               |
| `structuralVisibility: one-walked` | other file not walked code (config, data, script) — coupling to non-code      |
| `directoryRelation: disjoint`      | crosses module border — rank highest                                          |

Fix direction: make coupling explicit (shared contract / generated table / one
owner) OR merge. Type-only imports are NOT graph edges — pair joined only by
`import type` can surface; check before claiming "no link".

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

| Summary field (`summary.mainSequence`) | Read as                                                                       |
| -------------------------------------- | ----------------------------------------------------------------------------- |
| `distanceThreshold` / `…Method`        | D must exceed it; `majority` = floor 0.5 decided, `otsu` = adaptive cut above |
| `meanDistance`                         | whole-codebase D over judged components — trend number                        |
| `abstractTypeShareByLanguage`          | abstract share per language — why a language's components are unobservable    |

Evidence per line: `distance`, `abstractness`, `instability`, type counts,
Ca/Ce, `unmeasuredFileCount` (> 0 = partial census, hedge). Stable core of
utilities (`infra`) in pain is often by design — say so, don't prescribe.

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

`summary.leakingAbstraction.excludedModules` — modules NOT judged:

| Counter            | Meaning                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `facadeNotAdopted` | adoption ≤ 0.5 or below adaptive cut — importers don't use the facade |
| `tooFewImporters`  | < 3 external importers — adoption untrustworthy                       |
| `languageEnforced` | Go package — compiler enforces boundary, nothing to leak              |

`summary.silentCoupling.excluded` — pairs read, NOT judged: `testEndpoints`,
`generatedEndpoints`, `documentationEndpoints`, `unwalkedEndpoints` (neither
file walked), `nonPositiveLift`. A barrel / type-only / object-literal module IS
judged — its `import type` deps are edges, so a missing edge is evidence.

`summary.mainSequence.excluded` — components NOT judged: `lowConnectionCount`
(SDP floor), `unmeasured` (no census — recompute), `fewTypes` (< `minTypeCount`
— A swings per type), `unobservableAbstractness` (expected abstract types < 1 at
language's share; reason in `exclusionReasons`).

## Phase 5 — OUTPUT

```text
Architecture report: [scope] — [violationCount] SDP violations, [rootCauseCount] root causes
[componentCount] components ([moduleComponentCount] modules); judged [judgedEdgeCount] of [componentEdgeCount] component deps (excluded: containment N, low support N); tooling excluded: [nonProduction.excludedFileCount] files

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

## Main sequence — [violationCount] (pain N, uselessness N); mean D [meanDistance]
Threshold [distanceThreshold] ([method]); judged [judgedComponentCount]; excluded: unmeasured N, unobservable N
| # | Component | Zone | D | A (abstract/types) | I | Ca/Ce |
```

Every line cites evidence numbers from report. No evidence → no claim.
