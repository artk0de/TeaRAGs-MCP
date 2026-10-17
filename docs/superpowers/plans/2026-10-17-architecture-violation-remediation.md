# Plan: Architecture Violation Remediation — tea-rags

- **Date**: 2026-10-17
- **Source**: `get_architecture_report` at indexed commit `c92ca2d` (overlay to
  tree `23b42fc`), `restructurePlan` simulation 2026-10-17
- **Scope**: 45 architecture violations (0 critical, 0 active, 5 SDP structural,
  40 untiered history/layout findings)
- **Plan total**: 2 steps, net **−3** (resolved 5, introduced 2, persisting 40)
- **Ordering**: server-ordered via `restructurePlan` (63 simulated judge rounds,
  per-judge ≈ 1.2 s)
- **Tracking**: epic `tea-rags-mcp-54xwd` — hardening: eliminate all above-low
  architecture violations (14 children, `.1`–`.14`). Severity cut published
  2026-10-17: HIGH = structural tier + design decisions; MEDIUM =
  expectedSupport ≤ 0.03 shotgun bundles, silentCoupling strength ≥ 0.55 with 4+
  partners, top-cost composition cycles, runtime import cycles, mainSequence
  0.503; LOW (out of scope by owner decision) = expectedSupport ≥ 0.15 bundles,
  barrel-vs-subfolder layout cycles, the type-only 12-file contracts cycle,
  islands. This plan carries beads `.1`–`.2`; beads `.3`–`.14` are the above-low
  remainder this plan does not reach.

## Task 1 — Merge `src/mcp/tools` into `src/core/api`

- **Bead**: `tea-rags-mcp-54xwd.1` (epic `tea-rags-mcp-54xwd` — hardening:
  eliminate all above-low architecture violations)
- **candidateId**: `report:merge:8` (source: report; co-change support 122,
  strength 0.575)
- **Rationale**: `src/core/api` ↔ `src/mcp/tools` is the strongest
  silent-coupling pair in the repo; the merge absorbs the unstable tools
  component (I 0.94) into the api component it already serves, removing two
  structural SDP violations at once.
- **Ops** (implementation intent): relocate `src/mcp/tools/**` (18 files) under
  the `src/core/api` component; update import sites and re-export wiring; no
  behavior change.

```text
merge { components: ["src/core/api", "src/mcp/tools"] }
```

- **Expected delta** (from simulation, must match on verification):
  - resolved (4): SDP `src/bootstrap → src/mcp/tools` (structural); SDP
    `src/core/api → trajectory/codegraph/working-tree` (structural);
    shotgunSurgery ×2 (weighted-5/8-components and weighted-6/3-components
    bundles)
  - introduced (2, EXPECTED — not divergence): `leakingAbstraction.facade`
    `src/bootstrap/factory.ts → src/mcp/tools/index.ts` (structural — after the
    merge the deep import passes the api facade); shotgunSurgery ×1
    (weighted-5/7-components)
  - byTier: structural resolved 4 / introduced 2; critical/active 0/0
  - net **−2**, persisting 41
- **Blast radius**: 306 files. **Touched**: the 18 `src/mcp/tools/*` files
  (code.ts, code/register-\*.ts, code/shared.ts, codegraph.ts, collection.ts,
  document.ts, explore.ts, formatters/enrichment.ts, index.ts, list-projects.ts,
  output-schemas.ts, register-project.ts, review-changes.ts, schemas.ts,
  unregister-project.ts).
- **Scan note**: `src/mcp/tools/codegraph.ts` — decompose too (burst 31.0, 78
  commits, 673 LOC with oversized schema builders; 5 of top-10 hotspot slots).
  Do it as a follow-up task, not inside this one.
- **Implementation**: `tea-rags:data-driven-generation`; end the Task with
  `GATE review_changes: introduced=<n>, partial=<true|false>`.

## Task 2 — Extract `CollectionFootprintPort` into contracts

