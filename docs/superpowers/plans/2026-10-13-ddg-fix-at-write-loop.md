# DDG fix-at-write loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use dinopowers:executing-plans
> (orchestrator dispatches one fresh subagent per task in an isolated worktree).
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `review_changes` hands every diff-introduced architecture finding a
verified cheap repair when one exists, and DDG Step 7 drives a bounded
fix-at-write loop over it; architecture-diagnostics and risk-assessment read the
same fields and the same per-family repair files.

**Architecture:** Server side extends the diff detector run (`DiffDetectorRun`)
with `preExisting` for every edge/metric family, two new families
(`layeringBackEdge`, `hubLike`), and a `DiffFindingRemedyResolver` that proposes
an import retarget and proves it by re-judging the hypothetical edge set. Plugin
side adds `.claude-plugin/tea-rags/repair/<family>.md`, lazily loaded per
family, and rewrites DDG Step 7.

**Tech Stack:** TypeScript (ESM), Vitest, tea-rags MCP, Claude Code plugin
skills (Markdown).

**Spec:** `docs/superpowers/specs/2026-10-13-ddg-fix-at-write-loop-design.md`
(decisions D1–D12 are referenced by number below).

**Bead:** `tea-rags-mcp-89k7k.1.19` (plan epic); tasks are its children.

## Global Constraints

- Every code task is written through `/tea-rags:data-driven-generation`
  (`.claude/rules/code-generation-ddg.md`).
- TDD: red-first pin, then implementation. Never edit unrelated assertions,
  never lower thresholds, never `eslint-disable`, never raise test timeouts.
- `DiffDetectorRun` (`src/core/api/internal/ops/diff-detector-run.ts`) is 1083
  LOC, bugFixRate 55, single owner; `DiffDetectorRun#run` has fanOut 23. New
  families and the resolver live in their OWN modules under
  `src/core/api/internal/ops/diff-families/`; `run()` gains one wiring line per
  family and nothing else.
- `architecture-section.ts` (bugFixRate 50, 593 LOC) only wires; no logic.
- Diff-run fixtures: reuse the builders in
  `tests/core/api/internal/ops/diff-detector-run.test.ts` (`graphOf`,
  `catalogOf`, `factsOf`, `overlayOf`, `runWith`, `baseEdgesOf`,
  `namedOverlayOf`, `subjectsOf`). New family tests go in their own files under
  `tests/core/api/internal/ops/diff-families/`; if a builder is needed there,
  MOVE it into `tests/core/api/internal/ops/__helpers__/diff-run-fixtures.ts`
  (move only, no rewrite) and import it from both.
- Names: `DiffFindingRemedy`, `DiffFindingRemedyResolver`, field `remedy`,
  families `"layeringBackEdge"` and `"hubLike"` (lexicon-checked in the spec).
  Any further new exported name goes through `get_naming_lexicon` first.
- Commits: conventional, scope `review` is not a release scope — use `api` for
  server tasks, `docs` for skill/repair files; body lines ≤ 100 chars; reference
  the task bead.
- Agent proof per task: `npx tsc --noEmit -p tsconfig.json`,
  `-p tsconfig.tests.json`, `-p tsconfig.scripts.json`, `npx eslint src`, the
  task's targeted vitest (FORCE_COLOR=0),
  `tests/navigator-code-references.test.ts`,
  `tests/navigator-enumerations.test.ts`. No merge, push, reindex or
  `test:coverage` by agents.

## Waves

| Wave | Tasks (parallel)               | Why this grouping                                                                                    |
| ---- | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| 1    | T1, T2, T7                     | T1 touches only the hub detector; T2 only `diff-detector-run.ts` + contract; T7 only plugin Markdown |
| 2    | T3                             | wires a family into `run()` and the family union                                                     |
| 3    | T4                             | same files as T3 — serialized                                                                        |
| 4    | T5                             | resolver over all families' contract                                                                 |
| 5    | T6, T8                         | T6 server wiring; T8 DDG skill (reads T5 contract)                                                   |
| 6    | T9                             | arch-diagnostics + risk-assessment + version bump, after T8                                          |
| —    | live validation (orchestrator) | crafted diff, see Task 6                                                                             |

