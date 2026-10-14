# Refactoring Planning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> dinopowers:subagent-driven-development (recommended) or
> dinopowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn an architecture diagnosis into an ordered, simulated refactoring
plan: edge-edit primitives in `restructure`, a greedy `restructurePlan` mode on
`get_architecture_report`, ops recipes per repair family, and a user-invocable
`tea-rags:refactoring-planning` skill that hands the steps to
`dinopowers:writing-plans`.

**Architecture:** The restructure compiler learns three edge ops (`addFile`,
`addEdge`, `removeEdge`). They compile into the same relabel value as
`move`/`merge`/`split` and apply to `facts.production.graph` through the same
applier, so one hypothesis can mix moves and edge edits. A new
`ArchitectureRestructurePlanOps` reads the facts once, judges
`prefix ∪ candidate` for each remaining candidate per round, and appends the
best one by a lexicographic tier vector. The plugin side is prose: recipes
expand each family's code remedy into primitives, and the skill orchestrates
report → candidates → plan → annotate → writing-plans.

**Tech Stack:** TypeScript, Vitest, zod (MCP schema), Markdown skills and evals.

**Spec:** `docs/superpowers/specs/2026-10-14-refactoring-planning-design.md`
(bead `tea-rags-mcp-cm9gt`).

## Global Constraints

- Edge identity is the `(from, to)` file pair. `addEdge` carries callWeight 1.
- Edge ops move only structural detectors (SDP, hubLike, leakingAbstraction,
  layering, mainSequence, propagation cost); co-change detectors do not respond,
  and the tool description says so.
- Errors: unknown file → `UnknownRestructureFileError`; `removeEdge` of an
  absent edge → new `UnknownRestructureEdgeError`
  (`INPUT_UNKNOWN_RESTRUCTURE_EDGE`); `addFile` of an existing file →
  `InvalidParameterError`.
- `ARCHITECTURE_RESTRUCTURE_OP_LIMIT = 20` per hypothesis stays; a plan
  candidate holds ≤ 20 ops, a plan request ≤ 50 candidates.
- Plan objective: lexicographic net resolved critical → active → structural →
  smaller summed `transitiveImpact` of touched files → candidate id. No weights,
  no constants, no step cap. A candidate introducing any critical or active
  violation is a trade-off, never selected.
- No new code in `src/core/api/internal/ops/architecture-report-ops.ts`
  (hotspot: 49 commits, bugFixRate 45, 1076 LOC).
- Every new exported name passes `get_naming_lexicon`; vocabulary is the
  existing `ArchitectureRestructure*` family.
- Adaptive rules only: no framework or project names hard-coded anywhere.
- All code through `/tea-rags:data-driven-generation`, red-first, Step 7
  `review_changes` loop before each commit. No `--no-verify`, no
  `eslint-disable`, no threshold changes.
- Files touched here are artk0de silo files: every commit carries a `Why:` line
  (`.claude/rules/silo-pairing.md`).

### tea-rags impact enrichment (rerank: blastRadius)

| File                                                                                    | Signals                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------- |
| `src/core/api/public/dto/architecture.ts`                                               | hub, fanIn 19, transitiveImpact 113, 20 cmt |
| `src/core/contracts/types/architecture-report.ts`                                       | hub, fanIn 17, transitiveImpact 189         |
| `src/core/api/public/errors.ts`                                                         | hub, fanIn 16, transitiveImpact 103         |
| `src/core/domains/trajectory/codegraph/symbols/restructure/architecture-restructure.ts` | transitiveImpact 100, 1 cmt                 |
| `src/core/api/internal/facades/graph-facade.ts`                                         | 38 cmt, fanOut 21 — wiring only             |
| `src/core/api/internal/composition.ts` / `app-factory.ts`                               | 43 cmt, fanOut 44 — wiring only             |

Hub files take additive edits only, each pinned by a contract test. Proven
template (L1): `ArchitectureRestructureOps#simulate` +
`applyArchitectureRestructure`.

---

### Task 1: Edge primitives in the restructure compiler and applier

**Model:** opus. **Runs in parallel with Task 3.**

**Files:**

- Modify: `src/core/contracts/types/architecture-report.ts`
  (`ArchitectureRestructureOp`, `ArchitectureRestructureCompiledOp`)
