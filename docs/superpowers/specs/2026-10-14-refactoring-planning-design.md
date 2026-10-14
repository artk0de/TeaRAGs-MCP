# Refactoring planning: diagnosis to a simulated, ordered plan

Bead: `tea-rags-mcp-cm9gt`. Depends on r8hme.21 (restructure mode), r8hme.53
(impact tiers) and xb669.2 (`plannedEdges`), all merged. Owner decisions are
from the 2026-10-14 brainstorm.

## Problem

`architecture-diagnostics` Phase 3i simulates each code-moving remedy on its
own: one `restructure` call per remedy, ranked by `net`. Nothing turns a
diagnosis into a plan:

- **No sequence.** Remedy deltas are joint, so step 2 may resolve nothing once
  step 1 has run, or it may introduce something on top of step 1.
- **No edge edits.** Most SDP, hub, leaking-abstraction and layering back-edge
  violations are cured by changing code (invert a dependency, extract an
  interface into contracts, cut an edge), not by moving files. `restructure`
  cannot express these, and the disappearance of the old edge is not modelled
  anywhere.
- **No hand-off.** The diagnosis never reaches `dinopowers:writing-plans`.

## Decisions (owner, 2026-10-14)

| Topic            | Decision                                                                                                                                                                                                                                                               |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scope            | Moves **and** edge edits. Removing the old edge is modelled; the old edge's disappearance resolves violations exactly like a move does.                                                                                                                                |
| Edge ops shape   | Server primitives `addFile` / `addEdge` / `removeEdge`. Inversion, interface extraction and back-edge cuts are recipes in `repair/<family>.md` that expand into primitives. The server knows no patterns.                                                              |
| Ordering         | Greedy batch mode on the server. Facts are read once, and every round judges all remaining candidates on top of the accepted prefix.                                                                                                                                   |
| Objective        | Lexicographic by tier, no weights: net resolved critical, then active, then structural. Ties go to the smaller summed blast radius of touched files. A candidate that introduces a critical or active violation is never auto-selected; it is reported as a trade-off. |
| Candidates       | Mixed. The server adds its own structural candidates (splitMerge split/merge, layer-map moves). The agent adds edge-edit candidates from repair recipes, choosing paths per the recipe and checking new names with `get_naming_lexicon`.                               |
| refactoring-scan | Annotation only. Steps touching tier 1/2 scan files get a "decompose X too" note; ordering ignores it.                                                                                                                                                                 |
| Divergence       | If a Task's real delta differs from the simulated one, the executor first repairs it with the DDG Step 7 loop. If that cannot converge, `restructurePlan` re-runs over the remaining candidates on top of the real state, and the plan is updated.                     |

## Server

### 1. Edge primitives in `restructure`

`ArchitectureRestructureOp` gains three kinds next to `move` / `split` /
`merge`:

| Op           | Shape                           | Effect on the hypothetical facts                                                                                                                                                          |
| ------------ | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `addFile`    | `{addFile: {file, component?}}` | A new production file. Its component comes from its path under the current partition unless `component` names an existing one.                                                            |
| `addEdge`    | `{addEdge: {from, to}}`         | A file import edge `from → to`, callWeight 1, since a code edit introduces a real use. Both ends must exist in the base facts or be added by an earlier `addFile` in the same hypothesis. |
| `removeEdge` | `{removeEdge: {from, to}}`      | Drops every base edge `from → to`. The edge must exist in the base facts.                                                                                                                 |

- **Application order.** Edge ops apply to `facts.production.graph` before
  `judge`, in op order. They go through the same application point as
  `applyArchitectureRestructure` (one applier, one compiled form), so the
  relabelled run and the edge-edited run are one hypothesis.
- **Edge identity.** An edge is identified by the `(from, to)` file pair.
- **Which detectors respond.** Edge ops move only the structural detectors:
  - SDP
  - hubLike
  - leakingAbstraction
  - layering
  - mainSequence
  - propagation cost

  The co-change detectors (shotgunSurgery, silentCoupling, splitMerge) read
  commit history and do not respond to hypothetical edges. The tool description
  says so.