---

### Task 1: g77p3 — hub efferent count excludes edges into contracts

**Files:**

- Modify:
  `src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/hub-like-dependency.ts`
  (`detectHubLikeDependencies`, `couplingImbalance`)
- Test:
  `tests/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/hub-like-dependency.test.ts`
- Modify: `.claude-plugin/tea-rags/skills/architecture-diagnostics/SKILL.md`
  (Phase 3d2 reading of Ce)

**Interfaces:**

- Consumes: the foundation classification the report already uses for
  `foundationTerminal` (contracts = foundation). Find it with
  `hybrid_search(query:"foundationTerminal", metaOnly:true)`; reuse it, do not
  re-derive "is contracts" by path string.
- Produces: hub efferent count = edges to non-foundation components only.
  Exported behaviour change, no signature change.

- [ ] **Step 1: Failing test.** Fixture: component `A` with Ca 8 and 11 efferent
      edges, 6 of them into `src/core/contracts/**`. Assert `A` is NOT a hub (Ce
      5 below threshold) and that a component with 11 non-contract efferents and
      Ca 8 still IS a hub. Run the file: FAIL on the first case.
- [ ] **Step 2: Implement** the exclusion where Ce is counted.
- [ ] **Step 3: Run** the hub test file and
      `tests/core/api/internal/ops/architecture-report` — PASS. Any pinned
      report-level hub count that moves because of this is a deliberate fix:
      update the pin and say which in the commit body.
- [ ] **Step 4: Skill line.** In architecture-diagnostics Phase 3d2 state: "Ce
      counts edges to non-foundation components; edges into contracts are not
      efferent coupling."
- [ ] **Step 5: Commit**
      `fix(api): hub efferent count excludes edges into contracts (g77p3)`.

### Task 2: preExisting for stableDependencies and mainSequence (D9)

**Files:**

- Modify: `src/core/contracts/types/diff-detector-finding.ts` (doc of
  `preExisting`)
- Create: `src/core/api/internal/ops/diff-families/pre-existing.ts`
- Modify: `src/core/api/internal/ops/diff-detector-run.ts`
  (`judgeStableDependencies`, `judgeMainSequence` call the new helpers)
- Test: `tests/core/api/internal/ops/diff-families/pre-existing.test.ts`

**Interfaces:**

- Consumes: `DiffDetectorBaseEdgeReader#targetsAtBase(source)` (already used by
  `DiffDetectorRun#heldBeforeChange`),
  `MainSequenceDiffFindingEvidence.distanceBefore`.
- Produces:

  ```ts
  // pre-existing.ts
  export function componentPairViolatedAtBase(
    pair: { sourceComponent: string; targetComponent: string },
    baseEdges: DiffDetectorBaseEdgeReader | undefined,
    componentOf: (relPath: RelPath) => string | undefined,
    sourceFilesOf: (component: string) => readonly RelPath[],
  ): boolean;
  export function pastThresholdBefore(
    distanceBefore: number,
    tolerance: number,
  ): boolean;
  ```

  `preExisting: true` is stamped on stableDependencies findings whose pair
  `componentPairViolatedAtBase` and on mainSequence findings whose
  `pastThresholdBefore`. Absent otherwise (the field is present-only-when-true).
  A source the base reader cannot answer → `false` (a missing fact is never
  "already held", same contract as `heldBeforeChange`).

- [ ] **Step 1: Failing tests** (in the new file, fixtures from the diff-run
      builders):
  1. SDP: base holds `a/x.ts → b/y.ts`; diff adds `a/z.ts → b/w.ts`; pair
     `a → b` violates SDP → finding has `preExisting: true`.
  2. SDP: base holds no `a → b` edge; diff adds one → no `preExisting`.
  3. SDP: base reader returns `undefined` for every `a` file → no `preExisting`.
  4. mainSequence: `distanceBefore` 0.31, tolerance 0.20 → `preExisting: true`.
  5. mainSequence flap: `distanceBefore` 0.19 → `distanceAfter` 0.21 → no
     `preExisting`.