- Modify:
  `src/core/domains/trajectory/codegraph/symbols/restructure/architecture-restructure.ts`
- Modify: `src/core/api/public/errors.ts` (new `UnknownRestructureEdgeError`)
- Modify: `src/core/api/internal/ops/architecture-restructure-ops.ts`
  (compile-failure → error mapping; pass the edge base)
- Modify: `src/mcp/tools/codegraph.ts` (zod union + description sentence)
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/restructure/architecture-restructure.test.ts`
- Test: `tests/core/api/internal/ops/architecture-restructure-ops.test.ts`
- Test: the MCP schema test that already pins the `restructure` union (find it
  with `hybrid_search(query: "restructure", testFile: "only")`)

**Interfaces:**

- Produces (contract):

  ```ts
  export type ArchitectureRestructureOp =
    | { move: { files: RelPath[]; toComponent: string } }
    | { merge: { components: string[] } }
    | { split: { component: string; groups: RelPath[][] } }
    | { addFile: { file: RelPath; component?: string } }
    | { addEdge: { from: RelPath; to: RelPath } }
    | { removeEdge: { from: RelPath; to: RelPath } };

  export interface ArchitectureRestructureCompiledOp {
    op: "move" | "merge" | "split" | "addFile" | "addEdge" | "removeEdge";
    relabelledFiles: number; // 0 for edge ops
    components: string[]; // addFile: [its component]; addEdge/removeEdge: []
    edge?: { from: RelPath; to: RelPath }; // addEdge / removeEdge only
    file?: RelPath; // addFile only
  }
  ```

- Produces (domain):

  ```ts
  /** The base file edges edge ops are checked against, keyed by `(from, to)`. */
  export interface ArchitectureRestructureEdgeBase {
    fileEdges: ReadonlySet<string>; // architectureRestructureEdgeKey(from, to)
  }
  export function architectureRestructureEdgeKey(from: RelPath, to: RelPath): string;

  // compileArchitectureRestructure(ops, partition, edgeBase?) — edgeBase absent ⇒ every removeEdge fails
  // ArchitectureRestructureRelabel gains:
  edgeEdits: {
    addedFiles: { relPath: RelPath; component?: string }[];
    addedEdges: { from: RelPath; to: RelPath }[];
    removedEdges: ReadonlySet<string>; // edge keys
  };
  // ArchitectureRestructureCompilation gains:
  | { kind: "unknownEdge"; opIndex: number; from: RelPath; to: RelPath }
  ```

- Produces (api):
  `class UnknownRestructureEdgeError extends InputValidationError` with
  `constructor(from: string, to: string, opIndex: number)`, code
  `INPUT_UNKNOWN_RESTRUCTURE_EDGE`.

**Compile rules (exact):**

1. Edge ops name **base paths**. A path is known when the partition holds it or
   an earlier `addFile` in the same op list added it.
2. `addFile`: path already in the partition or already added → `invalidOp`
   ("<file> already exists"). `component` given and unknown →
   `unknownComponent`. With `component` the file is pinned through
   `componentOf`; without, the judge derives its component from the path.
3. `addEdge`: unknown endpoint → `unknownFile` listing the unknown ones.
   `from === to` → `invalidOp`. An edge already in the base or already added →
   `invalidOp` ("edge already present").
4. `removeEdge`: unknown endpoint → `unknownFile`. Key absent from
   `edgeBase.fileEdges`, or already removed by an earlier op → `unknownEdge`.
   Removing an edge an earlier op added → `invalidOp`.
5. Edge ops never relabel and never conflict with the one-op-per-file rule of
   `move`/`merge`/`split`.

**Apply rules (exact):** in `applyArchitectureRestructure`, edge edits apply on
base paths BEFORE the rename map: drop every base edge whose key is in
`removedEdges` (all call sites of that pair), append one file record per added
file (shape copied from the graph's existing file record type with empty
heritage), append one edge per added edge with callWeight 1, then rename every
path as today. Member edges and co-change data are untouched.

- [ ] **Step 1: Write the failing domain tests** in
      `architecture-restructure.test.ts`: compile of each new op, each failure
      kind from the rules above, removeEdge-twice → `unknownEdge`, removing an
      added edge → `invalidOp`, and apply: a removed pair disappears entirely,
      an added edge appears once with callWeight 1, an added file appears in
      `graph.files`, a move in the same hypothesis renames an endpoint of an
      added edge.
- [ ] **Step 2: Run**
      `npx vitest run tests/core/domains/trajectory/codegraph/symbols/restructure`
      — expect FAIL (unknown op kinds).
- [ ] **Step 3: Implement** the contract types, `RestructureCompiler` branches,
      `edgeEdits` accumulation and the applier step.
- [ ] **Step 4: Write the failing ops tests** in
      `architecture-restructure-ops.test.ts` on an in-memory graph DB fixture
      (reuse the existing fixture in that file):
  - `removeEdge` of the edge behind an SDP violation → that violation in
    `delta.resolved`;
  - `addEdge` from a stable to an unstable component → an SDP violation in
    `delta.introduced`;
  - inversion recipe
    `removeEdge A→B · addFile <contracts path> · addEdge A→I · addEdge B→I` →
    `delta.net < 0`;
  - `UnknownRestructureEdgeError`, `UnknownRestructureFileError`,
    `InvalidParameterError` each raised with the op index.
- [ ] **Step 5: Implement** in `ArchitectureRestructureOps#simulate`: build
      `edgeBase` from `facts.production.graph.edges` and map `unknownEdge` to
      `UnknownRestructureEdgeError`. Move the compile-failure switch into an
      exported `throwArchitectureRestructureCompileFailure(compilation)` so Task
      2 reuses it.
