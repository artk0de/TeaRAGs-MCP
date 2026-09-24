---
name: architecture-diagnostics
description:
  Check if code laid out correctly — dependency direction, module borders,
  Stable Dependencies Principle violations with evidence per line, grouped into
  root causes. Use when asked "is architecture right", "layering violations",
  "wrong dependency direction", "SDP", "stable depends on unstable", "module
  borders", "архитектурные нарушения" — NOT for risk/health of code (use
  risk-assessment), NOT for one failure (use bug-hunt), NOT for plain cycle
  listing (find_cycles).
argument-hint: "[scope — pathPattern, subsystem, or 'whole project']"
---

# Architecture Diagnostics

Question: laid out right? NOT: dangerous to touch? (→ risk-assessment).

## Phase Order (MANDATORY)

1. Phase 0 — GATE: codegraph on?
2. Phase 1 — REPORT: one `get_architecture_report` call
3. Phase 2 — ROOT CAUSES first (**never lead with flat violations**)
4. Phase 3 — residual violations, judged by evidence
5. Phase 4 — EXCLUSIONS: say what not judged
6. Phase 5 — OUTPUT

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

- `pathPattern` scopes JUDGED edges by SOURCE file. Instability always
  whole-graph — scoped run sees same numbers as full run.
- `limit` caps `violations` + `rootCauses`; `summary.stableDependencies` keeps
  totals (`violationCount`, `rootCauseCount`). Totals > returned → say
  truncated.

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
```

Every line cites evidence numbers from report. No evidence → no claim.
