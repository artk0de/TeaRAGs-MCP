# extract-project-patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. **Wrapper
> override:** dispatch via `dinopowers:executing-plans` (per CHAINING). Steps
> use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce `tea-rags:extract-project-patterns` — an agent-only recipe
skill that returns proven reference code via a three-level locality cascade
(subdomain → first-2-segments → project) — and wire it into DDG Step 2,
`dinopowers:writing-plans`, and `dinopowers:executing-plans`.

**Architecture:** New agent-only skill `tea-rags:extract-project-patterns`
encapsulates the cascade and quality gate, returning
`{ templates, locality, diagnostics }`. The existing `ProvenPreset` (TS class)
gains `find_similar` in `tools[]` so `rerank: "proven"` is accepted by the
find_similar schema. Three consumers replace their inline templating logic with
a delegated call.

**Tech Stack:** TypeScript (preset class), Markdown SKILL.md (plugin skills),
vitest (unit tests).

**Spec:** `docs/superpowers/specs/2026-05-18-extract-project-patterns-design.md`
**Beads epic:** `tea-rags-mcp-vr7v` (sync deferred to Task 6 — beads unavailable
in worktree) **Worktree:** `worktree-ddg-project-wide-templates` (current
session is already inside it)

**Ordering rationale (from tea-rags impact enrichment):**

1. ProvenPreset edit (Task 1) lands BEFORE any SKILL.md that references
   `rerank: "proven"` on find_similar — otherwise schema validation fails
   downstream.
2. New skill creation (Task 2) lands BEFORE the three consumer wire-ins (Tasks
   3-5) — otherwise the consumers reference a missing skill.
3. dinopowers wire-ins (Tasks 4-5) bump the same plugin twice (patch each); each
   commit MUST include a fresh bump per `.claude/rules/plugin-versioning.md`.

---

## Task 1: Extend ProvenPreset tools[] to include find_similar

**Files:**

- Modify: `tests/core/domains/trajectory/git/rerank/presets/proven.test.ts`
  (existing — see lines 12-17)
- Modify: `src/core/domains/trajectory/git/rerank/presets/proven.ts:26`

**Why this Task first:** `proven.ts` is registered in `TrajectoryRegistry` at
the composition root. Adding `find_similar` to `tools[]` changes the
`find_similar` schema enum surfaced to all MCP consumers. Downstream Tasks (2-5)
all reference `rerank: "proven"` on find_similar — they will fail schema
validation if this Task is skipped or reordered.

- [ ] **Step 1: Update the failing test (RED)**

Edit `tests/core/domains/trajectory/git/rerank/presets/proven.test.ts` lines
12-17. Current content:

```typescript
it("is available in semantic_search, hybrid_search, and search_code", () => {
  expect(preset.tools).toContain("semantic_search");
  expect(preset.tools).toContain("hybrid_search");
  expect(preset.tools).toContain("search_code");
  expect(preset.tools).toHaveLength(3);
});
```

Replace with:

```typescript
it("is available in semantic_search, hybrid_search, search_code, and find_similar", () => {
  expect(preset.tools).toContain("semantic_search");
  expect(preset.tools).toContain("hybrid_search");
  expect(preset.tools).toContain("search_code");
  // find_similar is required so extract-project-patterns can pass rerank="proven"
  // through find_similar (chunk-based template lookup).
  expect(preset.tools).toContain("find_similar");
  expect(preset.tools).toHaveLength(4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
`npx vitest run tests/core/domains/trajectory/git/rerank/presets/proven.test.ts`
Expected: FAIL — `Expected length: 4, Received length: 3`.

- [ ] **Step 3: Add find_similar to ProvenPreset.tools[] (GREEN)**

Edit `src/core/domains/trajectory/git/rerank/presets/proven.ts` line 26.
Current:

```typescript
  readonly tools = ["semantic_search", "hybrid_search", "search_code"];
```

Replace with:

```typescript
  readonly tools = ["semantic_search", "hybrid_search", "search_code", "find_similar"];
