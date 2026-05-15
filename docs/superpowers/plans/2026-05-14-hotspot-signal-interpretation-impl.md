# Hotspot Signal Interpretation Rework — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `dinopowers:executing-plans`
> (NOT `superpowers:executing-plans` directly — the dinopowers wrapper enriches
> with tea-rags signals first).

**Goal:** Implement a unified `stats.confidence` mechanism for signal
descriptors (label clamp + score dampening declared once per raw signal), opt
`bugFixRate` in as the first consumer, and complement with catalog + recipe
documentation that names the Fragile Silo architectural pattern.

**Architecture:** One `confidence` block per raw payload descriptor in
`payload-signals.ts` carries both `score` (continuous dampening parameters,
replacing today's scattered `dampeningSource`/`FALLBACK_THRESHOLD` in
derived-signal classes) and `label` (categorical clamp rules consumed by the
reranker's overlay label resolver). Both consumers read from the same descriptor
— no duplication. Initial application: `bugFixRate`. Six follow-up signals can
opt in via one-line descriptor additions.

**Tech Stack:** TypeScript, Zod for validation, vitest, tea-rags MCP for
verification of the user trigger case.

**Source specs** (all committed at `86e4b231` + iterative review edits in
worktree, in `docs/superpowers/specs/`):

1. `2026-05-14-hotspots-preset-docstring-design.md`
2. `2026-05-14-fragile-silo-pattern-design.md`
3. `2026-05-14-bugfixrate-label-confidence-design.md` (the major code spec)
4. `2026-05-14-small-n-bugfixrate-anti-pattern-design.md`
5. `2026-05-14-fragile-silo-rerank-recipe-design.md`
6. `2026-05-14-bug-proneness-derived-signal-deferred-design.md` (deferred)

---

## Pre-Implementation Verification (READ FIRST)

Three open assumptions to verify on the first read by the executing agent. Each
assumption resolves to "proceed as planned" or "flag the plan and consult user".
Do NOT skip.

### V1: Does preset `description` propagate via `SchemaBuilder`?

Run:

```bash
grep -rn "description" src/core/api/internal/infra/schema-builder.ts
grep -rn "preset.description\|presets\[.*\]\.description" src/
```

**If `SchemaBuilder` reads `preset.description`:** Task 7 changes the
MCP-visible API schema text. Still semver-compatible (description-only) but note
in commit message and release notes.

**If `SchemaBuilder` does not consume `description`:** Task 7 is purely internal
docstring; no MCP surface change.

### V2: Do snapshot tests cover preset `description` or JSDoc text?

Run:

```bash
grep -rn "HotspotsPreset\|hotspots.*description\|frequently-changing" tests/
grep -rn "__snapshots__" tests/ | head
```

**If snapshot tests assert `HotspotsPreset.description`:** Task 7 regenerates
snapshots intentionally; +30 min effort.

**If no snapshot coverage:** Task 7 stays at ~30 min total.

### V3: How many derived signals beyond `BugFixSignal` use `confidenceDampening`?

Run:

```bash
grep -rn "confidenceDampening\|dampeningSource\|FALLBACK_THRESHOLD" \
  src/core/domains/trajectory/git/rerank/derived-signals/
```

**If ≤2 signals with simple migration:** Task 5 covers all of them in one
commit.

**If ≥3 signals or non-trivial migration shape per signal:** Task 5 covers only
`BugFixSignal`; non-bugFix migrations split off into a follow-up spec. State
this explicitly in commit message and create a beads task for the follow-up.

---

## Affected Files

Impact enrichment from tea-rags (`rerank: imports+churn+ownership`):

| File                                                                                | Owner                           | Churn             | Age | Notes                                      |
| ----------------------------------------------------------------------------------- | ------------------------------- | ----------------- | --- | ------------------------------------------ |
| `src/core/contracts/types/trajectory.ts`                                            | Artur Korochanskii (57% shared) | 15 commits high   | 15d | Type contracts — compile-wide blast        |
| `src/core/domains/explore/reranker.ts`                                              | Artur Korochanskii (68% shared) | 10 commits high   | 15d | Orchestrator; integration point for Spec 3 |
| `src/core/domains/trajectory/git/payload-signals.ts`                                | Artur Korochanskii (58% shared) | 6 commits typical | 0d  | Descriptor opt-in location                 |
| `src/core/domains/explore/label-resolver.ts`                                        | (lower impact)                  | —                 | —   | Resolver algorithm                         |
| `src/core/domains/trajectory/git/rerank/derived-signals/bug-fix.ts`                 | (lower impact)                  | —                 | —   | Score-side migration target                |
| `src/core/domains/trajectory/git/rerank/derived-signals/helpers.ts`                 | (lower impact)                  | —                 | —   | `GIT_FILE_DAMPENING` constant home         |
| `src/core/domains/trajectory/git/rerank/presets/hotspots.ts`                        | (lower impact)                  | —                 | —   | Docstring fix (Spec 1)                     |
| `.claude-plugin/tea-rags/rules/references/signal-interpretation.md`                 | —                               | —                 | —   | Catalog + anti-pattern #8                  |
| `.claude-plugin/tea-rags/skills/risk-assessment/references/classification-tiers.md` | —                               | —                 | —   | 14th tier row                              |
| `.claude-plugin/tea-rags/rules/references/use-cases.md`                             | —                               | —                 | —   | Fragile Silo recipe                        |
| `.claude-plugin/tea-rags/.claude-plugin/plugin.json`                                | —                               | —                 | —   | Minor version bump                         |

**Ownership flag:** zero silo-owned files in scope. All shared (≥2
contributors). No mandatory owner-review gating. Top blast-radius:
`trajectory.ts` (types propagate), `reranker.ts` (integration point).

**Coordinated change candidates:** none — empty taskIds across the set. Sequence
freely.

---

## Task 0: Beads bootstrap (DO BEFORE ANY CODE EDIT)

**Files:** none (beads DB only)

**Step 1: Pull latest beads state**

Run:

```bash
bd dolt pull
```

Expected: clean or fast-forward update.

**Step 2: Create epic**

Run:

```bash
bd create --title="Hotspot signal interpretation rework" \
  --description="Unified stats.confidence mechanism + Fragile Silo catalog + docs. Plan: docs/plans/2026-05-14-hotspot-signal-interpretation-impl.md. Covers six design specs in docs/superpowers/specs/2026-05-14-*.md." \
  --type=feature --priority=2
```

Record the returned epic ID as `$EPIC_ID` (e.g. `tea-rags-mcp-XXX`) for
subsequent `bd dep add` calls.

**Step 3: Label the epic**

Run:

```bash
bd label add $EPIC_ID architecture
bd label add $EPIC_ID api
```

**Step 4: Create 11 tasks linked to the epic**

For each Task below, run (substituting `<title>` and `<label>` per the table
after this step):

```bash
TASK_ID=$(bd create --title="<title>" \
  --description="Plan: docs/plans/2026-05-14-hotspot-signal-interpretation-impl.md, Task N" \
  --type=task --priority=2 | awk '/Created/{print $NF}')
bd label add $TASK_ID <label>
bd dep add $TASK_ID $EPIC_ID
echo "Task N → $TASK_ID"
```

Task table (run loop 11 times):

| N   | Title                                                      | Label        |
| --- | ---------------------------------------------------------- | ------------ |
| 1   | Add SignalConfidence + ConfidenceClampRule types + Zod     | architecture |
| 2   | Confidence-aware label resolver                            | architecture |
| 3   | Plumb confidence context through reranker                  | architecture |
| 4   | bugFixRate descriptor opts in to unified confidence        | metrics      |
| 5   | BugFixSignal reads dampening from descriptor               | architecture |
| 6   | Unit tests for unified confidence mechanism                | metrics      |
| 7   | Align HotspotsPreset docstring with weights                | docs         |
| 8   | Fragile Silo pattern + anti-pattern + recipe (docs bundle) | dx           |
| 9   | Record bugProneness signal as deferred                     | architecture |
| 10  | tea-rags plugin minor bump                                 | dx           |
| 11  | Pre-merge verification                                     | metrics      |

**Step 5: Add sequential dependencies (Task N depends on Task N-1)**

Run for N = 2..11 (substituting actual IDs from Step 4):

```bash
bd dep add <task N> <task N-1>
```

**Step 6: Verify graph**

Run:

```bash
bd show $EPIC_ID
bd ready
```

Expected: epic shows 11 children; `bd ready` returns Task 1 as the only ready
task.

**Step 7: Commit beads state**

```bash
bd dolt push
```

(Beads auto-commits to its own Dolt branch; no git commit here.)

---

## Task 1: Add SignalConfidence + ConfidenceClampRule types + Zod

**Spec reference:** Spec 3 D1 + D5 (types only — descriptor opt-in is Task 4).

**Files:**

- Modify: `src/core/contracts/types/trajectory.ts` (extend `SignalStatsRequest`)
- Create OR modify Zod schemas alongside (likely
  `src/core/contracts/types/trajectory.ts` or a sibling `*-zod.ts` — agent
  decides based on existing convention found via:
  `grep -rn "z.object\|zod" src/core/contracts/types/`)
- Create: `tests/core/contracts/types/signal-confidence.test.ts` (Zod validation
  tests only)

**Step 1: Mark task in_progress**

```bash
bd update <task1-id> --status=in_progress
```

**Step 2: Write failing Zod validation tests first**

Create the test file enumerating:

- valid `confidence` block with both `score` and `label` sub-blocks
- valid `confidence` with only `score`
- valid `confidence` with only `label`
- invalid: `label.rules[].ceiling` not in `labels` values → reject
- invalid: `support` not a string → reject
- invalid: `rules` not sorted ascending by `whenSupportBelow` (or unsorted —
  agent decides whether to enforce sort at validation time or runtime; spec
  doesn't pin; default: allow unsorted, resolver sorts at use)

Run:

```bash
npx vitest run tests/core/contracts/types/signal-confidence.test.ts
```

Expected: FAIL (`SignalConfidence` not defined).

**Step 3: Implement types**

Per Spec 3 D5, define in `trajectory.ts`:

- `interface SignalConfidence` with `support: string`, optional
  `score: { threshold: number }`, optional
  `label: { rules: ConfidenceClampRule[] }`
- `interface ConfidenceClampRule` with `whenSupportBelow: number`,
  `ceiling: string`
- Extend `SignalStatsRequest` with optional `confidence?: SignalConfidence`

Add Zod schemas next to existing schema definitions. Cross-validate
`ceiling ∈ Object.values(labels)` either inline in the Zod refinement or in a
separate validator that loads alongside descriptors.

**Step 4: Run tests to verify they pass**

Run:

```bash
npx vitest run tests/core/contracts/types/signal-confidence.test.ts
```

Expected: PASS.

**Step 5: Type-check the whole project**

Run:

```bash
npm run typecheck
```

Expected: PASS (new types are additive; existing code unaffected).

**Step 6: Commit**

```bash
git add src/core/contracts/types/trajectory.ts \
  tests/core/contracts/types/signal-confidence.test.ts
git commit -m "feat(contracts): add SignalConfidence + ConfidenceClampRule types"
```

**Step 7: Close task**

```bash
bd update <task1-id> --status=in_progress  # already, no-op
bd close <task1-id> --reason="types landed; descriptor opt-in in Task 4"
```

---

## Task 2: Confidence-aware label resolver

**Spec reference:** Spec 3 D3 + D5 (algorithm).

**Files:**

- Modify: `src/core/domains/explore/label-resolver.ts`
- Test: `tests/core/domains/explore/label-resolver.test.ts` (create if absent;
  if present, extend)

**Step 1: Mark in_progress**

```bash
bd update <task2-id> --status=in_progress
```

**Step 2: Write failing resolver tests**

Cover, per Spec 3 D5 resolver algorithm + Acceptance Criteria 5-6:

- descriptor without `confidence` → no-op (base label returned)
- descriptor with `confidence.label` but missing support in `siblingValues` →
  no-op
- value `>= p95` percentile (would be `critical`) + support `< 5` → return
  `typical`
- same value + support `5..9` → return `concerning`
- same value + support `>= 10` → return `critical` (unchanged)
- ceiling cannot RAISE severity (if base label is `healthy` and ceiling rule
  says `concerning`, result stays `healthy`)
- synthetic descriptor with `support: "fooCount"` and arbitrary rules behaves
  identically to `bugFixRate`-specific shape

Run:

```bash
npx vitest run tests/core/domains/explore/label-resolver.test.ts
```

Expected: FAIL (algorithm not yet implementing confidence).

**Step 3: Implement updated resolver**

Per Spec 3 D3, extend `resolveLabel`:

- Accept optional `LabelContext { siblingValues?, descriptor? }`.
- Compute base label via existing percentile binning.
- If `descriptor.stats.confidence?.label` undefined → return base.
- If `support = siblingValues[confidence.support]` undefined → return base.
- Walk `confidence.label.rules` ascending by `whenSupportBelow`. First matching
  rule (`support < rule.whenSupportBelow`) provides ceiling.
- Compare ceiling to base label via label-ordering derived from `labels`
  percentile keys (lower percentile = less severe). Return less-severe of {base,
  ceiling}.

Label-ordering helper: given the `labels` map (e.g.
`{p50: "healthy", p75: "concerning", p95: "critical"}`), order is ascending
percentile. A label is "less severe" if its percentile key is lower.

**Step 4: Run resolver tests**

Run:

```bash
npx vitest run tests/core/domains/explore/label-resolver.test.ts
```

Expected: PASS all cases.

**Step 5: Run full test suite (no regressions in other label callers)**

Run:

```bash
npm test
```

Expected: PASS or fail only in areas Task 3 will touch (`reranker.ts` hasn't
been updated yet — if reranker tests fail because they don't pass `descriptor`,
that's expected; document but don't fix in Task 2). If unrelated tests fail,
STOP and consult.

**Step 6: Commit**

```bash
git add src/core/domains/explore/label-resolver.ts \
  tests/core/domains/explore/label-resolver.test.ts
git commit -m "feat(explore): confidence-aware label resolution"
```

**Step 7: Close**

```bash
bd close <task2-id>
```

---

## Task 3: Plumb confidence context through reranker

**Spec reference:** Spec 3 D4 + D8 (the part that builds
`ExtractContext.confidence` from raw descriptor).

**Files:**

- Modify: `src/core/domains/explore/reranker.ts` (focus areas:
  `applyLabelResolution` at lines ~420-465, `extractAllDerived` at lines
  ~282-317, `buildOverlay` at lines ~362-418 — verify exact locations via
  current code)
- Test: `tests/core/domains/explore/reranker.test.ts` (extend)

**Step 1: Mark in_progress**

```bash
bd update <task3-id> --status=in_progress
```

**Step 2: Write reranker integration tests**

Cover:

- reranker, given a payload with `bugFixRate=63, commitCount=3` and a mock
  descriptor declaring `confidence.label.rules`, emits overlay with
  `bugFixRate.label === "healthy"` and raw `value === 63`.
- reranker passes `ExtractContext.confidence` (with `support` and
  `score.threshold`) to derived-signal extract when raw descriptor declares
  `confidence.score`.
- when descriptor has no `confidence` block → no-op pass-through.

Run:

```bash
npx vitest run tests/core/domains/explore/reranker.test.ts
```

Expected: FAIL (reranker plumbing not yet present).

**Step 3: Implement reranker plumbing**

Per Spec 3 D4:

- Build scope-aware `siblingValues` map at the same scope (file or chunk) as the
  signal being labeled. Helper `collectNumericSiblings` if not already present.
- Pass `{siblingValues, descriptor}` to `resolveLabel`.
- For derived-signal extraction (`extractAllDerived` or similar): when raw
  descriptor declares `confidence.score`, build
  `ExtractContext.confidence = { support, threshold }` so derived classes can
  call `confidenceDampening(supportValue, threshold)` without hardcoded
  constants.

**Step 4: Run reranker tests**

```bash
npx vitest run tests/core/domains/explore/reranker.test.ts
```

Expected: PASS new cases; existing reranker tests still PASS.

**Step 5: Run full suite**

```bash
npm test
```

Expected: PASS. Spec 3 D6 promises numerical equivalence for `bugFix` derived
score before/after refactor — confirmed in Task 6, but at this checkpoint
nothing should regress.

**Step 6: Commit**

```bash
git add src/core/domains/explore/reranker.ts \
  tests/core/domains/explore/reranker.test.ts
git commit -m "feat(explore): plumb confidence context through reranker"
```

**Step 7: Close**

```bash
bd close <task3-id>
```

---

## Task 4: bugFixRate descriptor opts in to unified confidence

**Spec reference:** Spec 3 D5 (descriptor block contents).

**Files:**

- Modify: `src/core/domains/trajectory/git/payload-signals.ts`

**Step 1: Mark in_progress**

```bash
bd update <task4-id> --status=in_progress
```

**Step 2: Add `confidence` block to bugFixRate descriptors**

Locate `git.file.bugFixRate` and `git.chunk.bugFixRate` descriptors in
`payload-signals.ts`. Per Spec 3 D5, add to each `stats` block:

```
confidence: {
  support: "commitCount",
  score: { threshold: 10 },
  label: {
    rules: [
      { whenSupportBelow: 5,  ceiling: "healthy"    },
      { whenSupportBelow: 10, ceiling: "concerning" },
    ],
  },
}
```

Both file-scope and chunk-scope descriptors — `support: "commitCount"` is
bare-name and resolves at the descriptor's own scope (D4 scope convention).

**Step 3: Type-check**

```bash
npm run typecheck
```

Expected: PASS (the type was added in Task 1).

**Step 4: Run Zod descriptor validation tests**

If the project has a "descriptor-load validation" test (likely in
`tests/core/domains/trajectory/git/payload-signals.test.ts` or similar —
discover via `grep -rn "payloadSignals\|bugFixRate" tests/`):

```bash
npx vitest run tests/core/domains/trajectory/git/payload-signals.test.ts
```

Expected: PASS. Zod from Task 1 validates the new block at load.

If no such test exists, write one that loads `payloadSignals` and asserts the
`confidence` block is present on both bugFixRate descriptors with the exact
`support` / `score.threshold` / `label.rules` values above.

**Step 5: Commit**

```bash
git add src/core/domains/trajectory/git/payload-signals.ts \
  tests/core/domains/trajectory/git/payload-signals.test.ts
git commit -m "feat(signals): bugFixRate opts in to unified confidence"
```

**Step 6: Close**

```bash
bd close <task4-id>
```

---

## Task 5: BugFixSignal reads dampening from descriptor

**Spec reference:** Spec 3 D8 (score-side migration).

**Files:**

- Modify: `src/core/domains/trajectory/git/rerank/derived-signals/bug-fix.ts`
- Modify: `src/core/domains/trajectory/git/rerank/derived-signals/helpers.ts`
  (`GIT_FILE_DAMPENING` constant — remove or mark deprecated)
- Test:
  `tests/core/domains/trajectory/git/rerank/derived-signals/bug-fix.test.ts`
  (extend with score-equivalence regression test)

**Step 1: Run V3 verification (open assumption from top of plan)**

```bash
grep -rn "confidenceDampening\|dampeningSource\|FALLBACK_THRESHOLD" \
  src/core/domains/trajectory/git/rerank/derived-signals/
```

Record findings. **If only `BugFixSignal` uses `confidenceDampening`:** proceed
with full removal of `GIT_FILE_DAMPENING`. **If other signals use it:** keep the
constant exported but mark its usage in those signals with a
`// TODO: migrate to descriptor.stats.confidence` comment AND create a follow-up
beads task documenting the deferred migrations.

**Step 2: Mark in_progress**

```bash
bd update <task5-id> --status=in_progress
```

**Step 3: Write score-equivalence regression test**

Per Spec 3 D8 Acceptance: numerically identical `bugFix` score before vs after
refactor.

Cover:

- Mock payload: `bugFixRate=63, commitCount=3` → `bugFix` score X (record from
  pre-refactor run; either snapshot the actual value or compute analytically via
  `confidenceDampening((3/10)^2) * (63/100)`).
- Same payload + descriptor with
  `confidence: {support:"commitCount", score:{threshold:10}}` → `bugFix` score
  must equal X.
- Multiple `(bugFixRate, commitCount)` combinations from a fixture table to
  cover the dampening curve.

If a pre-refactor reference value cannot be obtained from the current codebase
before edits land, capture it via a tiny one-off script in Step 4 BEFORE making
the refactor edits.

```bash
npx vitest run tests/core/domains/trajectory/git/rerank/derived-signals/bug-fix.test.ts
```

Expected: FAIL (descriptor-driven path not yet implemented OR refactor not yet
made; precise failure mode depends on TDD order).

**Step 4: Capture pre-refactor reference values (if needed)**

Run one-off script (paste in shell or temp file):

```bash
# Calls BugFixSignal.extract directly with fixture payloads and prints scores
node --import tsx -e "
import { BugFixSignal } from './src/core/domains/trajectory/git/rerank/derived-signals/bug-fix.js';
const sig = new BugFixSignal();
for (const [bfr, cc] of [[63,3],[63,8],[63,50],[30,4],[12,2]]) {
  console.log(bfr, cc, sig.extract({ 'git.file.bugFixRate': bfr, 'git.file.commitCount': cc }));
}
"
```

Record the printed values; bake them into the regression test as expected
outputs.

**Step 5: Refactor `BugFixSignal`**

Per Spec 3 D8:

- Remove `readonly dampeningSource = GIT_FILE_DAMPENING;`
- Remove `private static readonly FALLBACK_THRESHOLD = 10;`
- `extract` reads `ctx.confidence?.support` + `ctx.confidence?.score?.threshold`
  (populated by reranker from raw descriptor — see Task 3). Falls back
  gracefully if `ctx.confidence` absent (e.g. for tests using legacy context
  shape — keep a safe default of `support="commitCount"` and `threshold=10` only
  as a temporary backstop during migration; remove once all callers verified).

**Step 6: Audit + migrate / defer non-BugFix signals**

Per V3 finding:

- **Single migration:** if only `BugFixSignal` uses `confidenceDampening`,
  remove the `GIT_FILE_DAMPENING` export.
- **Multiple signals, all simple:** migrate them all in this commit; add their
  `confidence.score` blocks to their respective descriptors in
  `payload-signals.ts` (Task 4 scope expands).
- **Multiple signals, non-trivial:** keep `GIT_FILE_DAMPENING` exported with a
  `@deprecated` JSDoc comment; create a follow-up beads task
  `Migrate remaining derived signals to unified confidence` linked to this epic.

**Step 7: Run regression test**

```bash
npx vitest run tests/core/domains/trajectory/git/rerank/derived-signals/bug-fix.test.ts
```

Expected: PASS — numerically identical scores.

**Step 8: Run full suite**

```bash
npm test
```

Expected: PASS.

**Step 9: Commit**

```bash
git add src/core/domains/trajectory/git/rerank/derived-signals/bug-fix.ts \
  src/core/domains/trajectory/git/rerank/derived-signals/helpers.ts \
  tests/core/domains/trajectory/git/rerank/derived-signals/bug-fix.test.ts
# add payload-signals.ts if migration scope expanded per Step 6
git commit -m "refactor(signals): BugFixSignal reads dampening from descriptor"
```

**Step 10: Close + (if deferred) file follow-up**

```bash
bd close <task5-id>
# Only if V3 found non-trivial non-bugFix migrations:
bd create --title="Migrate remaining derived signals to unified confidence" \
  --description="Follow-up from epic <EPIC_ID>: signals using confidenceDampening that weren't migrated in plan task 5. Audit findings: <paste V3 output>." \
  --type=task --priority=3
```

---

## Task 6: Unit tests for unified confidence mechanism

**Spec reference:** Spec 3 Acceptance Criteria 5-7.

**Files:**

- Modify (likely): test files from Tasks 2, 3, 5 — augment with cross-cutting
  genericity tests
- OR create: `tests/core/domains/explore/confidence-mechanism.test.ts` for
  genericity coverage that doesn't fit any one file

**Step 1: Mark in_progress**

```bash
bd update <task6-id> --status=in_progress
```

**Step 2: Add mechanism genericity tests**

Cover:

- Synthetic raw descriptor with `support: "fooCount"` and
  `label.rules: [{whenSupportBelow: 7, ceiling: "low"}]` — resolver emits the
  synthetic ceiling correctly.
- Synthetic descriptor with `score.threshold: 42` — derived signal extract
  receives `42` as threshold (not hardcoded 10).
- Edge: `confidence.label.rules` empty array → resolver treats as no clamp (base
  label preserved).
- Edge: `confidence` declared without `score` and without `label` — resolver and
  extractor both no-op on confidence path.
- Edge: chunk-scope descriptor with `support: "commitCount"` reads
  `chunk.commitCount`, not `file.commitCount` (D4 scope convention).

**Step 3: Run tests**

```bash
npx vitest run
```

Expected: PASS all.

**Step 4: Coverage check**

Run:

```bash
npx vitest run --coverage
```

Expected: confidence mechanism files at ≥90% line coverage. If gaps, add tests
targeting uncovered branches (NEVER use `/* v8 ignore */` — see
`.claude/rules/test-patterns.md`).

**Step 5: Commit**

```bash
git add tests/
git commit -m "test(signals): unified confidence mechanism coverage"
```

**Step 6: Close**

```bash
bd close <task6-id>
```

---

## Task 7: Align HotspotsPreset docstring with weights

**Spec reference:** Spec 1 D1-D4.

**Files:**

- Modify: `src/core/domains/trajectory/git/rerank/presets/hotspots.ts`

**Step 1: Run V1 + V2 verifications (from top of plan)**

Per V1: check if `SchemaBuilder` consumes `preset.description`. Per V2: check if
snapshot tests cover preset description text.

If V1 hits AND V2 hits: this task includes snapshot regeneration; add ~30 min.

**Step 2: Mark in_progress**

```bash
bd update <task7-id> --status=in_progress
```

**Step 3: Rewrite JSDoc and description**

Per Spec 1 D1, replace JSDoc block (currently lines ~4-14) and `description`
field (currently line ~17). Exact text in Spec 1 D1.

Key points the new text must satisfy:

- Removes substring "bug-prone" from JSDoc and `description`.
- Honestly lists `bugFix` as `~10% minor tiebreaker, NOT a bug-history lens`.
- Replaces misleading "merge contention" framing with chunk-level granularity
  language.
- Compare line distinguishes by granularity (chunk-level vs file-normalized
  churn), not "presence vs absence of temporal signals".

Per Spec 1 D2-D4: do NOT change `weights`, `tools`, `overlayMask`, or `name`.

**Step 4: Verify no behavior change**

Run preset tests:

```bash
grep -rln "HotspotsPreset" tests/
# If matches found:
npx vitest run <matched test files>
```

Expected: PASS — only docstring/description changed; behavior is identical.

**Step 5: Regenerate snapshots if V2 hit**

If V2 found snapshot coverage of preset description:

```bash
npx vitest run --update-snapshots <relevant test files>
```

Inspect the diff manually to ensure only description text changed.

**Step 6: Type-check and build**

```bash
npm run typecheck
npm run build
```

Expected: PASS both.

**Step 7: Commit**

```bash
git add src/core/domains/trajectory/git/rerank/presets/hotspots.ts
# If snapshot regen happened, add affected snapshot files too
git commit -m "docs(presets): align HotspotsPreset docstring with weights"
```

**Step 8: Close**

```bash
bd close <task7-id>
```

---

## Task 8: Fragile Silo pattern + anti-pattern + recipe (docs bundle)

**Spec reference:** Spec 2 (D2, D3, D5) + Spec 4 (D1, D2, D3) + Spec 5 (D1-D4).

**Files:**

- Modify: `.claude-plugin/tea-rags/rules/references/signal-interpretation.md`
  (Spec 2 catalog entry + Spec 2 cross-links + Spec 4 anti-pattern #8)
- Modify:
  `.claude-plugin/tea-rags/skills/risk-assessment/references/classification-tiers.md`
  (Spec 2 14th tier row)
- Modify: `.claude-plugin/tea-rags/rules/references/use-cases.md` (Spec 5
  Fragile Silo discovery recipe + table row)

**Combination rationale:** these three files are independent text edits with no
compile coupling. Combining them into one Task and one commit keeps the docs
change reviewable as a unified update to the "Fragile Silo support surface".
Splitting per file would inflate commit count without functional benefit.

**Step 1: Mark in_progress**

```bash
bd update <task8-id> --status=in_progress
```

**Step 2: Edit `signal-interpretation.md`**

Three insertions, in this order to keep edit ranges stable:

1. **Fragile silo pattern section** — insert after the `Toxic silo` section in
   "Architectural patterns catalog". Content: Signature, What it is,
   Remediation, Disambiguators per Spec 2 D2.
2. **Cross-links from `Toxic silo` and `Fragile legacy`** — small edits to those
   existing sections per Spec 2 D5.
3. **Anti-pattern #8** — append to "Interpretation anti-patterns" list.
   Class-level wording per Spec 4 D1. Items 1-7 untouched (no renumbering).

**Step 3: Edit `classification-tiers.md`**

Add 14th tier row to the table per Spec 2 D3. Position: between `Toxic silo` and
`Healthy owner`.

**Step 4: Edit `use-cases.md`**

Add Fragile Silo discovery recipe per Spec 5 D2 — table row + code block with
copy-paste template.

**Step 5: Lint the markdown**

If `mcp__markdownlint__lint_markdown` MCP tool is available:

```bash
# Or via npx if a binding exists in the repo
npx markdownlint .claude-plugin/tea-rags/rules/references/signal-interpretation.md \
  .claude-plugin/tea-rags/skills/risk-assessment/references/classification-tiers.md \
  .claude-plugin/tea-rags/rules/references/use-cases.md
```

Expected: clean. Fix any violations before commit. If markdownlint is
unavailable, skip and note in commit message.

**Step 6: Manual smoke check — links resolve**

```bash
grep -n "fragile-silo-pattern-design\|bugfixrate-label-confidence-design\|fragile-silo-rerank-recipe" \
  .claude-plugin/tea-rags/rules/references/signal-interpretation.md \
  .claude-plugin/tea-rags/skills/risk-assessment/references/classification-tiers.md \
  .claude-plugin/tea-rags/rules/references/use-cases.md
```

Expected: every reference points to a file that exists in
`docs/superpowers/specs/`. Run a corroborating
`ls docs/superpowers/specs/2026-05-14-*.md` to confirm.

**Step 7: Commit**

```bash
git add .claude-plugin/tea-rags/rules/references/signal-interpretation.md \
  .claude-plugin/tea-rags/skills/risk-assessment/references/classification-tiers.md \
  .claude-plugin/tea-rags/rules/references/use-cases.md
git commit -m "docs(rules): Fragile Silo pattern + small-N anti-pattern + recipe"
```

**Step 8: Close**

```bash
bd close <task8-id>
```

---

## Task 9: Record bugProneness signal as deferred

**Spec reference:** Spec 6 (entire file is "Status: Deferred").

**Files:** none (beads only)

**Step 1: Mark in_progress (no edits expected — admin only)**

```bash
bd update <task9-id> --status=in_progress
```

**Step 2: Create the deferred follow-up task**

```bash
DEFERRED_ID=$(bd create --title="Implement bugProneness derived signal + optional FragileSiloPreset" \
  --description="DEFERRED. Spec: docs/superpowers/specs/2026-05-14-bug-proneness-derived-signal-deferred-design.md. Reactivation trigger: ≥3 distinct user requests for the named preset or signal. When triggered: open the spec, follow D1-D5, write a new plan." \
  --type=feature --priority=4 | awk '/Created/{print $NF}')
bd label add $DEFERRED_ID architecture
bd dep add $DEFERRED_ID $EPIC_ID
```

**Step 3: Immediately close as deferred**

```bash
bd close $DEFERRED_ID --reason="Deferred: design-on-shelf. Reactivate on ≥3 user requests for the named bugProneness preset/signal. Spec captures full design."
```

**Step 4: Close Task 9 itself**

```bash
bd close <task9-id> --reason="bugProneness deferred follow-up filed and closed as deferred"
```

(No git commit; this Task is purely beads metadata.)

---

## Task 10: tea-rags plugin minor bump

**Spec reference:** Spec 2 Plugin Version Bump (minor — new pattern content);
Specs 4 + 5 (patch each — absorbed into the same minor bump).

**Files:**

- Modify: `.claude-plugin/tea-rags/.claude-plugin/plugin.json`

**Step 1: Mark in_progress**

```bash
bd update <task10-id> --status=in_progress
```

**Step 2: Bump version**

Read current version:

```bash
grep '"version"' .claude-plugin/tea-rags/.claude-plugin/plugin.json
```

Bump to next minor. Example: `0.6.3` → `0.7.0`. Use Edit tool to change exactly
the version line; do not touch the rest of `plugin.json`.

**Step 3: Verify**

```bash
grep '"version"' .claude-plugin/tea-rags/.claude-plugin/plugin.json
```

Expected: shows new minor version.

**Step 4: Commit**

```bash
git add .claude-plugin/tea-rags/.claude-plugin/plugin.json
git commit -m "chore(release): tea-rags plugin minor bump for Fragile Silo support"
```

**Step 5: Close**

```bash
bd close <task10-id>
```

---

## Task 11: Pre-merge verification

**Files:** none (verification only)

**Step 1: Mark in_progress**

```bash
bd update <task11-id> --status=in_progress
```

**Step 2: Build**

```bash
npm run build
```

Expected: clean.

**Step 3: Type-check**

```bash
npm run typecheck
```

Expected: clean.

**Step 4: Full test suite**

```bash
npm test
```

Expected: all tests PASS. Note coverage threshold compliance — if a coverage
check fails on the pre-commit hook of a previous task, that should have been
resolved at that task; if it surfaces here as a regression, STOP and re-open the
relevant task.

**Step 5: Manual reproduction of user trigger case via MCP**

Manually drive `mcp__tea-rags__semantic_search` against a project that contains
`app/services/getting_paid/proposals/update_package_invoice.rb` (or an
equivalent file with `bugFixRate=63, commitCount=3`):

```
project: <project alias>
query: "update package invoice"
pathPattern: "**/proposals/**"
rerank: "hotspots"
limit: 5
metaOnly: true
```

Expected in overlay: `bugFixRate: { value: 63, label: "healthy" }` (NOT
`"critical"`). Confirms Spec 3 end-to-end.

**Step 6: Manual recipe reproduction**

Run the Fragile Silo discovery recipe from Task 8:

```
rerank: { custom: { bugFix: 0.45, knowledgeSilo: 0.30, similarity: 0.15, churn: -0.10 } }
```

against the same project. Expected: the trigger file ranks near the top of
results.

**Step 7: Close epic**

If all verifications PASS:

```bash
bd close <task11-id>
# Epic closes automatically when all children close; if not:
bd close $EPIC_ID --reason="All 11 tasks complete; end-to-end acceptance verified"
```

**Step 8: Sync beads**

```bash
bd dolt push
```

(Do NOT `git push` — user controls remote pushes.)

---

## End-to-End Acceptance Criteria

The plan is complete when ALL of the following hold:

1. User's trigger case (`bugFixRate=63, commitCount=3`) emits
   `{ value: 63, label: "healthy" }` in overlay (verified Task 11 Step 5).
2. `bugFix` derived score is numerically identical before/after Task 5 refactor
   (verified Task 5 Step 7 regression test).
3. risk-assessment skill classifies the trigger file as `Fragile silo` (High
   tier) under updated `classification-tiers.md` (manual review of skill output
   against Task 8 changes).
4. Fragile Silo discovery recipe ranks the trigger file near top of its scope
   (verified Task 11 Step 6).
5. `rerank: "hotspots"` results unchanged numerically; only the MCP-visible
   `description` text changes (verified Task 7 Step 4 + Task 11 Step 4).
6. `npm run build`, `npm test`, `npm run typecheck` all clean at Task 11 (Steps
   2-4).
7. Beads epic has 11 closed children + 1 deferred follow-up; `bd stats` reflects
   this.
8. `git log --oneline` shows the 7 expected commits in order (one per Task 1-8 +
   Task 10; Tasks 9, 11 are commit-less).

---

## Краткое summary для пользователя

План разбит на **12 шагов**: Task 0 (beads bootstrap) + 11 tasks (7 кодовых + 1
docs-bundle + 1 admin + 1 release + 1 verification).

**Порядок:**

1. **Types + Zod** (Task 1) — фундамент в `trajectory.ts`
2. **Resolver** (Task 2) — алгоритм label clamp в `label-resolver.ts`
3. **Reranker plumbing** (Task 3) — sibling map + ExtractContext в `reranker.ts`
4. **Descriptor opt-in** (Task 4) — bugFixRate в `payload-signals.ts`
5. **Score-side migration** (Task 5) — `BugFixSignal` читает из descriptor'а;
   audit других сигналов
6. **Mechanism tests** (Task 6) — генеричность + score-equivalence
7. **HotspotsPreset docstring** (Task 7) — Spec 1
8. **Docs bundle** (Task 8) — Specs 2 + 4 + 5 в одном коммите
9. **bugProneness deferred** (Task 9) — beads-only
10. **Plugin minor bump** (Task 10) — `tea-rags/.claude-plugin/plugin.json`
11. **Verification** (Task 11) — build/test/typecheck + manual MCP

**Перед стартом** агент-исполнитель проверяет три открытых предположения (V1:
SchemaBuilder consumer; V2: snapshot tests на JSDoc; V3: сколько derived signals
помимо BugFixSignal используют `confidenceDampening`). Каждое предположение либо
подтверждается и двигает план дальше, либо вешает flag и требует консультации.

**Что НЕ в плане:** `git push`, branch merge, push в Slack/issues — пользователь
контролирует.

**Acceptance criteria — 8 пунктов**, последний из которых проверяет что в git
history ровно 7 коммитов в правильном порядке.
