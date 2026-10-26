---
name: architecture-diagnostics
description:
  'Check code layout — dependency direction, SDP violations, module borders,
  leaking abstractions, silent coupling, zone of pain, hub-like deps, layer map
  / move candidates. Triggers "is architecture right", "layering violations",
  "which layer", "wrong dependency direction", "shotgun surgery", "архитектурные
  нарушения". NOT risk/health (risk-assessment), NOT one failure (bug-hunt), NOT
  plain cycle listing (find_cycles).'
---

# Architecture Diagnostics

Question: laid out right? NOT: dangerous to touch? (→ risk-assessment).

**Lag ≠ unusable:** `changedFiles` / `pendingFiles` / drift never license `cat`
/ `grep` / `Read` over code — `tea-rags://guide/freshness`.

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
   - Phase 3h — DIFF-TIME FINDINGS (only for `review_changes` architecture
     findings: `preExisting`, `remedy`, repair files)
9. Phase 3f — LAYER MAP (only when the request carried `layerMap`)
10. Phase 3i — REMEDY SIMULATION: each recommended move / split / merge →
    `restructure` call, remedies ranked by delta
11. Phase 4 — EXCLUSIONS: say what not judged
12. Phase 5 — OUTPUT

## Top Anti-patterns

Full list: [references/anti-patterns.md](./references/anti-patterns.md).

- **Flat `violations` first.** N violations into one target = ONE defect.
- **Nothing read ≠ clean.** `edgeCount: 0`, `built: false`, excluded counters,
  `facade-not-adopted`, absent `layerMap` = not judged / not asked — say so.
- **SDP is component-level**, not file-level. Tolerance fixed, no caller knob.
- **No risk signals** (churn, bugFixRate) — other question; per-violation
  `maintenanceCost` = fix priority only.
- **`preExisting: true`** = base already held it — real finding, not
  diff-introduced. **`remedy`** quoted verbatim, never paraphrased.
- **`review_changes` findings in hand → Phase 3h ONLY** (skip Phases 0–3, no
  `phase-1-report.md`). First open `../../repair/<family>.md` of EVERY family
  present (report-only too), no others; print
  `Repair files loaded: repair/<family>.md (## Apply remedy | ## No remedy), …`.
  Then one line per finding, class by name, fix now, never defer:
  - no `preExisting` (absence IS the signal) →
    `<family> — introduced, must-fix per repair/<family>.md: <fix>. compositionRoot / Known-false-positive entry: <quoted evidence | none>. Exempt only with compositionRoot flag or ## Known false positives entry; bare "by design" is not evidence.`
  - `preExisting` + `remedy` →
    `<family> — cheap-preExisting per repair/<family>.md: <remedy verbatim: source, from → to, names>`
  - `preExisting`, no `remedy` → `<family> — report-only, no fix`
    (`mainSequence`: distanceBefore already past threshold)
- **`island` / `compositionCycle` / `knot` with `composition: true`** =
  informational, not defects.

## Rules

1. **Execute YOURSELF** — no subagents.
2. **No built-in Search/Grep** — tea-rags tools only.
3. **One report call per scope.** Narrow via `pathPattern`, not re-calls with
   bigger `limit`.

## Phase 0 — GATE

`get_architecture_report` registered? No → say "architecture report needs
codegraph", stop; NEVER claim "no violations". `## Codegraph resolve` above
(none → read_mcp_resource `tea-rags://project/<alias>/metrics?section=resolve`)
— low rate → edges partial.

## Phase 1 — REPORT

```text
get_architecture_report(path: "<your working directory>", pathPattern?: "<glob>", limit?: 50, norms?: true,
                        layerMap?: { scopePathPattern?, granularity?: "directory"|"file", directoryDepth? })
```

**Read [references/phase-1-report.md](./references/phase-1-report.md) before
reading the response** — `pathPattern` vs `domain` scope, `norms`, tooling /
test-support removal, `limit` per detector (totals in `summary.<detector>`; more
than returned → say truncated), costliest-first `score`, impact `tier` (lead
critical, then active; `built: false` ≠ structural). Every finding carries
`detector` — never mix groups across detectors.

## Phase 2 — ROOT CAUSES

SDP unit = COMPONENT: facade directory, adoption notwithstanding (any A4 status
— owns its directory subtree minus nested modules; ONE partition for SDP,
mainSequence, hubLike, layering, silentCoupling), else plain directory — Ruby
included (`app/models/billing` and `app/services/billing` are two components).
Shotgun alone groups by constant namespace path spells (`::Billing` — Zeitwerk
autoload: `app/models/billing/*` + `app/services/billing/*` = one), so its
spreads name `::X` components. Ca/Ce = distinct files across the border.

`rootCauses[]` ordered by `violationCount` desc, then `maxInstabilityDelta`.