- **Errors.**
  - An unknown file in `addEdge` or `removeEdge` that no earlier `addFile` added
    → `UnknownRestructureFileError` with the op index.
  - `removeEdge` of an edge absent from the base facts → a new
    `UnknownRestructureEdgeError` (`INPUT_UNKNOWN_RESTRUCTURE_EDGE`) with the op
    index.
  - `addFile` of an existing file → `InvalidParameterError`.
- **Limit.** The 20-op limit per hypothesis stays.

### 2. `restructurePlan` mode

A new `get_architecture_report` mode, exclusive with every other mode like
`restructure` and `plannedEdges`. Only `limit` may ride along.

```ts
restructurePlan?: {
  candidates: { id: string; rationale?: string; ops: ArchitectureRestructureOp[] }[]; // ≤ 50, each ≤ 20 ops
  includeReportCandidates?: boolean; // default true
}
```

**Algorithm:**

1. Read the facts once. Judge the base.
2. When `includeReportCandidates` is set, append the server-built candidates:
   - one per splitMerge split candidate (`split` op);
   - one per merge candidate (`merge` op);
   - one per layer-map move candidate (`move` op).

   They get ids `report:<kind>:<n>`.

3. Round loop. The prefix starts empty. Each round:
   1. Judge `prefix ∪ candidate` for every remaining candidate.
   2. Measure its delta against the judged prefix, not against the base, and
      attach impact tiers to both sides (r8hme.53 model, the same maintenance
      signals as `restructure`).
   3. A candidate whose delta introduces any critical or active violation goes
      to `tradeOffs` and leaves the pool.
   4. Pick the best remaining candidate lexicographically by:
      1. net resolved critical, where net = resolved − introduced;
      2. net active;
      3. net structural;
      4. smaller summed `transitiveImpact` of touched files (from the file
         payload signals);
      5. candidate id, for determinism.
   5. Stop when the best candidate's tier vector is not lexicographically
      positive, that is, no tier improves at the first tier that changes.
   6. Otherwise append the best candidate to the prefix and remove it from the
      pool.

   The stop condition needs no constants or step caps: the pool is finite.

4. **Ops conflicts.** A candidate whose ops no longer compile on top of the
   prefix is dropped with reason `conflictsWithPrefix` and the compile error.
   Examples: removing an edge an earlier step removed, or moving a file an
   earlier step deleted.

**Response:**

```ts
interface GetArchitectureRestructurePlanResponse {
  workingTree?: WorkingTreeMarker;
  mode: "restructurePlan";
  steps: {
    candidateId: string; source: "caller" | "report"; rationale?: string;
    ops: ArchitectureRestructureCompiledOp[];
    delta: ArchitectureRestructureDelta & { byTier: Record<"critical"|"active"|"structural", { resolved: number; introduced: number }> };
    touchedFiles: string[]; blastRadius: number;
  }[];
  tradeOffs: { candidateId: string; source: "caller" | "report"; delta: /* same as steps[].delta */ }[];
  unselected: { candidateId: string; reason: "noImprovement" | "conflictsWithPrefix"; detail?: string }[];
  total: ArchitectureRestructureDelta & { byTier: … }; // base vs final prefix
  timing: { factsMs: number; judgeCount: number; totalMs: number };
  unavailable?: "noCodegraph";
}
```

**Code placement:**

- New `ArchitectureRestructurePlanOps` next to `ArchitectureRestructureOps`
  (`api/internal/ops/`). It reuses `ArchitectureReportOps#judge`,
  `measureArchitectureViolationDelta`, the restructure compiler and the applier.
- No new code goes into `architecture-report-ops.ts`. It is a hotspot: 49
  commits, bugFix 45, 1076 LOC.
- Every new exported name passes `get_naming_lexicon`. The vocabulary is the
  existing `ArchitectureRestructure*` family.

**Cost:**