```

- [ ] **Step 4: Run test to verify it passes**

Run:
`npx vitest run tests/core/domains/trajectory/git/rerank/presets/proven.test.ts`
Expected: PASS — all 7 cases green.

- [ ] **Step 5: Type-check and full test sweep**

Run: `npm run build && npx vitest run` Expected: build succeeds, all tests
green. (full sweep catches any other test that asserts the old `tools[]`
length.)

- [ ] **Step 6: Commit**

```bash
git add tests/core/domains/trajectory/git/rerank/presets/proven.test.ts \
        src/core/domains/trajectory/git/rerank/presets/proven.ts
git commit -m "feat(rerank): add find_similar to ProvenPreset tools list

Allows rerank=\"proven\" on find_similar calls. Unblocks the
extract-project-patterns recipe (next task), which uses find_similar with
the proven preset to pull chunk-based templates from the project.

Refs beads tea-rags-mcp-vr7v."
```

---

## Task 2: Create tea-rags:extract-project-patterns recipe skill

**Files:**

- Create: `.claude-plugin/tea-rags/skills/extract-project-patterns/SKILL.md`
- Modify: `.claude-plugin/tea-rags/.claude-plugin/plugin.json` (version: 0.23.1
  → 0.24.0)

**Why this Task before 3-5:** Tasks 3, 4, 5 reference
`tea-rags:extract-project-patterns` in their SKILL.md changes. Creating the
skill first ensures those references resolve.

- [ ] **Step 1: Create the skill directory and SKILL.md**

Path: `.claude-plugin/tea-rags/skills/extract-project-patterns/SKILL.md`

Full content:

```markdown
---
name: extract-project-patterns
user-invocable: false
description:
  Agentic-only enrichment skill — surfaces battle-tested reference code from the
  project as templates for generation / modification. Three-level locality
  cascade (target subdomain → domain → project) with quality gate by overlay
  labels and the project-wide proven rerank preset. Returns a ranked list of
  reference chunks plus locality annotation (L1 / L2 / L3 / none). Invoked by
  `tea-rags:data-driven-generation` Step 2 (TEMPLATE),
  `dinopowers:writing-plans` (per code-gen Task), and
  `dinopowers:executing-plans` (per Task during execute). Skipped automatically
  when no `positiveIds` / `positiveCode` and no `behaviorQuery` are available.
---

# extract-project-patterns

Internal recipe for code generation skills. Find a battle-tested template in the
project for the code you are about to write, via a three-level locality cascade.
Invoked by parent skills; not by users directly.

## Inputs

Caller passes:

| Input           | Required | Notes                                                       |
| --------------- | -------- | ----------------------------------------------------------- |
| `positiveIds`   | one-of   | Chunk IDs from prior cascade results                        |
| `positiveCode`  | one-of   | Raw code snippet(s) (embedded on the fly by `find_similar`) |
| `behaviorQuery` | one-of   | NL query if no chunk/code is available                      |
| `pathPatternL1` | yes      | From explore PG-OUTPUT (deepest subdomain target)           |
| `limit`         | no       | Default 10                                                  |

At least one of `positiveIds` / `positiveCode` / `behaviorQuery` MUST be
present. Otherwise return
`{ templates: [], locality: "none", diagnostics: ["no input"] }`.

## Recipe — three-level locality cascade
```

L1 pathPattern = pathPatternL1 (deepest subdomain) L2 pathPattern = first 2 path
segments of L1 (broader domain) if L1 has ≤ 2 segments → L2 = L1, skip L2 step
entirely L3 pathPattern = null (project-wide)

```

**L2 derivation example.**
- L1 = `**/domains/trajectory/git/rerank/derived-signals/**`
  → segments `[domains, trajectory, git, rerank, derived-signals]`
  → L2 = `**/domains/trajectory/**`.
- L1 = `**/chunker/hooks/**`
  → segments `[chunker, hooks]`
  → L2 = L1, skip L2, jump to L3.