- **Bead**: `tea-rags-mcp-54xwd.2` (epic `tea-rags-mcp-54xwd`)
- **candidateId**: `sdp-worktree-footprint-port`
- **Rationale**: SDP structural — `maintenance/worktree` (I 0.43) imports
  `maintenance/footprint` (I 0.69); all three imported names
  (`cloneCollectionFootprint`, `CollectionFootprintFactory`,
  `ResolvedCollection`) declare in footprint, and `ResolvedCollection` is
  already contract-kind (`footprint/artifact.ts` imports
  `contracts/types/collection-identity`). Port inversion per
  `repair/stableDependencies.md` Ops recipe.
- **Naming verdict** (get_naming_lexicon): `CollectionFootprintPort` —
  **CONFORMS** (project `Port` suffix: `CollectionIndexingLockPort`,
  `CommitDiffMemoPort`, `DaemonCollectionClientCachePort`).
  `CollectionFootprintCloner` was NEW_TERM — rejected in favour of the
  convention.
- **Ops** (implementation intent): declare the port interface in a new contracts
  file; `worktree-provisioner.ts` imports the port from contracts instead of the
  footprint barrel; the footprint barrel re-exports/implements against the port.

```text
removeEdge { from: "src/core/domains/maintenance/worktree/worktree-provisioner.ts", to: "src/core/domains/maintenance/footprint/index.ts" }
addFile  { file: "src/core/contracts/types/collection-footprint.ts", component: "src/core/contracts", abstract: true }
addEdge  { from: "src/core/domains/maintenance/worktree/worktree-provisioner.ts", to: "src/core/contracts/types/collection-footprint.ts" }
addEdge  { from: "src/core/domains/maintenance/footprint/index.ts", to: "src/core/contracts/types/collection-footprint.ts" }
```

- **As landed** (design refined during implementation): the port lives in the
  EXISTING `contracts/types/footprint.ts` — the footprint store-contract seam —
  not a new `collection-footprint.ts`; only `ResolvedCollection` moved there
  (the artifact protocol stayed private to footprint). The port speaks intent:
  `clone(source, target)` / `remove(source, target)`; the reverse teardown walk
  moved from `WorktreeProvisioner#remove` into a new `removeCollectionFootprint`
  beside the clone saga, and
  `CollectionFootprintFactory implements CollectionFootprintPort` by delegation.
  The saga-level tests (clone order, rollback, forgiving teardown) moved to
  `tests/core/domains/maintenance/footprint/clone-saga.test.ts`; the provisioner
  suite now asserts the port seam, and the footprint facade guard asserts the
  provisioner imports footprint NEVER. Same SDP delta, smaller contracts
  surface.

- **Expected delta** (from simulation): resolved (1): SDP
  `maintenance/worktree → maintenance/footprint` (structural). Introduced: none.
  byTier: structural 1/0. net **−1**, persisting 42.
- **Blast radius**: 83 files. **Touched**:
  `src/core/contracts/types/collection-footprint.ts` (new),
  `src/core/domains/maintenance/footprint/index.ts`,
  `src/core/domains/maintenance/worktree/worktree-provisioner.ts`.
- **Scan note**: `worktree-provisioner.ts` — `WorktreeProvisioner#create` is 136
  LOC across 4 `#part` chunks, chunk bugFix 57–60% concerning — decompose too
  (follow-up, not inside this Task).
- **Implementation**: `tea-rags:data-driven-generation`; end the Task with
  `GATE review_changes: introduced=<n>, partial=<true|false>`.

## Trade-offs (introduce critical/active — never selected)