- [ ] **Step 6: MCP schema.** Extend the zod union with the three objects; add
      one description sentence: "Edge ops addFile{file,component?} |
      addEdge{from,to} | removeEdge{from,to} (base paths) move structural
      detectors only; co-change detectors read history and do not respond." Add
      the schema test case; report the tools/list byte delta in the commit body.
- [ ] **Step 7: Verify** `npx tsc --noEmit`, targeted vitest dirs, eslint on
      touched files, then DDG Step 7 `review_changes`.
- [ ] **Step 8: Commit**

  ```
  feat(api): restructure edge ops addFile/addEdge/removeEdge (cm9gt)

  Why: code remedies (inversion, interface extraction, back-edge cuts) change
  edges, not file homes; without removeEdge the old edge's disappearance was
  not modelled.
  ```

---

### Task 2: `restructurePlan` mode

**Model:** opus. **After Task 1 merges.**

**Files:**

- Create: `src/core/api/internal/ops/architecture-restructure-plan-ops.ts`
- Modify: `src/core/api/internal/ops/architecture-restructure-ops.ts` (export
  the shared helpers: `relabelledSignals`, `restructureDelta`,
  `throwArchitectureRestructureCompileFailure`; no behaviour change)
- Modify: `src/core/api/public/dto/architecture.ts` (request field, response
  types, limit constant)
- Modify: `src/core/api/public/app.ts`, `src/core/api/internal/app-factory.ts`,
  `src/core/api/internal/facades/graph-facade.ts` (wiring, mirroring
  `simulateArchitectureRestructure`)
- Modify: `src/mcp/tools/codegraph.ts` (schema field, invoke branch, description
  sentence)
- Test: `tests/core/api/internal/ops/architecture-restructure-plan-ops.test.ts`
- Test: mode-exclusivity and schema tests beside the existing restructure ones

**Interfaces:**

- Consumes: Task 1's op union,
  `compileArchitectureRestructure(ops, partition, edgeBase)`,
  `throwArchitectureRestructureCompileFailure`, `ArchitectureReportOps#judge`,
  `measureArchitectureViolationDelta`.