**For each level in [L1, L2, L3]:**

1. Call `find_similar` (or `semantic_search` / `hybrid_search` if only
   `behaviorQuery` is available) with:
   - `rerank: "proven"`
   - `pathPattern: <level>` (omit for L3)
   - `limit: <input limit, default 10>`
   - inputs: `positiveIds` | `positiveCode` | `query: behaviorQuery`
2. Apply quality gate over result overlay labels:
   - `ideal_count` = chunks where
     - `commitCount` label is `"low"` or `"typical"`, AND
     - `ageDays` label is `"old"` or `"legacy"`, AND
     - `bugFixRate` label is `"healthy"`
   - If `ideal_count ≥ 2` → return top result + locality annotation. Stop.
3. Apply reject filter (regardless of gate pass):
   - chunks where `bugFixRate` is `"critical"` OR (`ageDays` is `"recent"`
     AND `commitCount` is `"low"`) are excluded from the returned top.
4. If no qualifying chunk → next level.

If all three levels fail → return diagnostic
`"no proven templates for <input> in this project"` so caller can fall back
(generate from scratch, ask user, etc.).

## Output

Structured object for caller consumption:

```

{ templates: [ { chunkId, path, level: "L1" | "L2" | "L3", labels: {
commitCount, ageDays, bugFixRate, blameContributorCount, ... },
blameDominantAuthor, }, ... ], locality: "L1" | "L2" | "L3" | "none",
diagnostics: [<per-level fail reasons>], }

```

Caller reads `templates[0]` as the reference; `locality` informs how to use
the template:

- `L1` → matches subdomain exactly. Use template's `blameDominantAuthor` for
  style and review routing.
- `L2` → template is from a sibling subdomain in the same broader domain.
  `blameDominantAuthor` reviews the technique, not exact code.
- `L3` → template is from the project at large. `blameDominantAuthor`
  reviews the technique only; verify architectural fit before adopting
  verbatim.
- `none` → no template found. Caller should generate from scratch and
  surface this to the user so they know to scrutinize the result.

## Skip clause

Return immediately with empty templates if:

- None of `positiveIds` / `positiveCode` / `behaviorQuery` are provided
- The project has no git enrichment indexed (no overlay labels available
  → quality gate cannot run)

## Invoked by

- `tea-rags:data-driven-generation` Step 2 (TEMPLATE)
- `dinopowers:writing-plans` (per code-generation / code-modification Task)
- `dinopowers:executing-plans` (per Task during execute)

## Eval coverage

`/optimize-skill extract-project-patterns` runs baseline cases. Fixture file
`evals/cases.json` is added in a follow-up PR (out of scope for the initial
recipe landing — see spec Component E).
```

- [ ] **Step 2: Bump tea-rags plugin version**

Edit `.claude-plugin/tea-rags/.claude-plugin/plugin.json`. Change line:

```json
  "version": "0.23.1",
```

to:

```json
  "version": "0.24.0",
```

Reason: new skill → minor bump per `.claude/rules/plugin-versioning.md`.

- [ ] **Step 3: Verify skill loads in plugin index**

Run: `ls .claude-plugin/tea-rags/skills/extract-project-patterns/` Expected:
`SKILL.md` listed.

Run:
`grep -c '^name: extract-project-patterns' .claude-plugin/tea-rags/skills/extract-project-patterns/SKILL.md`
Expected: `1`

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/tea-rags/skills/extract-project-patterns/SKILL.md \
        .claude-plugin/tea-rags/.claude-plugin/plugin.json
git commit -m "feat(tea-rags): add extract-project-patterns recipe skill

Agent-only enrichment skill that returns proven reference code via a
three-level locality cascade (subdomain → first-2-segments → project)
with a quality gate over overlay labels. Output shape is structured
{ templates, locality, diagnostics } for caller consumption.

Consumers (DDG Step 2, dinopowers:writing-plans, dinopowers:executing-plans)
land in follow-up tasks. Eval fixtures (evals/cases.json) deferred to a
follow-up PR per spec Component E.

Bump tea-rags 0.23.1 → 0.24.0 (new skill = minor).

Refs beads tea-rags-mcp-vr7v.

Why: deep-silo file; spec records intent and trade-offs."
```

