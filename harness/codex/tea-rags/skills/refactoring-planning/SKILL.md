---
name: refactoring-planning
description:
  'Turn architecture diagnosis into an ordered, simulated refactoring plan —
  findings → restructure ops → restructurePlan order → Tasks for writing-plans.
  Triggers "plan a refactoring", "plan the architecture fix", "in what order to
  fix these violations", "refactoring roadmap", "спланируй рефакторинг". NOT
  diagnosis alone (architecture-diagnostics), NOT one in-file change
  (data-driven-generation), NOT health scan (risk-assessment).'
---

# Refactoring Planning

Diagnosis → simulated candidates → server-ordered steps → plan Tasks w/ expected
delta. Server orders; agent builds candidates + plan. Execute YOURSELF, tea-rags
tools only.

Lag / drift ≠ licence to leave tea-rags (core). Own checkout, `changedFiles` > 0
→ incremental `index_codebase`; subagent / linked worktree → never reindex. →
`tea-rags://guide/freshness`.

## Phase Order (MANDATORY)

0. GATE — codegraph on?
1. REPORT — one `get_architecture_report`
2. CANDIDATES — recipe per critical/active finding; lexicon + `plannedEdges`
3. ORDER — `restructurePlan` (report candidates per cost rule)
4. ANNOTATE — `$refactoring-scan`, notes only
5. PLAN — `writing-plans`, one step = one Task
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

Codegraph on = graph tools (`get_callers`, `trace_path`, …) in tool list; unsure
→ `tea-rags://project/<alias>/metrics?section=registry` shows
`codegraph on|off`. Off → "refactoring planning needs codegraph", stop. Any
plan-mode answer `unavailable: "noCodegraph"` → stop, same line.

## Phase 1 — REPORT

`get_architecture_report(path: "<working dir>", pathPattern?|domain?, limit?)` —
reading per `$architecture-diagnostics` Phase 1 (do not restate). Keep:

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
  per recipe's path rule (never hard-coded dir). SDP inversion: A = finding's
  `sourceRelPath`, B = its `toRelPath` — FILES, never the component dirs of the
  finding key; spelled: `removeEdge{A,B}`,
  `addFile{<foundation>/…/<Iface>.ts, abstract: true}`, `addEdge{A,iface}`,
  `addEdge{B,iface}` — rationale = finding key.
- Recipe says "no recipe, escalate" → no candidate; list under Escalated.
- Names: ONE `get_naming_lexicon` call over all drafted new-file / type names.
  `MISFIT` / `COLLISION` → rename to suggestion; `NEW_TERM` → keep + one-line
  why.
- Edges: ONE `get_architecture_report(path, plannedEdges: [...])` over every
  `addEdge` between EXISTING files. `MISFIT` → drop candidate, line
  `DROPPED <id> — MISFIT <src> -> <dst> (established <roleSrc> -> <roleDst>, support <n>)`.
  `UNJUDGED newFile` / `NEW_PATTERN` / `CONFORMS` → keep.
- Candidate = `{id, rationale: <finding key>, ops}` — one per remedy, ≤ 20 ops.
  `rationale` = the finding `key` string verbatim (e.g.
  `stableDependencies:<A dir>-><B dir>`), not prose. Write each candidate out in
  the answer: every op with its concrete paths, the new file under the
  foundation component — never "form candidate from recipe". `id` kebab
  `<family>-<short subject>`, never `report:` prefix (server owns it).
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
   `includeReportCandidates: false` (always safe), ≤ 15 own candidates (critical
   first; rest Deferred — never all of them). It yields S + per-judge.
3. Estimate (S + 2)·(K + R)·perJudge + factsMs. ≤ ~2 min (one MCP call) →
   re-call same candidates, `includeReportCandidates` omitted (true); that plan
   supersedes. Over → large repo: keep the `false` plan, say verbatim (bd id
   included) "report split/merge candidates not ordered — quadratic judging,
   call can run ~1 h (bd tea-rags-mcp-vytjl)", list them under Not ordered (each
   simulable alone via architecture-diagnostics Phase 3i). Never drop them
   silently.

Large repo = estimate over budget; N ≥ ~10k judged files with dozens of R → skip
the estimate, go `false` directly — still ≤ 15 candidates, and say why citing bd
tea-rags-mcp-vytjl.

Read response: `steps[]` (order = plan order; `delta` vs prefix, `byTier`,
`touchedFiles`, `blastRadius`), `tradeOffs[]` (introduce critical/active — never
selected), `unselected[]` (`noImprovement` | `conflictsWithPrefix` + `detail`),
`total` (base vs final prefix). Unknown file / edge → typed error
(`INPUT_UNKNOWN_RESTRUCTURE_*`) → fix name, re-call; never drop candidate.

## Phase 4 — ANNOTATE

`$refactoring-scan` over union of steps' `touchedFiles`. Tier 1/2 hit on file F
in step k → note on step k: "F — decompose too (<signals>)". Order unchanged; no
Task added; no step removed.

## Phase 5 — PLAN

`writing-plans`. One step = one Task, step order. Per Task:

- `candidateId`, `rationale` (finding key), ops as implementation intent (remove
  import A→B, extract interface I at path, A + B import I).
- **Expected delta** = step `delta`: resolved subjects, introduced subjects
  (none or listed), `byTier`, `net`; `blastRadius`; scan note if any.
- Implementation via `$data-driven-generation`; Task ends w/ DDG Step 7 gate
  line, quoted literally in the Task:
  `GATE review_changes: introduced=<n>, partial=<true|false>`.

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

Show, never summarize: candidate ops with paths, Task expected delta, the gate
line and the Phase 6 contract block appear in the answer as text — "Task
includes expected delta and execution contract" is not the plan.

```text
## Plan — <scope>: <S> steps, total net <n> (critical <r>/<i>, active <r>/<i>, structural <r>/<i>)
| # | Candidate | Rationale | Expected resolved | Introduced | byTier | Blast | Note |
## Trade-offs / Unselected / Not ordered / Deferred / Escalated / Dropped
Plan file: <path from writing-plans>
```