| Candidate       | Pair (support/strength)                             | Net     | Introduces                                                            |
| --------------- | --------------------------------------------------- | ------- | --------------------------------------------------------------------- |
| report:merge:18 | duckdb ↔ migration/database/migrations (40 / 0.686) | **+7**  | critical knot duckdb, 4 × hubLike, SDP primitives→duckdb backEdges ×2 |
| report:merge:19 | contracts ↔ migrations (35 / 0.576)                 | **+10** | 5 × facade leaks, 2 × active backEdge, SDP temporal→api               |
| report:merge:12 | bash ↔ rust (14 / 0.59)                             | **+6**  | critical knot bash, active SDP bash→ruby/walker                       |
| report:merge:11 | bash ↔ go (14 / 0.59)                               | **+5**  | active knot language, SDP ts→js/walker                                |
| report:merge:20 | contracts ↔ language/kernel (82 / 0.507)            | **+5**  | 4 × facade leaks, active knot symbols                                 |
| report:merge:15 | api/public/dto ↔ mcp/tools (84 / 0.517)             | **+3**  | critical backEdge api/public→dto, hubLike dto                         |
| report:merge:9  | swift resolver/strategies ↔ walker (18 / 0.581)     | **+4**  | 2 × active backEdge/knot javascript                                   |
| report:merge:3  | javascript ↔ typescript (31 / 0.573)                | **+4**  | critical knot bash… (2 backEdges)                                     |
| report:merge:10 | bash ↔ java (15 / 0.657)                            | **+2**  | critical knot go, active SDP go→rust/walker                           |
| report:merge:4  | bash ↔ rust walker pair (14 / 0.59)                 | **+1**  | 2 × active SDP bash→rust/walker                                       |
| report:merge:13 | java ↔ rust (18 / 0.524)                            | **+1**  | 2 × active SDP java→rust/walker, active knot java                     |

Reading: every language-family merge and every contracts/duckdb merge trades
history coupling for real structural violations. Co-change strength ranks
candidates; the delta decides them. None selected.

## Unselected

- `report:merge:16` — **conflictsWithPrefix**: names unknown architecture
  component `src/mcp/tools` (component identity changes after Task 1's
  re-partition; re-simulate after Task 1 lands if still relevant).
- `report:merge:14`, `report:merge:5`, `report:merge:1`, `report:merge:2`,
  `report:merge:6`, `report:merge:7`, `report:merge:17` — **noImprovement**
  (delta does not reduce any violation).

## Not ordered

None (report candidates fit the judging budget; per-judge measured 1.2 s, 63
rounds ≈ 78 s).

## Deferred

- **Cycles (7)** — not report violations, not restructured here: the 12-file
  type-only cycle in `src/core/contracts/types/*` (runtime-erased imports; low
  value), `qdrant/aliases ↔ connection`,
  `qdrant/schema-metadata-point ↔ client`,
  `explore/working-tree substitute ↔ overlay`,
  `symbols run-global-map-registry ↔ pass1-aggregates ↔ run-state`,
  `ingest file-processor ↔ file-ingestor`, `api app-factory ↔ api/index.ts`.
  Re-plan after Tasks 1–2 land.
- **Remaining shotgunSurgery (11) / silentCoupling (10)** — history-only
  findings whose merge-space the Trade-offs table shows to be net-negative.
  Leave; re-plan on the post-merge graph.

## Escalated

- **SDP `bootstrap/auto-update → src/core/api`** (structural, Δ 0.329): mixed
  dependency. Types (`IndexFreshnessCheck`, `IndexFreshnessVerdict`) declare in
  `maintenance/freshness`; runtime names (`resolveCollection`,
  `resolveDomainEnvCodeDefaults`) declare **inside api**
  (`api/internal/collection-resolver.ts`,
  `api/internal/domain-env-code-defaults.ts`) — a retarget keeps the component
  edge. Full removal needs relocating api-internal resolvers into a more stable
  home — a design decision, not an edge edit.
- **hubLikeDependency ×1**: the violation carries only counts (afferent 9 /
  efferent 13, 38 files), not the hub component's name; `ingest/operations`
  being `disjoint` rules out the naive guess. Needs a scoped report over the
  ingest cluster to identify H and its consumer clusters before the
  afferent-split recipe can be applied.