- [ ] **Step 2: Run** — FAIL (field absent).
- [ ] **Step 3: Implement** helpers + stamping; update the `preExisting` doc
      comment: families covered, and that silentCoupling / splitCandidates /
      facadeContract never carry it (spec D9).
- [ ] **Step 4: Run** new file +
      `tests/core/api/internal/ops/diff-detector-run.test.ts`
  - `tests/core/api/internal/ops/review-sections` — PASS.
- [ ] **Step 5: Commit**
      `improve(api): preExisting attribution for stableDependencies and mainSequence diff findings`.

### Task 3: layeringBackEdge diff family

**Files:**

- Modify: `src/core/contracts/types/diff-detector-finding.ts` (family union,
  finding variant, evidence type)
- Create: `src/core/api/internal/ops/diff-families/layering-back-edge.ts`
- Modify: `src/core/api/internal/ops/diff-detector-run.ts` (one wiring line in
  `run`, one status row)
- Modify: `src/core/api/public/dto/review.ts` and the MCP formatter only if they
  enumerate families
- Test: `tests/core/api/internal/ops/diff-families/layering-back-edge.test.ts`

**Interfaces:**

- Consumes: the layering model in
  `src/core/domains/trajectory/codegraph/symbols/boundary-diagnostics/layering.ts`
  (component levels, knot membership) through the codegraph symbols facade;
  `preExisting` via `componentPairViolatedAtBase` (Task 2) with "violated" =
  back-edge at base.
