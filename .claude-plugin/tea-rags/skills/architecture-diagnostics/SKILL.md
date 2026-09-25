---
name: architecture-diagnostics
description:
  Check if code laid out correctly — dependency direction, module borders,
  Stable Dependencies Principle violations, leaking abstractions (imports past
  an adopted facade) and silent coupling (files changing together with no
  import/call between them) with evidence per line, grouped into root causes.
  Use when asked "is architecture right", "layering violations", "wrong
  dependency direction", "SDP", "stable depends on unstable", "module borders",
  "facade bypass", "deep imports", "leaking abstraction", "hidden coupling",
  "change together", "shotgun surgery", "архитектурные нарушения" — NOT for
  risk/health of code (use risk-assessment), NOT for one failure (use bug-hunt),
  NOT for plain cycle listing (find_cycles).
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
7. Phase 4 — EXCLUSIONS: say what not judged
8. Phase 5 — OUTPUT

## Top Anti-patterns

- **Reading flat `violations` first.** N violations into one target = ONE
  defect. Fix target, not N sources.
- **`edgeCount: 0` read as clean.** Nothing read ≠ no violations. No codegraph
  DB or empty graph — say so.
- **Ignoring `privateCollaborators`.** Excluded, not clean — see Phase 4.
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

- `pathPattern` scopes JUDGED edges by SOURCE file (silent coupling: by EITHER
  file of pair). Instability, facade adoption, strength cut always whole-graph —
  scoped run sees same numbers as full run.
- `limit` caps `violations` + `rootCauses` PER DETECTOR; each
  `summary.<detector>` keeps totals (`violationCount`, `rootCauseCount`).
  Totals > returned → say truncated.
- Every finding carries `detector`: `stableDependencies` (Phases 2–3),
  `leakingAbstraction` (Phase 3b) or `silentCoupling` (Phase 3c). Never mix
  groups across detectors.

## Phase 2 — ROOT CAUSES

`rootCauses[]` ordered by `violationCount` desc, then `maxInstabilityDelta`.

| Field                 | Read as                                                             |
| --------------------- | ------------------------------------------------------------------- |
| `targetRelPath`       | unstable file stable files lean on                                  |
| `violationCount`      | stable dependents affected — severity                               |
| `targetInstability`   | I = fanOut/(fanIn+fanOut); high = depends on much, few depend on it |
| `sources`             | the stable dependents                                               |
| `cycleWithDependents` | target references own dependents → instability self-inflicted       |

`cycleWithDependents: true` = strongest finding. Base names its subclasses,
concern names its includers, registry names its entries. Fix: invert
back-reference (registry/lookup, DI, move knowledge to dependents) → every
violation of group disappears at once.

Confirm cycle (optional): `find_cycles(scope: "file", pathPattern: "<target>")`;
what target references: `find_symbol(relativePath: "<target>")`.

`cycleWithDependents: false`, count ≥ 3 → target too volatile for its role:
split stable core (what dependents use) from volatile rest.

## Phase 3 — RESIDUAL VIOLATIONS

Groups with `violationCount: 1`: judge each by `evidence`.

| Evidence                       | Weight                                                           |
| ------------------------------ | ---------------------------------------------------------------- |
| `directoryRelation: disjoint`  | crosses module border — the case borders are about; rank highest |
| `descendant` / `ancestor`      | module ↔ own sub-part; often intended layering, check direction  |
| `same`                         | local; lowest                                                    |
| `instabilityDelta`             | severity within the list                                         |
| `callWeight: 0`                | type/const/import only — weaker coupling                         |
| connectionCount near threshold | thin support; instability can swing — flag as tentative          |

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

## Phase 4 — EXCLUSIONS

`summary.stableDependencies.excluded` — edges read, NOT judged:

| Counter                | Meaning                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `privateCollaborators` | source = target's SOLE importer. Target's instability hurts only that source (worker → own service, component → private child). SDP premise void → skip |
| `noSymbolEndpoints`    | endpoint defines no symbol + no call: barrel, type-only, object-literal module                                                                          |
| `lowConnectionCount`   | endpoint fanIn+fanOut below `minConnectionCount` — instability untrustworthy                                                                            |
| `unwalkedEndpoints`    | endpoint never extracted by codegraph                                                                                                                   |
| `outOfScopeEdgeCount`  | source outside `pathPattern` (present only when scoped)                                                                                                 |

Reasons verbatim in `exclusionReasons`. Report them as "not judged", never as
"clean". Large `privateCollaborators` normal — about half of raw SDP hits in
Rails/React monolith.

`summary.leakingAbstraction.excludedModules` — modules NOT judged:

| Counter            | Meaning                                                               |
| ------------------ | --------------------------------------------------------------------- |
| `facadeNotAdopted` | adoption ≤ 0.5 or below adaptive cut — importers don't use the facade |
| `tooFewImporters`  | < 3 external importers — adoption untrustworthy                       |
| `languageEnforced` | Go package — compiler enforces boundary, nothing to leak              |

`summary.silentCoupling.excluded` — pairs read, NOT judged: `testEndpoints`,
`generatedEndpoints`, `documentationEndpoints`, `unwalkedEndpoints` (neither
file walked), `noSymbolEndpoints` (barrel / type-only / object-literal module —
its `import type` deps invisible, missing edge no evidence), `nonPositiveLift`.

## Phase 5 — OUTPUT

```text
Architecture report: [scope] — [violationCount] SDP violations, [rootCauseCount] root causes
Judged [judgedEdgeCount] of [edgeCount] edges (excluded: private collaborators N, no-symbol N, low support N)

## Root causes
| # | Target | I | Dependents | Cycle | Fix direction |

## Cross-module violations (disjoint)
| # | Source → Target | I src → tgt | Δ | calls |

## Local violations
[count] — list only on request

## Leaking abstractions — [violationCount] (bypass N, internal-reach N)
Threshold [adoptionThreshold] ([method], η [separability]); [activeModuleCount] of [moduleCount] modules judged
| # | Module | Adoption (facade/deep) | Bypass | Internal-reach | Sources |

## Silent coupling — [violationCount] ([strongLinkedCount] strong pairs linked in code)
Threshold [strengthThreshold] ([method], η [separability]); history [commitCount] commits since [windowSince] @ [head]
| # | File A ↔ File B | Strength | Support | P(B|A) / P(A|B) | Visibility | Sample commit |
```

Every line cites evidence numbers from report. No evidence → no claim.