(Note: the `Why:` footer is required by `.claude/rules/silo-pairing.md` because
the file lives in `.claude-plugin/tea-rags/skills/` — silo class on plugin
author. Keep this footer pattern through Tasks 3-5.)

---

## Task 3: Rewrite DDG Step 2 TEMPLATE to delegate to extract-project-patterns

**Files:**

- Modify: `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`
  (lines 70-83)
- Modify: `.claude-plugin/tea-rags/.claude-plugin/plugin.json` (version: 0.24.0
  → 0.24.1)

**Why this Task after 2:** Step 2 rewrite references
`tea-rags:extract-project-patterns` — the skill must exist first.

- [ ] **Step 1: Replace Step 2 TEMPLATE section in DDG SKILL.md**

Open `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`. Replace
lines 70-83 (the `### Step 2: TEMPLATE` block):

Current:

```markdown
### Step 2: TEMPLATE

Follow search-cascade: pass best verified result as code/chunk example (cascade
→ find_similar) + custom "proven" rerank:
`{ similarity: 0.2, stability: 0.3, age: 0.3, bugFix: -0.15, ownership: -0.05 }`.
This finds battle-tested code: long-lived, low-churn, low-bug, multi-author.
Fallback: follow search-cascade with behavior query + same custom weights.

Quality gate by labels:

- **Ideal:** commitCount "low"/"typical" + ageDays "old"/"legacy" + bugFixRate
  "healthy"
- **Reject:** bugFixRate "critical" OR (ageDays "recent" + commitCount "low")
```

Replace with:

```markdown
### Step 2: TEMPLATE

Delegate to `tea-rags:extract-project-patterns` with:

- `positiveIds` | `positiveCode` = best verified result from Step 1 cascade (or
  set `behaviorQuery` if no chunk/code is available)
- `pathPatternL1` = pathPattern from explore PG-OUTPUT
- `limit` = 10

Read `templates[0]` as the reference for Step 4 (GENERATE). The recipe owns the
locality cascade (L1 = subdomain, L2 = first 2 segments, L3 = project) and the
quality gate (commitCount low/typical + ageDays old/legacy + bugFixRate healthy;
reject if bugFixRate critical or ageDays recent + commitCount low).

Read `locality` to inform Step 3 (STYLE):

- `L1` → use template's `blameDominantAuthor` for style and review routing.
- `L2` → `blameDominantAuthor` reviews the technique, not exact code.
- `L3` → `blameDominantAuthor` reviews the technique only; verify architectural
  fit before adopting verbatim.
- `none` → no template; generate from scratch and surface this to the user so
  they know to scrutinize the result.
```

- [ ] **Step 2: Bump tea-rags plugin version**

Edit `.claude-plugin/tea-rags/.claude-plugin/plugin.json`. Change:

```json
  "version": "0.24.0",
```

to:

```json
  "version": "0.24.1",
```

Reason: text change to existing skill → patch bump.

- [ ] **Step 3: Verify the references**

Run:
`grep -n 'extract-project-patterns' .claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`
Expected: at least one match in the Step 2 section.

Run:
`grep -n 'custom.*similarity.*stability.*age' .claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`
Expected: zero matches (old inline weights removed).

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md \
        .claude-plugin/tea-rags/.claude-plugin/plugin.json
git commit -m "improve(tea-rags): delegate DDG Step 2 TEMPLATE to extract-project-patterns

Removes inline custom rerank weights ({similarity 0.2, stability 0.3, age 0.3,
bugFix -0.15, ownership -0.05}) from DDG Step 2 TEMPLATE. Replaced with a
delegated call to tea-rags:extract-project-patterns, which owns the three-level
locality cascade and quality gate.