- Produces:

  ```ts
  export interface LayeringBackEdgeDiffFindingEvidence {
    sourceLevel: number;
    targetLevel: number;
    /** Present when the edge closes a knot: the knot's components, sorted. */
    closesKnot?: string[];
  }
  // finding variant
  {
    detector: "layeringBackEdge";
    endpoints: DiffFindingComponentEdgeEndpoints;
    evidence: LayeringBackEdgeDiffFindingEvidence;
  }
  export function judgeLayeringBackEdges(input: {
    addedEdges: readonly OverlayEdge[];
    componentOf: (relPath: RelPath) => string | undefined;
    layering: LayeringReading; // levels + knots, from the facade
    heldAtBase: (pair: {
      sourceComponent: string;
      targetComponent: string;
    }) => boolean;
  }): DiffDetectorFinding[];
  ```

  (`LayeringReading` = whatever the layering module already exports for
  levels/knots; if it exports nothing suitable, export a read-only view from the
  facade — no copy of the algorithm.) Composition edges (directory → its own
  sub-directory) are NOT back-edges (architecture-diagnostics anti-pattern "knot
  with composition: true").

- [ ] **Step 1: Failing tests:** (1) diff adds edge from level-0 component to
      level-2 component where layering expects downward → one finding with
      levels; (2) edge that closes a knot → `closesKnot` listed; (3) composition
      edge parent→child → no finding; (4) back-edge pair already present at base
      → `preExisting: true`; (5) `run()` status row `layeringBackEdge` built
      with `findingCount`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** module + wiring.
- [ ] **Step 4: Run** new file, diff-detector-run tests, review-sections tests,
      `tests/core/api/public` — PASS.
- [ ] **Step 5: Commit**
      `feat(api): layeringBackEdge diff family in review_changes`.

### Task 4: hubLike diff family

**Files:**

- Modify: `src/core/contracts/types/diff-detector-finding.ts`
- Create: `src/core/api/internal/ops/diff-families/hub-like.ts`
- Modify: `src/core/api/internal/ops/diff-detector-run.ts` (wiring line + status
  row)
- Test: `tests/core/api/internal/ops/diff-families/hub-like.test.ts`

**Interfaces:**

- Consumes: hub thresholds and the Ca/Ce reading from `hub-like-dependency.ts`
  (after Task 1 — contracts edges excluded) via the facade;
  `pastThresholdBefore`-style check for `preExisting`.
- Produces:

  ```ts
  export interface HubLikeDiffFindingEvidence {
    afferentBefore: number; efferentBefore: number;
    afferentAfter: number;  efferentAfter: number;
    /** The diff-added edges that moved the component, source side. */
    edges: { sourceRelPath: RelPath; targetRelPath: RelPath }[];
  }
  { detector: "hubLike"; endpoints: DiffFindingComponentEndpoints;
    evidence: HubLikeDiffFindingEvidence }
  export function judgeHubLike(input: {...}): DiffDetectorFinding[];
  ```

  A finding only when the component is a hub AFTER and the diff's own edges are
  what crossed it; `preExisting: true` when it was a hub BEFORE.
  `compositionRoot: true` is stamped exactly as the whole-repo hub detector
  stamps it.

- [ ] **Step 1: Failing tests:** (1) Ce 10→11 with Ca 8 crosses → finding with
      before/after and the one edge; (2) new edge into contracts does not move
      Ce → no finding; (3) already a hub before → `preExisting: true`; (4)
      declared composition root → `compositionRoot: true`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** new file + diff-detector-run + review-sections — PASS.
- [ ] **Step 5: Commit** `feat(api): hubLike diff family in review_changes`.

### Task 5: DiffFindingRemedyResolver with dry-run

**Files:**

- Modify: `src/core/contracts/types/diff-detector-finding.ts`
  (`DiffFindingRemedy`, `remedy?` on common)
- Create: `src/core/api/internal/ops/diff-families/remedy-resolver.ts`
- Test: `tests/core/api/internal/ops/diff-families/remedy-resolver.test.ts`

**Interfaces:**

- Consumes: findings from Tasks 2–4 and the existing families; an export table
  reader (find what `facadeContract` / leakingAbstraction already use to read a
  facade's re-exported names and a file's declared names; reuse it); a re-judge
  seam.
- Produces:

  ```ts
  export type DiffFindingRemedy =
    | {
        kind: "retargetImport";
        sourceRelPath: RelPath;
        fromRelPath: RelPath;
        toRelPath: RelPath;
        importedNames: string[];
        addExport?: { facadeRelPath: RelPath; names: string[] };
      }
    | { kind: "restoreExport"; facadeRelPath: RelPath; names: string[] };

  /** Re-runs the diff judgement over the overlay with the edits applied. */
  export type DiffRejudge = (edits: DiffEdgeEdit[]) => DiffDetectorFindings;
  export interface DiffEdgeEdit {
    replace?: { source: RelPath; from: RelPath; to: RelPath };
    addExport?: { facadeRelPath: RelPath; names: string[] };
  }

  export class DiffFindingRemedyResolver {
    constructor(deps: { exports: ExportTableReader; rejudge: DiffRejudge });
    resolve(
      finding: DiffDetectorFinding,
      all: DiffDetectorFindings,
    ): DiffFindingRemedy | undefined;
  }
  ```

  `DiffRejudge` is the reusable what-if seam later generalised by `r8hme.21` and
  `89k7k.1.7` — keep it free of remedy concepts. Candidate rules per family:
  spec "Candidate target per family" table. Emit only when `rejudge` shows the
  finding gone AND no new finding (fingerprint = detector + endpoints, the
  89k7k.1.7 key). Decline when a name has more than one declaration, `to` misses
  an imported name, the dry-run adds a finding, or the language has no export
  table.

- [ ] **Step 1: Failing tests:**
  1. leakingAbstraction with `evidence.facadeRelPath` that re-exports the name →
     `retargetImport` to the facade, no `addExport`.
  2. same, facade lacks the name → `addExport` with the one name.
  3. SDP where the source imports a type through a barrel in an unstable
     component but the type is declared in `contracts` → retarget to the
     declaring file.
  4. cycle closed through a barrel on the cycle; declaring file off-path →
     retarget to it.
  5. hubLike where the target name is also exported by a component the source
     already depends on → retarget there.
  6. facadeContract dropped name with consumers → `restoreExport`.
  7. dry-run reports a NEW finding → `undefined`.
  8. name declared in two files → `undefined`.
  9. silentCoupling / splitCandidates → always `undefined`.
- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** with `rejudge` injected (tests pass a fake that
      re-runs `runWith` on an edited overlay).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit**
      `feat(api): DiffFindingRemedyResolver proposes dry-run-verified import retargets`.

### Task 6: Wire remedy into review_changes + live check

**Files:**

- Modify: `src/core/api/internal/ops/review-sections/architecture-section.ts`
  (construct resolver, stamp `remedy` after the run, before the findings cap)
- Modify: `src/core/api/internal/ops/diff-detector-run.ts` (expose a
  `rejudge(scope, overlay, edits)` entry that builds the edited overlay; no
  family logic)
- Modify: `src/core/api/public/dto/review.ts` / MCP formatter if they whitelist
  finding fields
- Test:
  `tests/core/api/internal/ops/review-sections/architecture-section.test.ts`
  (new describe), `tests/core/api/internal/ops/review-changes-ops.test.ts` only
  if a contract snapshot pins finding keys

**Interfaces:**

- Consumes: Task 5.
- Produces: `review_changes` architecture findings carry `remedy` when the
  resolver returns one. Resolver failures never fail the section: a throw is
  caught, the finding is emitted without `remedy`, and the section's detector
  status carries a `reason`.

- [ ] **Step 1: Failing test:** section over a fixture diff that adds one
      facade-bypassing import → finding has `remedy.kind === "retargetImport"`.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement. Step 4: Run** section +
      review-changes-ops + public DTO tests — PASS.
- [ ] **Step 5: Commit**
      `feat(api): review_changes architecture findings carry verified remedies`.
- [ ] **Step 6 (orchestrator, after merge):** build, `npm link`, reconnect; in a
      scratch worktree add (a) a facade-bypassing import, (b) an SDP edge
      through a barrel, (c) a layer back-edge; run `review_changes(changes:{})`;
      each finding carries `remedy`; apply each; re-run → findings gone, none
      new.

### Task 7: Shared repair strategy files

**Files:**

- Create:
  `.claude-plugin/tea-rags/repair/{stableDependencies,leakingAbstraction,cycles,mainSequence,hubLike,layeringBackEdge,facadeContract,silentCoupling,splitCandidates}.md`
- Create: `.claude-plugin/tea-rags/repair/README.md` (one paragraph: what the
  directory is, the load-only-on-finding contract, the five-section skeleton)

**Interfaces:**

- Consumes: spec sections "Repair strategy files", D2–D7, the remedy contract
  (Task 5 shape, already fixed in the spec).
- Produces: nine files, each with exactly the headings `## What it means`,
  `## Apply remedy`, `## No remedy`, `## Known false positives`,
  `## Escalate when`. Families without a server remedy (silentCoupling,
  splitCandidates) write "No server remedy for this family." under
  `## Apply remedy`.

Per-file content requirements:

- stableDependencies: remedy = retarget; no remedy → if the edge is a
  composition edge from a declared composition root, `compositionRoot` flag is
  the evidence; else escalate. Cite `.claude/rules/domain-boundaries.md` as the
  rule source a project may quote (generic wording: "a project rule file +
  quote").
- leakingAbstraction: remedy = facade; `preExisting` leak in a file you did not
  touch → report-only.
- cycles: barrel-on-cycle retarget; informational composition cycles are not
  violations (arch-diagnostics anti-pattern list).
- mainSequence: edge-by-edge SDP over `evidence.edges`; `entryPoint` /
  `foundationTerminal` are evidence; flap = D5.
- hubLike: retarget to an already-depended component; `compositionRoot` is
  evidence; contracts edges never count (g77p3).
- layeringBackEdge: retarget to the declaring file in a permitted layer;
  composition edges are not back-edges.
- facadeContract: `restoreExport`, or move every consumer to the new home in the
  same diff.
- silentCoupling: D7 verbatim procedure.
- splitCandidates: D6 verbatim procedure.

- [ ] **Step 1:** Write README + nine files. **Step 2:** markdownlint
      (`mcp__markdownlint__lint_markdown`) clean; prettier. **Step 3:** Commit
      `docs(skills): per-family repair strategy files for architecture findings`.

### Task 8: DDG Step 7 protocol + session-context reuse + evals

**Files:**

- Modify: `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`
  (Prerequisites, Step 2, Step 5, Step 7)
- Modify: `.claude-plugin/.benchmarks/data-driven-generation/evals.json`

**Interfaces:**

- Consumes: Task 7 files (path `../../repair/<family>.md` from the skill),
  remedy contract, D1–D12.
- Produces: Step 7 text per spec "Step 7 (VERIFY) protocol"; session-reuse text
  per spec D12 in Prerequisites, Step 2, Step 5; ~12 eval cases with ids
  `step7-fix-*` and `session-reuse-*`, categories `step7-fix-at-write` and
  `session-context-reuse`, shape
  `{id, category, prompt, expected:{mustDo[], mustNotDo[]}, failureMode}` like
  the existing 30.

Eval list (one case each): session reuse unedited → no re-search; session reuse
edited → re-fetch; must-fix with remedy applied; preExisting with remedy
auto-fixed; preExisting without remedy → report + bead; round reverted on new
finding; escalation after 2 rounds, no commit; false positive with
`compositionRoot` accepted; "by design" without evidence → fix or ask; flap
handled as introduced; cohesion own cluster moved vs pre-existing reported;
co-change partner verdict with evidence; only the matching repair file loaded.

- [ ] **Step 1:** Edit SKILL.md. **Step 2:** Add eval cases;
      `node -e "JSON.parse(require('fs').readFileSync('.claude-plugin/.benchmarks/data-driven-generation/evals.json','utf8'))"`.
      **Step 3:** markdownlint + prettier. **Step 4:** Commit
      `docs(skills): DDG Step 7 fix-at-write loop and session-context reuse`.
- [ ] **Step 5 (orchestrator):** run the optimize-skill eval harness on the new
      cases; record pass rate in the bead.

### Task 9: architecture-diagnostics + risk-assessment + plugin version

**Files:**

- Modify: `.claude-plugin/tea-rags/skills/architecture-diagnostics/SKILL.md`
- Modify: `.claude-plugin/tea-rags/skills/risk-assessment/SKILL.md` (Phase 4
  "Structural amplifier")
- Modify: their eval files under `.claude-plugin/.benchmarks/<skill>/evals.json`
  if present
- Modify: plugin version per `.claude/rules/plugin-versioning.md`

**Interfaces:**

- Consumes: Tasks 1–8.
- Produces:
  - architecture-diagnostics: `preExisting` bullet covers every edge/metric
    family; read `remedy` and quote it in the recommendation; diff families
    `layeringBackEdge`, `hubLike`; recommendation loads only
    `repair/<family>.md` for the families present; D3 evidence wording.
  - risk-assessment Phase 4: candidate inside a component with an SDP,
    mainSequence or hubLike violation → escalate (same overlap rule as
    blast-radius hubs); `compositionRoot` / `entryPoint` / `foundationTerminal`
    components do not escalate; fix cost reads the family repair file (remedy
    present → cheap).
  - eval cases: remedy reading, `preExisting` on SDP/mainSequence, structural
    escalation, flagged component not escalated.

- [ ] **Step 1:** Edit both skills. **Step 2:** evals. **Step 3:** version bump.
      **Step 4:** markdownlint + prettier. **Step 5:** Commit
      `docs(skills): architecture-diagnostics and risk-assessment read remedy, preExisting and repair files`.

## Self-review

- Spec coverage: D1–D7, D12 → T7/T8; D8 → T1/T3/T4; D9 → T2 (+T3/T4 stamp their
  own); D10 → T5/T6; D11 → T7/T8/T9. Live check → T6 Step 6. Evals → T8/T9.
- Names consistent: `DiffFindingRemedy`, `DiffFindingRemedyResolver`,
  `DiffRejudge`, `DiffEdgeEdit`, `componentPairViolatedAtBase`,
  `pastThresholdBefore`, `judgeLayeringBackEdges`, `judgeHubLike`.