- Produces (DTO):

  ```ts
  export const ARCHITECTURE_RESTRUCTURE_PLAN_CANDIDATE_LIMIT = 50;

  export interface ArchitectureRestructurePlanCandidate {
    id: string; // must not start with "report:"
    rationale?: string;
    ops: ArchitectureRestructureOp[]; // 1..ARCHITECTURE_RESTRUCTURE_OP_LIMIT
  }
  // GetArchitectureReportRequest gains:
  restructurePlan?: {
    candidates: ArchitectureRestructurePlanCandidate[]; // 0..50 (0 allowed when includeReportCandidates)
    includeReportCandidates?: boolean; // default true
  };

  export type ArchitectureRestructureTierTally = Record<
    ArchitectureViolationImpactTier,
    { resolved: number; introduced: number }
  >;
  export interface ArchitectureRestructurePlanDelta extends ArchitectureRestructureDelta {
    byTier: ArchitectureRestructureTierTally;
  }
  export interface ArchitectureRestructurePlanStep {
    candidateId: string;
    source: "caller" | "report";
    rationale?: string;
    ops: ArchitectureRestructureCompiledOp[];
    delta: ArchitectureRestructurePlanDelta; // vs the prefix before this step
    touchedFiles: string[]; // base paths the ops name, sorted
    blastRadius: number; // Σ transitiveImpact of touchedFiles
  }
  export interface GetArchitectureRestructurePlanResponse {
    workingTree?: WorkingTreeMarker;
    mode: "restructurePlan";
    steps: ArchitectureRestructurePlanStep[];
    tradeOffs: { candidateId: string; source: "caller" | "report"; rationale?: string; delta: ArchitectureRestructurePlanDelta }[];
    unselected: { candidateId: string; source: "caller" | "report"; reason: "noImprovement" | "conflictsWithPrefix"; detail?: string }[];
    total: ArchitectureRestructurePlanDelta; // base vs final prefix
    timing: { factsMs: number; judgeCount: number; totalMs: number };
    unavailable?: "noCodegraph";
  }
  ```

- Produces (app):
  `App#planArchitectureRestructure(req: GetArchitectureReportRequest): Promise<GetArchitectureRestructurePlanResponse>`,
  `GraphFacade#planArchitectureRestructure`,
  `ArchitectureRestructurePlanOps#plan(graphDb, request, lookups)` and
  `ArchitectureRestructurePlanOps.unavailable(request)`.

**Algorithm (exact):**

1. Validate: `restructurePlan` exclusive with `restructure`, `plannedEdges` and
   every option in `REPORT_ONLY_OPTIONS`; only `limit` rides along. Candidate
   ids unique, caller ids never prefixed `report:`; each candidate 1..20 ops; ≤
   50 caller candidates. Violations → `InvalidParameterError`.
2. Read facts once (`readArchitectureGraphFacts`), derive the partition and the
   edge base, read maintenance signals once. Compile every caller candidate
   alone against the base: a failure is the caller's error and throws through
   `throwArchitectureRestructureCompileFailure` (an input bug, not a conflict).
3. Judge the base (uncapped). When `includeReportCandidates !== false`, build
   report candidates from that judged base: one `split` per splitMerge split
   candidate (`groups = files`), one `merge` per merge candidate
   (`[componentA, componentB]`), ids `report:split:<n>` / `report:merge:<n>` in
   report order. Layer-map move candidates are not built: the base judge has no
   layer-map scope.
4. Rounds. `prefixOps = []`, `prefixRun = base`. Each round, for every pool
   candidate in id order: compile `prefixOps ++ candidate.ops` (no op limit on
   the concatenation). Failure → `unselected` with `conflictsWithPrefix` and the
   failure text, leave pool. Else judge it, delta vs `prefixRun` with
   `measureArchitectureViolationDelta`, tally `byTier` (introduced tiers from
   the candidate run, resolved from the prefix run; an untiered violation counts
   as `structural`). Any introduced critical or active → `tradeOffs`, leave
   pool.
5. Score vector per remaining candidate: `[netC, netA, netS]` where
   `net = resolved − introduced`. Pick the max by lexicographic compare, ties by
   smaller `blastRadius`, then by id.
6. Stop when the pick's vector is not lexicographically positive (first non-zero
   entry ≤ 0, or all zero). Every remaining pool candidate → `unselected` with
   `noImprovement`. Else append the pick as a step, extend `prefixOps`, set
   `prefixRun` to its judged run, remove it from the pool.
7. `total` = delta base vs final `prefixRun`. `timing.judgeCount` counts every
   `judge` call including the base.

`blastRadius`: read `codegraph.file.transitiveImpact` per touched file through
the same lookup family the report already uses for file signals; a file with no
value (an added file) contributes 0. If no such lookup exists, add one as a
`ArchitectureRestructureLookups` member wired in the facade, mirroring
`readFileMaintenanceSignals`.

