---
name: refactoring-planning
description:
  Turn architecture diagnosis into ordered, simulated refactoring plan — expand
  each critical/active finding (SDP, hub-like, leaking abstraction, layering
  back-edge) into restructure ops from repair recipes, order them with
  `restructurePlan` (greedy, by tier), hand steps to writing-plans as Tasks with
  expected violation delta and execution contract. Use when asked "plan a
  refactoring", "plan the architecture fix", "in what order to fix these
  violations", "refactoring roadmap", "спланируй рефакторинг", "в каком порядке
  чинить нарушения" — NOT for diagnosis alone (use architecture-diagnostics),
  NOT for one in-file change (use data-driven-generation), NOT for code health
  scan (use risk-assessment).
argument-hint: "[scope — pathPattern, domain, or 'whole project']"
---

# Refactoring Planning

Diagnosis → simulated candidates → server-ordered steps → plan Tasks w/ expected
delta. Server orders; agent builds candidates + plan. Execute YOURSELF, tea-rags
tools only.

## Phase Order (MANDATORY)

0. GATE — codegraph on?
1. REPORT — one `get_architecture_report`
2. CANDIDATES — recipe per critical/active finding; lexicon + `plannedEdges`
3. ORDER — `restructurePlan` (report candidates per cost rule)
4. ANNOTATE — `tea-rags:refactoring-scan`, notes only
5. PLAN — `dinopowers:writing-plans`, one step = one Task
6. EXECUTION CONTRACT — written into plan

## Top Anti-patterns

- Prose remedy / file move where recipe gives edge ops → no candidate.
- Plan Task w/o `restructurePlan` simulation behind it.
- MISFIT edge proposed. `UNJUDGED newFile` treated as reject (it is not).
- Trade-off / unselected / deferred → Task. Never.
- Scan hit reorders steps or adds own Task.
- `includeReportCandidates` default on large repo → call runs ~1 h (bd
  tea-rags-mcp-vytjl).
- Plan Task w/o expected delta, or plan w/o execution contract.
- Diverged Task → next Task on stale plan.

## Phase 0 — GATE

prime `## Enrichment` lists `codegraph.symbols`? No → "refactoring planning
needs codegraph", stop. Any plan-mode answer `unavailable: "noCodegraph"` →
stop, same line.

## Phase 1 — REPORT

`get_architecture_report(path: "<working dir>", pathPattern?|domain?, limit?)` —
reading per `tea-rags:architecture-diagnostics` Phase 1 (do not restate). Keep:

- findings w/ `tier` critical / active (SDP, leakingAbstraction, layering
  backEdge, hubLikeDependency). Structural-only → listed, no candidate unless
  user asks. `summary.impactTiers` `built: false` → untiered: take by
  `maintenanceCost`, say "untiered".
- `N` = `summary.propagationCost.fileCount` (judged production files — drives
  per-judge cost).
- `R` = `summary.splitMerge` split + merge candidates (report candidates
  `restructurePlan` adds). Block not built → R = 0.

User already ran architecture-diagnostics this session → reuse that report, no
re-call.

## Phase 2 — CANDIDATES

Per kept finding: load `../../repair/<family>.md` `## Ops recipe` — that family
only, never preload dir.

| Finding                     | Recipe file                                |
| --------------------------- | ------------------------------------------ |
| `stableDependencies`        | `stableDependencies.md`                    |
| `hubLikeDependency`         | `hubLike.md`                               |
| `leakingAbstraction`        | `leakingAbstraction.md`                    |
| `layering` backEdge         | `layeringBackEdge.md`                      |
| layer-map move / A5 verdict | architecture-diagnostics Phase 3i op table |

- Recipe → ops verbatim shape: `removeEdge{from,to}`,
  `addFile{file,component, abstract: true}` for extracted interface,
  `addEdge{from,to}`, `move{…}`. Paths repo-relative base paths; new-file path
  per recipe's path rule (never hard-coded dir).
- Recipe says "no recipe, escalate" → no candidate; list under Escalated.
- Names: ONE `get_naming_lexicon` call over all drafted new-file / type names.
  `MISFIT` / `COLLISION` → rename to suggestion; `NEW_TERM` → keep + one-line
  why.
- Edges: ONE `get_architecture_report(path, plannedEdges: [...])` over every
  `addEdge` between EXISTING files. `MISFIT` → drop candidate, line
  `DROPPED <id> — MISFIT <src> -> <dst> (established <roleSrc> -> <roleDst>, support <n>)`.
  `UNJUDGED newFile` / `NEW_PATTERN` / `CONFORMS` → keep.
