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
- **Wave-boundary full report** (post-`8f0de85fe` graph): both Wave-1 SDP
  targets ABSENT from the report (resolved); leakingAbstraction 0; layering
  violations 0 (the review-sections pair informational only); no runtime SCC.
  Remaining findings, all Wave 2/3 scope: SDP ×3 (`bootstrap/auto-update → api`
  Δ 0.329 — design D1; `api → trajectory/composite/presets` Δ 0.271 — design D2;
  `api → trajectory/codegraph/working-tree` Δ 0.212 — wave-2 identification),
  silentCoupling ×22 and shotgun ×13 (history-only; beads .8/.10), mainSequence
  ×2 and hubLike ×1 (escalated; beads .6/.7). The Deferred re-plan ("after Tasks
  1–2 land") is due now against this graph.

## Tracking — Wave 1.5 outcome (2026-10-18)

- **Task 3 / bead 54xwd.4** — landed: commit `1b1811fed` (D2 absorb). Hypothesis
  tested and REFUTED by numbers: the presets' own instability (0.933) far
  exceeds the api composition's (0.66), so absorbing them into
  `api/internal/composite-presets/` (git mv, contracts imports retargeted to the
  facade) is the honest direction, not a presets-facing port.
- **Task 4 / bead 54xwd.16** — landed: commit `37e5467cd`. composition.ts
  de-leaked: 12 deep domain imports retargeted onto the domain facades
  (contracts/trajectory/language), 3 facade exports added where the barrel
  lacked a name. Gate round 2 clean.
- **Task 5 / bead 54xwd.3** — landed: commit `79923653c` (D1 injection). The
  auto-update hint takes `McpAutoUpdateApiResolvers` injected from the
  composition root; trigger.ts and mcp-hint.ts declare registry/freshness
  leaves, never the api barrel. Target SDP edge resolved; bonus working-tree
  edge resolved. Residual auto-update → registry Δ 0.217 (fresh ledger; 0.278 at
  filing) accepted with the bootstrap-composition rule — design bead `54xwd.17`.
- **Bead 54xwd.5 (hubLike ingest/pipeline)** — closed as FP acceptance,
  simulation-evidenced (pattern of .12–.15). Structure: Ce counts 6 of the hub's
  own descendant components (containment — counted by hubLike, excluded by SDP);
  2 of 3 operations Ca files extend `BaseIndexingPipeline` (template method —
  interface extraction cannot replace an `extends` edge); the api/index.ts
  barrel edge is facade composition. Recipe-ops restructure simulation:
  types-to-contracts alone resolves nothing (Ca 9 → 8, otsu cut 6); the full
  19-op remedy resolves pipeline but introduces 4 hubLike findings on components
  whose edges no op touched (otsu reclassification) — net +3, the violation set
  is not convergent under the recipe. Detector bead filed as `54xwd.18`.
- **Bead 54xwd.6 (mainSequence 0.964, typescript/resolver/program)** — closed as
  detector-defect acceptance, D3 seam-audit followed. The 0.964 distance reads
  A=0 because the detector measures module-kind components on the facade file —
  a re-export barrel declaring nothing; the component itself declares 18
  exported interfaces vs 5 classes (directory-kind A ≈ 0.78, distance ≈ 0.18),
  and 24 of 27 consumers already hold the seam via
  `import type { TSProgramCache }`. Detector bead filed as `54xwd.19`. Reopen: a
  directory-kind measurement still above 0.5.
- **Bead 54xwd.7 (mainSequence 0.503, adapters/embeddings)** — closed as
  threshold-flap acceptance per the recipe's No-remedy flap rule: 0.503 vs 0.5 =
  0.003 over, inside the 0.02 band; the provider port seam already exists (4
  abstract types). Reopen: distance > 0.52 on a future full report.
- **Bead 54xwd.10 / .11 (silentCoupling roots)** — closed: every root ≥0.55
  judged per recipe, verdict = lifecycle acceptance. The duckdb cluster (facade
  ↔ daemon protocol/client/op-commands up to 0.703, sup 26) is the codegraph
  storage vertical: sample commits (`3da9aa11`, `73889c47`, `3d534c89`) each
  edit contract + store + facade + daemon protocol + daemon client as one
  storage-surface change; the shared contract (`codegraph-storage.ts`) is
  structurally linked to the facade (support 19), `daemon/client.ts` imports the
  protocol (line 73), and the facade must not import the daemon layer.
  Temporal-cochange and ruby self-dispatch pairs: data-file pipeline and
  designed cross-domain boundary. The 0.51–0.55 band (.11) sits below the owner
  cut (LOW); the marginal `api/tools/codegraph.ts` 0.552 root judged anyway:
  SKILL.md doc pair + data-driven tool→ops dispatch.
- **Bead 54xwd.8 / .9 (shotgun families)** — closed: three family classes, all
  vertical slices. Cross-language sweeps (exp ≈ 0; sample `f6f89d2b`, "return
  rows for every language") are the mirrored capability/pass structure of the
  consolidation epic — intentional sync, not chance coupling. Python resolver
  slice = table-driven strategy dispatch (compositionTable class). Temporal
  slice = the same feature vertical as .10.
- **Ledger after incremental re-index (post-`79923653c`)**: stableDependencies
  ×1 (the .17 residual), leakingAbstraction 0, layering 0, hubLike ×1
  (accepted-FP per .5), mainSequence ×2 (both closed per above), silentCoupling
  ×22 and shotgun ×13 (history-only; beads .8–.11).
- **Terminal ledger (post-`d75e32212`)**: every above-low finding is
  dispositioned — repaired (waves 1–1.5) or evidence-backed acceptance with
  recorded reopen conditions (.5, .6, .7, .8, .9, .10, .11) or filed as detector
  defects (`54xwd.15`, `.18`, `.19`). Standing report findings are exactly the
  accepted set plus the `.17` bootstrap residual (bootstrap composition-root
  rule). Open P3 beads are follow-up engineering (detector fixes, optional
  registry-port design), not violation elimination.

## Tracking — fix wave (2026-10-18, "фикси, потом лайв валидируй")

The three detector-defect beads were verified against the detector code before
fixing; ALL THREE REFUTED, and one acceptance reversed:

- **Bead 54xwd.6 — reopened and remediated as a REAL finding** (commit
  `eaea7affd`). The census aggregates `typeAbstractness` per file over the
  component's members — never the facade; the TS abstractness reader keeps
  data-shape interfaces out of both counts as Martin-neutral (verified:
  `TSProgramHandle`, `TSProgramImportGraph` are pure data shapes). A=0 was an
  honest reading. Remedy: `TSProgramCachePort` extracted — the four-member role
  (repoRoot, acquire, isProjectSourceFile, toProjectSourceRelPath) the 22
  consumer files program against; the class implements it, the barrel exports
  it. Residual concreteness (LRU/memo/store/planner, no substituting consumers)
  accepted — porting them would be metric-gaming.
- **Beads 54xwd.15 / .18 / .19 — closed as refuted.** .15: the app-factory deep
  imports were true positives (external deep imports — api/internal has no
  assembly barrel), fixed by .16's own remedies. .18: hubLike already excludes
  containment from both axes (bd j5gti) — the pipeline Ce 14 is the post-filter
  count; otsu reclassification under a modified graph is faithful
  re-measurement, not a defect. .19: mechanism claim false (per above).
- **Live validation** (in-process `tea-rags call` on the local build, real
  corpus): `program/` reads A=0.125 / abstract=1 / D=0.839 (was A=0 / D= 0.964)
  — exactly the predicted 1/(1+7) and |A+I−1|; no new violations anywhere;
  embeddings and the pipeline hub unchanged. Functional line: full suite 4701
  green via the pre-commit hook; version-pins re-pinned with "Versions:
  unchanged" (type-only retype).

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

## Tracking — detector wave 2 (2026-10-18, "делай дальше")

The three detector beads filed from this audit were worked per the standing
"фикси, потом лайв валидируй" directive:

- **Bead 54xwd.20 — fixed** (`47febbe3e`): the hubLike evidence lists pass the
  same exclusions the fan counts apply (containment, foundation, all-inheritance
  rows); live-validated on the self-index — the ingest/pipeline hub's
  topDependencies list 5 disjoint entries, its 6 descendants gone from the
  display, dependencyComponentCount 21 → 11, Ca/Ce unchanged.
- **Bead 54xwd.21 — closed INVALID before any code change**: the SKILL.md pair
  appeared only in the raw `find_co_changed` output (tests and docs shown by
  design); the violation's own partners were production files — the language-
  table documentation exclusion had already excluded the doc. Lesson recorded: a
  raw partner query is not evidence of an exclusion gap — check the violation's
  partner list first.
- **Bead 54xwd.22 — fixed** (`575301445`): restructurePlan pre-registers every
  caller addFile into a prelude partition; candidates referencing a sibling's
  new file are judged, not rejected. Live-validated: the exact .5 remedy shape
  completes with no INPUT_UNKNOWN_RESTRUCTURE.
- Wave accounting: of 3 filed detector beads, 2 real (fixed, live-validated) and
  1 invalid — the same verify-before-fixing discipline that refuted .15/.18/.19,
  applied before writing code this time.