- [ ] **Step 1: Write failing tests** in
      `architecture-restructure-plan-ops.test.ts` on a graph fixture with two
      SDP violations and one layering violation:
  - tier order beats raw count: a candidate resolving 1 critical is picked
    before one resolving 3 structural;
  - blast-radius tie-break on equal vectors;
  - a trade-off candidate (introduces active) is never a step and appears in
    `tradeOffs`;
  - a candidate made redundant by an earlier step lands in `unselected`
    (`noImprovement`);
  - two candidates removing the same edge: the second lands in `unselected`
    (`conflictsWithPrefix`);
  - stop condition: the loop ends with candidates left when none improves;
  - determinism: equal vectors and blast radius order by id;
  - `includeReportCandidates: false` yields no `report:` ids; default yields
    them when the fixture has splitMerge candidates;
  - `timing.judgeCount` equals 1 + Σ pool sizes per round.
- [ ] **Step 2: Run**
      `npx vitest run tests/core/api/internal/ops/architecture-restructure-plan-ops.test.ts`
      — FAIL.
- [ ] **Step 3: Implement** `ArchitectureRestructurePlanOps` and the DTO.
- [ ] **Step 4: Wiring tests** — mode exclusivity (each forbidden pairing →
      `InvalidParameterError`), MCP schema accepts the field, invoke routes to
      `planArchitectureRestructure`, unavailable path returns
      `unavailable: "noCodegraph"` with empty arrays.
- [ ] **Step 5: Implement** wiring and the MCP description sentence:
      "restructurePlan mode: greedy ordered plan over candidate hypotheses
      {id,rationale?,ops} (+ report split/merge candidates); per round judges
      prefix+candidate, picks by net critical > active > structural > blast
      radius; trade-offs (introduce critical/active) never selected." Report the
      tools/list byte delta in the commit body.
- [ ] **Step 6: Verify** tsc, targeted vitest, eslint, DDG Step 7.
- [ ] **Step 7: Commit**

  ```
  feat(api): restructurePlan mode — greedy simulated refactoring order (cm9gt)

  Why: remedy deltas are joint; ranking them one call each cannot order a
  sequence where step 2 depends on step 1.
  ```

---

### Task 3: Ops recipes in the repair files

**Model:** sonnet. **Runs in parallel with Task 1.** Prose only; no DDG.

**Files:**

- Modify: `.claude-plugin/tea-rags/repair/stableDependencies.md`
- Modify: `.claude-plugin/tea-rags/repair/hubLike.md`
- Modify: `.claude-plugin/tea-rags/repair/leakingAbstraction.md`
- Modify: `.claude-plugin/tea-rags/repair/layeringBackEdge.md`

**Interfaces:**

- Produces: one `## Ops recipe` section per file. Each section has (a) the
  primitive sequence for the family's code remedy, using exactly the op shapes
  from Task 1 (`removeEdge{from,to}`, `addFile{file,component?}`,
  `addEdge{from,to}`, plus `move` where the remedy is a move), (b) the path rule
  for any new file, derived from the report's own component tree (e.g. "the
  foundation component `summary.foundation` names, nearest to both endpoints"),
  never a hard-coded directory, (c) one worked example in the shape of the
  report's finding fields, (d) a line: "simulate with
  `get_architecture_report restructure` before writing; the skill
  `tea-rags:refactoring-planning` orders several".

Recipes to write:

- **stableDependencies (inversion):**
  `removeEdge A→B · addFile <I in the foundation> · addEdge A→I · addEdge B→I`.