- Candidate = `{id, rationale: <finding key>, ops}` — one per remedy, ≤ 20 ops.
  `id` kebab `<family>-<short subject>`, never `report:` prefix (server owns
  it).
- Cap ≤ 15 candidates per plan call: critical first, then active, then
  `maintenanceCost`. Rest → Deferred (re-plan after first Tasks land).

## Phase 3 — ORDER

`get_architecture_report(path, restructurePlan: {candidates, includeReportCandidates})`
— only `limit` may ride along.

Cost: rounds = steps + 1, each round judges every remaining candidate (full
detector run) → judges ≈ (S + 2)·(K + R). Per-judge ms grows w/ N. Known per
judge = `(timing.totalMs − timing.factsMs) / timing.judgeCount` of an earlier
plan / restructure call this session.

1. R = 0 → one call, own candidates, flag irrelevant.
2. R > 0, no per-judge measurement yet → first call
   `includeReportCandidates: false` (always safe). It yields S + per-judge.
3. Estimate (S + 2)·(K + R)·perJudge + factsMs. ≤ ~2 min (one MCP call) →
   re-call same candidates, `includeReportCandidates` omitted (true); that plan
   supersedes. Over → large repo: keep the `false` plan, say "report split/merge
   candidates not ordered — quadratic judging (bd tea-rags-mcp-vytjl)", list
   them under Not ordered (each simulable alone via architecture-diagnostics
   Phase 3i). Never drop them silently.

Large repo = estimate over budget; N ≥ ~10k judged files with dozens of R → skip
the estimate, go `false` directly.

Read response: `steps[]` (order = plan order; `delta` vs prefix, `byTier`,
`touchedFiles`, `blastRadius`), `tradeOffs[]` (introduce critical/active — never
selected), `unselected[]` (`noImprovement` | `conflictsWithPrefix` + `detail`),
`total` (base vs final prefix). Unknown file / edge → typed error
(`INPUT_UNKNOWN_RESTRUCTURE_*`) → fix name, re-call; never drop candidate.

## Phase 4 — ANNOTATE

`tea-rags:refactoring-scan` over union of steps' `touchedFiles`. Tier 1/2 hit on
file F in step k → note on step k: "F — decompose too (<signals>)". Order
unchanged; no Task added; no step removed.

## Phase 5 — PLAN

`dinopowers:writing-plans`. One step = one Task, step order. Per Task:

- `candidateId`, `rationale` (finding key), ops as implementation intent (remove
  import A→B, extract interface I at path, A + B import I).
- **Expected delta** = step `delta`: resolved subjects, introduced subjects
  (none or listed), `byTier`, `net`; `blastRadius`; scan note if any.
- Implementation via `tea-rags:data-driven-generation`; Task ends w/ DDG Step 7
  gate line `GATE review_changes: introduced=<n>, partial=<true|false>`.

Separate sections, NEVER Tasks: **Trade-offs** (candidate, introduced vs
resolved by tier), **Unselected** (candidate, reason, detail), **Not ordered**
(report candidates on large repo), **Deferred** (over cap), **Escalated** (no
recipe), **Dropped** (MISFIT).

## Phase 6 — EXECUTION CONTRACT

Write this block into every generated plan, verbatim:

```text
Execution contract (refactoring-planning):
1. After each Task: review_changes(changes: {base: <commit before this Task>},
   sections: ["architecture"]) — compare change.resolved and introduced
   (findings + change.nonLocal) with the Task's expected delta.
2. Match → DDG Step 7 gate line, commit, next Task.
3. Diverged (expected resolved missing, or unexpected introduced) → DDG Step 7
   fix-at-write loop (≤ 2 rounds).
4. Not converging → get_architecture_report(path: <working dir>,
   restructurePlan: {candidates: <remaining Tasks' candidates>}) on the real
   tree; replace remaining Tasks with the new steps + expected deltas.
   Never continue on the stale plan.
```

## Output

```text
## Plan — <scope>: <S> steps, total net <n> (critical <r>/<i>, active <r>/<i>, structural <r>/<i>)
| # | Candidate | Rationale | Expected resolved | Introduced | byTier | Blast | Note |
## Trade-offs / Unselected / Not ordered / Deferred / Escalated / Dropped
Plan file: <path from writing-plans>
```