| Field                 | Read as                                                       |
| --------------------- | ------------------------------------------------------------- |
| `targetComponent`     | unstable component stable components lean on                  |
| `violationCount`      | stable dependent components affected — severity               |
| `targetInstability`   | I = Ce/(Ca+Ce); high = depends on much, few depend on it      |
| `sources`             | the stable dependent components                               |
| `cycleWithDependents` | target depends on own dependents → instability self-inflicted |

Root cause `tier` = max over member violations. Rank groups critical > active >
structural before `violationCount` when tiers built.

`cycleWithDependents: true` = strongest finding (base names subclasses, concern
its includers, registry its entries). Fix: invert back-reference (registry, DI,
knowledge to dependents) → whole group disappears. Confirm (optional):
`find_cycles(scope: "file", pathPattern: "<target>/**")`; carrying files:
`evidence.fileEdges`.

`cycleWithDependents: false`, count ≥ 3 → split stable core (what dependents
use) from volatile rest.

## Phase 3 — RESIDUAL VIOLATIONS

Groups with `violationCount: 1`: judge each by `evidence`.

| Evidence                        | Weight                                                             |
| ------------------------------- | ------------------------------------------------------------------ |
| `directoryRelation: disjoint`   | crosses into sibling/cousin — the case borders are about; highest  |
| `ancestor`                      | nested component reaching up into its parent; check direction      |
| `instabilityDelta`              | severity within the list                                           |
| `tier` critical / active        | change cascades across edge (critical: into wide reach); act first |
| `callWeight: 0`                 | type/const/re-export only — weaker coupling                        |
| `fileEdgeCount` 1               | one file carries it — cheap to move                                |
| Ca+Ce near `minConnectionCount` | thin support; instability can swing — flag as tentative            |

`evidence.fileEdges` (top 5 by call weight) = where to act.

## Phases 3b–3i — per-detector judgement

**MANDATORY: read the phase's reference before judging that detector's
findings** — each carries field semantics plus its not-built / not-judged traps.
Detector absent or zero findings → no read.

| Phase | Judges              | Field                         | Reference                                                                       |
| ----- | ------------------- | ----------------------------- | ------------------------------------------------------------------------------- |
| 3b    | leaking abstraction | `leakingAbstraction`          | [phase-3b-leaking-abstraction.md](./references/phase-3b-leaking-abstraction.md) |
| 3c    | silent coupling     | `silentCoupling`              | [phase-3c-silent-coupling.md](./references/phase-3c-silent-coupling.md)         |
| 3c2   | shotgun surgery     | `shotgunSurgery`              | [phase-3c2-shotgun-surgery.md](./references/phase-3c2-shotgun-surgery.md)       |
| 3d    | main sequence       | `mainSequence`                | [phase-3d-main-sequence.md](./references/phase-3d-main-sequence.md)             |
| 3d2   | hub-like dependency | `hubLikeDependency`           | [phase-3d2-hub-like.md](./references/phase-3d2-hub-like.md)                     |
| 3d3   | propagation cost    | `summary.propagationCost`     | [phase-3d3-propagation-cost.md](./references/phase-3d3-propagation-cost.md)     |
| 3e    | layering            | `layering`                    | [phase-3e-layering.md](./references/phase-3e-layering.md)                       |
| 3f    | layer map           | `response.layerMap`           | [phase-3f-layer-map.md](./references/phase-3f-layer-map.md)                     |
| 3g    | dependency norms    | `norms`                       | [phase-3g-dependency-norms.md](./references/phase-3g-dependency-norms.md)       |
| 3h    | diff-time findings  | `review_changes architecture` | [phase-3h-diff-time.md](./references/phase-3h-diff-time.md)                     |
| 3i    | remedy simulation   | `restructure`                 | [phase-3i-remedy-simulation.md](./references/phase-3i-remedy-simulation.md)     |

## Phase 4 — EXCLUSIONS

Read [references/phase-4-exclusions.md](./references/phase-4-exclusions.md):
counters per detector (`summary.<detector>.excluded*`) = read, NOT judged.
Report as "not judged", never "clean"; reasons verbatim from `exclusionReasons`.

## Phase 5 — OUTPUT

```text
Architecture report: [scope] — [violationCount] SDP violations, [rootCauseCount] root causes
[componentCount] components ([moduleComponentCount] modules); judged [judgedEdgeCount] of [componentEdgeCount] component deps (excluded: containment N, low support N); tooling excluded: [nonProduction.excludedFileCount] files; test support excluded: [testSupport.excludedFileCount] files
Impact tiers: SDP critical N / active N / structural N; layering …; leaks …; reach cut [threshold] ([method]) | not built (no co-change history)

## Root causes
| # | Target component | Tier | I | Dependents | Cycle | Fix direction |

## Cross-component violations (disjoint)
| # | Source → Target | Tier (admitted/total pairs) | I src → tgt | Δ | file edges (top) | calls |

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

## Remedies — simulated (restructure), ranked by net
| # | Remedy | ops | net | resolved (by family) | introduced (subjects) |
```

Every line cites evidence numbers from report. No evidence → no claim.