- **hubLike (split the hub's afferent surface):** per consumer cluster,
  `addFile <narrow interface beside the hub>` · `removeEdge consumer→hub` ·
  `addEdge consumer→interface` · `addEdge hub→interface`.
- **leakingAbstraction:** `removeEdge importer→deep file` ·
  `addEdge importer→module facade`. The facade must already exist. A relabel
  never creates an entry file, so the recipe exports through the existing facade
  and never `addFile`s one.
- **layeringBackEdge:** cut by inversion like SDP, or `move` the file to the
  lower layer when it has no upward dependency.

- [ ] **Step 1:** Read each file's existing structure with
      `find_symbol(relativePath: ...)`; add the section after the existing
      procedure, matching its heading depth and caveman density.
- [ ] **Step 2:** `npx prettier --write` on the four files; markdownlint if
      available.
- [ ] **Step 3: Commit**

  ```
  docs(api): ops recipes for SDP, hub, leaking and back-edge repairs (cm9gt)

  Why: the planning skill and DDG Step 7 expand code remedies into restructure
  primitives; the expansion lives once, beside each family's repair procedure.
  ```

---

### Task 4: Skill `tea-rags:refactoring-planning`

**Model:** opus. **After Tasks 2 and 3 merge.** Prose and evals; no DDG.

**Files:**

- Create: `.claude-plugin/tea-rags/skills/refactoring-planning/SKILL.md`
- Create: `.claude-plugin/.benchmarks/refactoring-planning/` (eval cases in the
  format the sibling `architecture-diagnostics/` benchmark uses)
- Modify: `.claude-plugin/tea-rags/skills/architecture-diagnostics/SKILL.md`
  (Phase 3i pointer, one line)
- Modify: `.claude-plugin/tea-rags/rules/search-cascade.md` (decision tree line
  `Plan a refactoring → /tea-rags:refactoring-planning`)
- Modify: the tea-rags plugin manifest version (minor bump; locate via
  `.claude/rules/` plugin-versioning rule)

**Interfaces:**

- Consumes: `restructurePlan` request/response from Task 2, recipe sections from
  Task 3, `plannedEdges` verdicts (`MISFIT`), `get_naming_lexicon`,
  `tea-rags:refactoring-scan`, `dinopowers:writing-plans`.
- Produces: user-invocable skill; frontmatter `description` in caveman `full`,
  body in caveman `ultra` (`.claude/rules/caveman-compression.md`).

Skill phases (spec §4):

1. Report: `get_architecture_report` on the scope with impact tiers.
2. Candidates: per critical/active finding apply the family recipe; names via
   `get_naming_lexicon`; new edges through `plannedEdges` — a `MISFIT` edge is
   not proposed; one candidate per remedy, `rationale` = the finding key.
3. Order: one `restructurePlan` call, `includeReportCandidates: true`.
4. Annotate: `tea-rags:refactoring-scan` over the steps' touched files; tier 1/2
   hits become a note; ordering ignores it.
5. Plan: `dinopowers:writing-plans`; one step = one Task carrying expected delta
   (resolved/introduced subjects, byTier) and the DDG Step 7 gate; trade-offs
   and unselected listed separately, never Tasks.
6. Execution contract written into every generated plan: compare each Task's
   `review_changes` architecture delta with the expected one; diverged → Step 7
   repair loop; not converging → `restructurePlan` with the remaining candidates
   on the real tree, update the remaining Tasks.

- [ ] **Step 1: Write the evals first** (≥ 6 cases): recipe expansion for SDP
      inversion; MISFIT planned edge dropped; trade-offs not turned into Tasks;
      divergence path re-plans; scan annotation does not reorder; report
      candidates included.
- [ ] **Step 2:** Run the eval harness the sibling benchmarks use against the
      current plugin (no skill yet) — record the failing baseline.
- [ ] **Step 3:** Write `SKILL.md`, the Phase 3i pointer, the cascade line, the
      version bump.
- [ ] **Step 4:** Re-run the evals — all pass; prettier on touched Markdown.
- [ ] **Step 5: Commit**

  ```
  feat(api): tea-rags:refactoring-planning skill (cm9gt)

  Why: a diagnosis never reached a plan; this orders simulated remedies and
  hands them to writing-plans with an expected delta per Task.
  ```

---

## Orchestrator steps (not agent work)

1. Merge each task branch via `merge-fn.sh run …` with its targeted tests;
   confirm `MERGED`.
2. After Task 2 merges: build main, live `restructurePlan` on tea-rags
   (`node build/cli/index.js call get_architecture_report '{"path":…,"restructurePlan":{"candidates":[]}}'`)
   and on taxdome (read-only): record steps, `total.net`, `timing`. If a
   30-candidate plan exceeds the MCP call budget, file the incremental-judging
   follow-up.
3. Live SDP inversion check: pick one SDP finding on tea-rags, run the Task 3
   recipe through `restructure`, confirm the finding is in `delta.resolved`.
4. One `npm run test:coverage` on main with the session's other merges.
5. Close cm9gt citing the merge commits and the live numbers.