- **mainSequence ×2** (zone of pain; distance 0.503 and 0.964):
  `repair/mainSequence.md` has no `## Ops recipe` — escalated per skill.
  Evidence also omits component names (counts only); identify via
  `architecture-diagnostics` before judging edges.
- **layering ×14 nestedPairs**: parent/nested component layout observations
  (`api → api/internal/ops/review-sections`, `cli → cli/commands`, adapter
  subfolders, resolver/strategies pairs). No recipe family; layout triage data,
  not planned.
  - Reclassified LOW (bd 54xwd.12 closed, 2026-10-17):
    `api → api/internal/ops/review-sections` — fresh graph shows no file-level
    SCC (only the app-factory ↔ index pair, bead .14), all 21 nested imports are
    specific (no barrel bypass), and the domain-scoped report counts the pair
    informational (containment = composition). Both structural exits reverse the
    F3 registry-canonical design or reshuffle ~10 shared readers for zero
    behavior gain. Reopen if the wave-boundary full report counts it as a
    violation; remedy then: self-contained nested component for the shared
    readers.
  - Reclassified LOW (bd 54xwd.13 closed, 2026-10-17): `cli → cli/commands` —
    find_cycles over src/cli/\*\* is EMPTY (DAG); create-cli composes the
    command builders (containment) and commands import specific parent leaf
    modules — no barrel bypass either direction. The cycle exists only in the
    component projection of mutual parent-nested composition. Same reopen
    condition and remedy family (wiring inversion) as the review-sections pair.

## Dropped

None (no MISFIT verdicts; the single addEdge pair targets a new file —
`UNJUDGED newFile`, kept).

## Tracking — Wave 1 outcome (2026-10-17)

- **Task 1 / bead 54xwd.1** — landed: commits `b714169fd` (plan + design) and
  `0ca855309` (the merge). Gate round 4: architecture findings empty; resolved =
  SDP `bootstrap → src/mcp/tools` (structural) + shotgun w8 → w5; introduced =
  the planned shotgun w5 (exp 0.001). Two pre-existing `ingest/operations` deep
  imports repaired with the detector's own `retargetImport` remedies en route.
- **Task 2 / bead 54xwd.2** — landed: commit `8f0de85fe`. Design refined as
  landed (see Task 2's note): the port lives in the existing contracts
  `footprint.ts`, speaks intent (clone/remove), and the saga takes a structural
  `FootprintBuilder` so no import cycle closes back into the factory. Gate round
  2: findings empty; resolved = SDP `worktree → footprint` (structural).
- **Beads 54xwd.12 / .13** — closed, reclassified LOW per the owner-approved
  severity cut (barrel-vs-subfolder layout): fresh graph shows no file-level SCC
  in either pair and no barrel bypass; the composition cycle exists only in the
  component projection of mutual parent-nested composition. Reopen condition
  recorded on both beads.
- **Bead 54xwd.14** — five commits, one per runtime cycle: app-factory de-cycled
  from the api barrel (`ca88e927c`), the alias manager typed against a
  `QdrantConnectionTransport` port, the schema-metadata store against the
  Catalog/Reader/Writer port intersection, the substitute predicates against a
  structural view slice, and the file-process batch contract moved to the
  `file-process-types` leaf. Two SCCs reclassified LOW (type-only closing edges;
  the runtime graph is a DAG): the symbols triangle and the 12-file
  contracts/types cycle.
- **Accepted FP classes**: 16 naming COLLISIONs on move diffs (bead 54xwd.15's
  sibling `jzexs`); 12 leakingAbstraction findings on the app-factory de-cycling
  (bead `54xwd.15`) — the detector reads member-side barrel de-cycling as
  consumer bypass; `find_cycles` over `src/core/api/**` is empty after the fix,
  which is the invariant the de-cycling enforces.

## Execution contract (refactoring-planning):

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