The recipe's locality annotation (L1/L2/L3/none) drives Step 3 (STYLE)
behavior — same-subdomain template gets standard blame-author review,
cross-subdomain template gets technique-only review.

Bump tea-rags 0.24.0 → 0.24.1 (text change to existing skill = patch).

Refs beads tea-rags-mcp-vr7v.

Why: deep-silo file; spec records intent and trade-offs."
```

---

## Task 4: Wire extract-project-patterns into dinopowers:writing-plans

**Files:**

- Modify: `.claude-plugin/dinopowers/skills/writing-plans/SKILL.md` (add new
  step after Step 3)
- Modify: `.claude-plugin/dinopowers/.claude-plugin/plugin.json` (version:
  0.17.0 → 0.17.1)

**Why this Task after 2:** Same as Task 3 — references the new skill.

- [ ] **Step 1: Add per-code-gen-Task hook to writing-plans SKILL.md**

Open `.claude-plugin/dinopowers/skills/writing-plans/SKILL.md`. Locate the end
of `## Step 3 — Aggregate per file` (which terminates around line 153, just
before `## Step 4 — Invoke superpowers:writing-plans`).

Insert a new section between Step 3 and Step 4:

```markdown
## Step 3.5 — Per-Task proven-template enrichment (code-generation Tasks)

For each Task in the plan draft (or each unit you intend to decompose into a
Task) where the title or description mentions code generation / modification —
heuristic keywords: "implement", "add", "write", "extend", "refactor", "modify"
combined with "function", "method", "class", "helper", "module" — invoke
`tea-rags:extract-project-patterns`:

1. Derive `pathPatternL1` from the Task's Affected Files (deepest common
   ancestor as a `**/<dir>/**` glob).
2. Invoke `tea-rags:extract-project-patterns` with:
   - `pathPatternL1` from step 1
   - `behaviorQuery` = Task title
   - `limit` = 5
3. Attach the result to the Task body under a `**Proven templates**` subsection:
```

**Proven templates** (extract-project-patterns, locality: L1|L2|L3|none)

- top: <path> (commitCount X, ageDays Y, bugFixRate Z)
- reviewer: <blameDominantAuthor>
  - locality L1 → review style + code
  - locality L2/L3 → review technique only

```

4. If `locality = "none"`, attach the diagnostic verbatim so the plan
reader knows this Task has no proven precedent in the project.

This step runs BEFORE Step 4 so the per-Task enrichment is visible to the
superpowers:writing-plans authoring cycle and surfaces in the final plan
document.

**Skip clause:** if no Task is classified as code-generation /
code-modification, skip this step entirely. Pure-config or pure-test plans
have no template need.
```

- [ ] **Step 2: Bump dinopowers plugin version**

Edit `.claude-plugin/dinopowers/.claude-plugin/plugin.json`. Change:

```json
  "version": "0.17.0",
```

to:

```json
  "version": "0.17.1",
```

Reason: text change to existing skill → patch bump.

- [ ] **Step 3: Verify**

Run:
`grep -n 'Step 3.5' .claude-plugin/dinopowers/skills/writing-plans/SKILL.md`
Expected: one match.

Run:
`grep -n 'extract-project-patterns' .claude-plugin/dinopowers/skills/writing-plans/SKILL.md`
Expected: at least one match.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/dinopowers/skills/writing-plans/SKILL.md \
        .claude-plugin/dinopowers/.claude-plugin/plugin.json
git commit -m "improve(dinopowers): wire extract-project-patterns into writing-plans per code-gen Task

Adds Step 3.5 between Step 3 (aggregate per file) and Step 4 (invoke
superpowers:writing-plans) that invokes tea-rags:extract-project-patterns
for each Task classified as code-generation / code-modification.

The recipe result attaches to the Task body under a Proven templates
subsection so reviewers see what reference the implementation should
follow and who reviews it.

Skip clause: pure-config / pure-test plans bypass the enrichment.

Bump dinopowers 0.17.0 → 0.17.1 (text change = patch).

Refs beads tea-rags-mcp-vr7v."
```

---

## Task 5: Wire extract-project-patterns into dinopowers:executing-plans

**Files:**

- Modify: `.claude-plugin/dinopowers/skills/executing-plans/SKILL.md` (add new
  step before Code-Gen Cascade)
- Modify: `.claude-plugin/dinopowers/.claude-plugin/plugin.json` (version:
  0.17.1 → 0.17.2)

**Why this Task last:** Logically symmetric to Task 4 but on the execute side.
Both Tasks 4 and 5 each bump dinopowers — per the
`.claude/rules/plugin-versioning.md` "every commit MUST bump" rule, each commit
gets its own bump.

- [ ] **Step 1: Read existing Step 5 (Code-Gen Cascade) location**

Run:
`grep -n '## Step 5 — Code-Gen Cascade' .claude-plugin/dinopowers/skills/executing-plans/SKILL.md`
Expected: single match around line 193-196 (per recent tea-rags impact data).

Read the surrounding content to confirm the integration point. The new hook
lands BEFORE Code-Gen Cascade because it provides input to that cascade.

- [ ] **Step 2: Insert pre-Code-Gen-Cascade hook**

In `.claude-plugin/dinopowers/skills/executing-plans/SKILL.md`, insert a new
section directly BEFORE
`## Step 5 — Code-Gen Cascade (MANDATORY for code-generation Tasks)`:

```markdown
## Step 4.5 — Per-Task proven-template lookup (code-generation Tasks)

For the Task you are about to execute, if it is classified as code-generation /
code-modification (per the same heuristic as `dinopowers:writing-plans` Step
3.5: keywords "implement", "add", "write", "extend", "refactor", "modify" +
"function | method | class | helper | module"):

1. If the plan document already carries a `**Proven templates**` subsection for
   this Task (written by writing-plans Step 3.5), USE that. Skip the recipe
   re-invocation — the writing-plans output is canonical for this Task.
2. If the plan does NOT carry per-Task templates (older plan, or plan written
   without the Step 3.5 enrichment), invoke `tea-rags:extract-project-patterns`
   with:
   - `pathPatternL1` = deepest common ancestor of the Task's Affected Files
   - `behaviorQuery` = Task title
   - `limit` = 5 Use the returned `templates[0]` and `locality` directly.

Load the chosen template into the session as `tea-rags:data-driven-generation`
Step 2 (TEMPLATE) input — so the Code-Gen Cascade (Step 5) starts from the
correct reference without re-invoking the recipe.

**Skip clause:** non-code Tasks (config, test, doc) bypass this step and proceed
directly to Step 5.
```

- [ ] **Step 3: Bump dinopowers plugin version**

Edit `.claude-plugin/dinopowers/.claude-plugin/plugin.json`. Change:

```json
  "version": "0.17.1",
```

to:

```json
  "version": "0.17.2",
```

Reason: text change to existing skill → patch bump (second of two dinopowers
commits).

- [ ] **Step 4: Verify**

Run:
`grep -n 'Step 4.5' .claude-plugin/dinopowers/skills/executing-plans/SKILL.md`
Expected: one match.

Run:
`grep -n 'extract-project-patterns' .claude-plugin/dinopowers/skills/executing-plans/SKILL.md`
Expected: at least one match.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/dinopowers/skills/executing-plans/SKILL.md \
        .claude-plugin/dinopowers/.claude-plugin/plugin.json
git commit -m "improve(dinopowers): wire extract-project-patterns into executing-plans per Task

Adds Step 4.5 (between Step 4 Gate and Step 5 Code-Gen Cascade) that
either reuses the per-Task Proven templates section written by
writing-plans Step 3.5, or invokes tea-rags:extract-project-patterns
inline if the plan was written without that enrichment.

The chosen template loads as input to the existing Code-Gen Cascade,
keeping Step 5 unchanged.

Skip clause: non-code Tasks (config, test, doc) bypass this step.

Bump dinopowers 0.17.1 → 0.17.2 (text change = patch).

Refs beads tea-rags-mcp-vr7v."
```

---

## Task 6: Beads sync + worktree cleanup

**Files:** None (beads operations only). This Task is FINAL — runs after Tasks
1-5 are committed.

**Why this Task last:** `bd` commands fail inside the worktree (memory:
`project_beads_in_worktrees`). The beads database is reachable from the main
checkout. This Task switches contexts, syncs beads, and reports final state.

- [ ] **Step 1: Exit worktree (do NOT remove — commits stay on branch)**

Invoke `ExitWorktree` with `action: "keep"`. This returns the session to the
main repo checkout. The branch `worktree-ddg-project-wide-templates` remains
intact with all 5 commits from Tasks 1-5.

- [ ] **Step 2: Update epic title**

Run:

```bash
bd update tea-rags-mcp-vr7v --title="extract-project-patterns: agent-only recipe + DDG/writing-plans integration"
```

(Old title was "DDG: project-wide proven templates fallback" — set during
initial brainstorming when scope was narrower.)

- [ ] **Step 3: Create 5 beads tasks under the epic, mark closed**

Per `.claude/rules/.local/plan-beads-sync.md` "For already-completed work":

```bash
# Task 1
bd create --title="Extend ProvenPreset tools[] to include find_similar" \
          --description="Single-line change to src/core/domains/trajectory/git/rerank/presets/proven.ts; test update in tests/.../proven.test.ts. Unblocks rerank='proven' on find_similar for downstream consumers." \
          --type=task --priority=2
# Capture the returned id (e.g. tea-rags-mcp-XXX) and:
bd label add tea-rags-mcp-<id1> api
bd dep add tea-rags-mcp-<id1> tea-rags-mcp-vr7v
bd close tea-rags-mcp-<id1> --reason="completed in branch worktree-ddg-project-wide-templates"

# Task 2
bd create --title="Create tea-rags:extract-project-patterns recipe skill" \
          --description="New agent-only recipe skill encapsulating three-level locality cascade. Bumps tea-rags 0.23.1 → 0.24.0 (new skill = minor)." \
          --type=feature --priority=2
bd label add tea-rags-mcp-<id2> dx
bd dep add tea-rags-mcp-<id2> tea-rags-mcp-vr7v
bd dep add tea-rags-mcp-<id2> tea-rags-mcp-<id1>
bd close tea-rags-mcp-<id2> --reason="completed in branch worktree-ddg-project-wide-templates"

# Task 3
bd create --title="Delegate DDG Step 2 TEMPLATE to extract-project-patterns" \
          --description="Replaces inline custom rerank weights in .claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md with delegated recipe call. Bumps tea-rags 0.24.0 → 0.24.1." \
          --type=task --priority=2
bd label add tea-rags-mcp-<id3> dx
bd dep add tea-rags-mcp-<id3> tea-rags-mcp-vr7v
bd dep add tea-rags-mcp-<id3> tea-rags-mcp-<id2>
bd close tea-rags-mcp-<id3> --reason="completed in branch worktree-ddg-project-wide-templates"

# Task 4
bd create --title="Wire extract-project-patterns into dinopowers:writing-plans" \
          --description="Adds Step 3.5 per-code-gen-Task hook. Bumps dinopowers 0.17.0 → 0.17.1." \
          --type=task --priority=2
bd label add tea-rags-mcp-<id4> dx
bd dep add tea-rags-mcp-<id4> tea-rags-mcp-vr7v
bd dep add tea-rags-mcp-<id4> tea-rags-mcp-<id2>
bd close tea-rags-mcp-<id4> --reason="completed in branch worktree-ddg-project-wide-templates"

# Task 5
bd create --title="Wire extract-project-patterns into dinopowers:executing-plans" \
          --description="Adds Step 4.5 per-Task hook before Code-Gen Cascade. Bumps dinopowers 0.17.1 → 0.17.2." \
          --type=task --priority=2
bd label add tea-rags-mcp-<id5> dx
bd dep add tea-rags-mcp-<id5> tea-rags-mcp-vr7v
bd dep add tea-rags-mcp-<id5> tea-rags-mcp-<id2>
bd close tea-rags-mcp-<id5> --reason="completed in branch worktree-ddg-project-wide-templates"
```

- [ ] **Step 4: Create follow-up beads task for eval fixtures**

The spec defers `evals/cases.json` to a follow-up PR. Track it:

```bash
bd create --title="Add evals/cases.json for extract-project-patterns" \
          --description="6 baseline eval cases per spec Component E: healthy, starved, fragmented, empty project, shallow L1 (≤2 segments), behavior-query-only. Run /optimize-skill extract-project-patterns to reach 100% pass on stable build." \
          --type=task --priority=3
# Capture id (tea-rags-mcp-<idEval>):
bd label add tea-rags-mcp-<idEval> dx
bd dep add tea-rags-mcp-<idEval> tea-rags-mcp-vr7v
bd dep add tea-rags-mcp-<idEval> tea-rags-mcp-<id2>
# Leave OPEN — this is future work.
```

- [ ] **Step 5: Close the parent epic**

```bash
bd close tea-rags-mcp-vr7v --reason="implementation complete in branch worktree-ddg-project-wide-templates; eval fixtures tracked separately as tea-rags-mcp-<idEval>"
```

- [ ] **Step 6: Final verification**

```bash
bd show tea-rags-mcp-vr7v
```

Expected: epic shows status closed, 5 child task ids listed as dependencies.

```bash
git log --oneline worktree-ddg-project-wide-templates ^main | head -10
```

Expected: 5 implementation commits + earlier docs commits visible.

---

## Self-Review

**Spec coverage:**

- ✅ Component A (ProvenPreset.tools[] extension) → Task 1
- ✅ Component B (new extract-project-patterns SKILL.md) → Task 2
- ✅ Component C (DDG Step 2 rewrite) → Task 3
- ✅ Component D (dinopowers wire-ins) → Tasks 4 + 5
- ✅ Component E (eval fixtures) → deferred per spec; tracked as follow-up beads
  task in Task 6 Step 4
- ✅ Plugin version bumps → Tasks 2 (minor), 3 (patch), 4 (patch), 5 (patch)
- ✅ Test coverage for proven.ts → Task 1 (RED/GREEN/REFACTOR)
- ✅ Silo-pairing rule → every plugin commit message includes `Why:` footer per
  `.claude/rules/silo-pairing.md` (all 4 plugin files are deep-silo on Arthur
  Korochansky)
- ✅ Beads 1:1 sync → Task 6

**Placeholder scan:** No "TBD", "TODO", "fill in details" remain. Every step
contains the actual content to apply.

**Type / signature consistency:**

- `tools[]` in Task 1 =
  `["semantic_search", "hybrid_search", "search_code", "find_similar"]` — same
  in test and source.
- `extract-project-patterns` skill name spelled identically in Tasks 2, 3, 4, 5
  SKILL.md content.
- `behaviorQuery` / `positiveIds` / `positiveCode` input names consistent across
  Task 2 (definition) and Tasks 3-5 (usage).
- Plugin versions chained correctly: tea-rags 0.23.1 → 0.24.0 (Task 2) → 0.24.1
  (Task 3); dinopowers 0.17.0 → 0.17.1 (Task 4) → 0.17.2 (Task 5).
- `pathPatternL1` input name matches across Task 2 (skill defines) and Tasks 4-5
  (callers pass).

No gaps identified.

---

## Execution Handoff

Plan complete and saved to
`docs/superpowers/plans/2026-05-18-extract-project-patterns-impl.md`.

User requested "пиши план, реализуй" — execute immediately. Per wrapper routing,
execution proceeds via `dinopowers:executing-plans` (not raw
`superpowers:executing-plans`).