- Judges = Σ over rounds of the remaining pool size, at most ½·n·(n+1) + n.
- `timing.judgeCount` and `timing.totalMs` are always returned.
- Measure on taxdome during live validation. If a 30-candidate plan exceeds the
  MCP call budget, file a follow-up for incremental judging. Do not cap the
  candidates silently.

## Plugin

### 3. Recipes in `repair/<family>.md`

`repair/stableDependencies.md`, `hubLike.md`, `leakingAbstraction.md` and
`layeringBackEdge.md` each gain an **ops recipe** section. It expands the
family's code remedy into primitives, for example SDP inversion:

```
removeEdge A→B · addFile <contracts path per rule> · addEdge A→I · addEdge B→I
```

Each section also gives the path rule for the new file, derived from the
existing component tree and never hard-coded. DDG Step 7 and the new skill both
read these sections, and the sections live only here.

### 4. Skill `tea-rags:refactoring-planning` (user-invocable)

| Phase              | What the skill does                                                                                                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Report          | `get_architecture_report` on the scope, with impact tiers.                                                                                                                                                                                                                                                 |
| 2. Candidates      | For each critical/active finding, apply the family's ops recipe. Check new names with `get_naming_lexicon`. Judge new edges with `plannedEdges`; an edge with a MISFIT verdict is not proposed. One candidate per remedy, with `rationale` = the finding it targets.                                       |
| 3. Order           | One `restructurePlan` call with `includeReportCandidates: true`.                                                                                                                                                                                                                                           |
| 4. Annotate        | Run `tea-rags:refactoring-scan` over the touched files of the steps. Tier 1/2 hits become a note on the step.                                                                                                                                                                                              |
| 5. Plan            | Hand the steps to `dinopowers:writing-plans`. One step is one Task, carrying the expected delta (resolved / introduced subjects, byTier) and the DDG Step 7 gate. Present trade-offs and unselected candidates separately, never as plan Tasks.                                                            |
| Execution contract | Written into every generated plan: after each Task, compare the `review_changes` architecture delta with the expected delta. On divergence, repair through the Step 7 loop; if it does not converge, call `restructurePlan` with the remaining candidates on the real tree and update the remaining Tasks. |

**Placement in the plugin:**

- `architecture-diagnostics` Phase 3i points to this skill for multi-step plans.
- The search-cascade decision tree gains one line: "plan a refactoring" →
  `/tea-rags:refactoring-planning`.
- Bump the plugin version; this is a new skill, so a minor bump.
- Caveman compression per `.claude/rules/caveman-compression.md`:
  - description: `full`;
  - body: `ultra`.

## Testing

**Unit tests, red first:**

- **Edge ops:**
  - removeEdge resolves an SDP finding;
  - addEdge introduces one;
  - an inversion recipe (remove plus add via a new contracts file) nets
    negative;
  - each error case raises its typed error.
- **Plan mode:**
  - the greedy pick respects tier order over raw count;
  - the blast-radius tie-break applies;
  - a trade-off candidate is never selected;
  - a candidate made redundant by an earlier step lands in `unselected`
    (`noImprovement`);
  - a prefix conflict lands in `unselected` (`conflictsWithPrefix`);
  - the stop condition holds;
  - the order is deterministic on equal vectors.
- **Contract and wiring:**
  - the MCP schema and tool description, with the tools/list byte delta
    reported;
  - mode exclusivity.

**Skill evals** in `.claude-plugin/.benchmarks/` (agent behaviour), at least 6
cases:

- recipe expansion for SDP inversion;
- the MISFIT planned edge is dropped;
- trade-offs are not turned into Tasks;
- the divergence path re-plans;
- the scan annotation does not reorder;
- report candidates are included.

**Live validation:**

- `restructurePlan` on tea-rags self and on taxdome (read-only): steps,
  `total.net`, `timing`.
- The edge ops verified on a known SDP finding: inverting it through contracts
  resolves it in the delta.

## Out of scope

- Simulating co-change detectors under hypothetical edits.
- Incremental judging; file a follow-up only if taxdome timing demands it.
- Auto-executing the plan; execution stays with `dinopowers:executing-plans`.
