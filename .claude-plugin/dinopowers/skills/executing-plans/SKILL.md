---
name: executing-plans
description:
  Execute a written implementation plan whose Tasks edit code, with a per-Task
  SAFE/CAUTION/UNSAFE git-signal verdict before any edit AND a code-style
  cascade for code-generation Tasks (style from silo authors, strategy and
  template from proven neighbors). Triggers on "execute the plan", "start Task
  N", "выполни план", "начни задачу", "run the plan", "implement the plan
  steps". NOT for one-off edits without a written plan. Wraps
  superpowers:executing-plans with tea-rags git-signal verdicts and
  tea-rags:data-driven-generation cascade.
---

# dinopowers: executing-plans

Wrapper over `superpowers:executing-plans`. Adds a **pre-touch modification
guard** — before each Task's first Edit/Write, queries tea-rags impact signals
for the files the Task will modify and produces a verdict. High-blast-radius /
hotspot / silo-owned files get flagged before edits begin, not after a broken
commit.

## Iron Rule

**For every plan Task that modifies files, the pre-touch guard MUST run BEFORE
the first Edit/Write/MultiEdit of that Task.**

Correct tool (`semantic_search`), correct impact rerank (`"blastRadius"` when
codegraph is on, the `{imports 0.5, churn 0.3, ownership 0.2}` fallback when
off), correct parameters (brace-expanded `pathPattern` over Task-local files,
`metaOnly: true`), correct verdict ladder (SAFE / CAUTION / UNSAFE) + correct
gating (CAUTION = confirm, UNSAFE = pause) is the core value.

If a Task is purely additive (creates new files, touches no existing ones): skip
the guard for that Task — state it explicitly. Do not invent a pathPattern to
justify a guard call.

## Mandatory Step Order (DO NOT SKIP)

1. Step 2 — git-signal SAFE/CAUTION/UNSAFE verdict per Task before any edit
2. Step 4 — verdict-gating: STOP and ask user if any UNSAFE
3. **MUST** Step 5 — Code-Gen Cascade for code-generation Tasks (invoke
   `tea-rags:data-driven-generation`)
4. Step 6 — chain into `superpowers:executing-plans`

⚠️ Skipping Step 5 produces ungrounded code. Skipping Step 6 means the parent
workflow never runs.

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X
redirects superpowers:X. NEVER bypass the wrapper.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) — a post-commit hook
auto-reindexes after commits/merges; run `mcp__tea-rags__index_codebase`
manually only to search code edited but not yet committed, BEFORE the first
tea-rags call.

Plus the cross-plugin chain for code generation:

- `tea-rags:data-driven-generation` — invoked from Step 5 below for any Task
  that GENERATES code (new files, new functions, new classes, rewrites). Pulls
  strategy, template, and silo-author style. Not a `superpowers:Y` redirect —
  it's an additional MANDATORY step the wrapper inserts.

## Step 1 — Extract Task's file list

From the current plan Task identify:

| Source                      | Example                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Task explicitly names files | "Task 3: update `a.ts`, `b.ts`"                                                    |
| Task refers to symbols      | "refactor `Class.method()`" → resolve via `mcp__tea-rags__find_symbol` to get file |
| Task refers to a small dir  | "update all files in `chunker/hooks/ruby/`" → `Glob`                               |

Output:

- `taskFileList`: relative paths the Task will modify (typically 1-5)
- `taskIntent`: one-sentence of what the Task does

If `taskFileList` is empty (pure new-file creation): skip to Step 4 with verdict
`SAFE (new files only)`.

## Step 2 — Pre-touch guard call

Issue ONE `mcp__tea-rags__semantic_search` call — SAME idiom as
`dinopowers:writing-plans` Step 2:

```
project:     <alias from list_projects — RECOMMENDED, omit path when set>
path:        <current project path — fallback when no alias is registered>
query:       <taskIntent from Step 1>
pathPattern: "{taskFile1,taskFile2,...}"   ← brace expansion
rerank:      "blastRadius"               ← codegraph on; OFF fallback below
limit:       <taskFileList.length * 3>
metaOnly:    true
```

**Codegraph gating for `rerank`:** `"blastRadius"` (real `fanIn` + churn +
bugFix) when prime `## Enrichment` lists `codegraph.symbols`; fall back to
`{ custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }` (import-proxy,
approximate) when that line is absent.

Do NOT substitute:

| Wrong tool                                                      | Why wrong                                                                                                               |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `mcp__tree-sitter__modification_guard`                          | Structural (AST) guard, misses git-signal blast radius (imports count, bugFixRate, ownership)                           |
| `mcp__tea-rags__hybrid_search`                                  | Custom rerank is tied to `semantic_search`                                                                              |
| Named preset `"hotspots"` / `"codeReview"` / `"impactAnalysis"` | `impactAnalysis` does not exist; these miss the blast-radius dimension. `"blastRadius"` IS correct when codegraph is on |
| One call per file, sequential                                   | Brace expansion covers all in one                                                                                       |
| `mcp__tea-rags__find_similar` without a prior guard call        | Finds analogs, doesn't return blast-radius signals                                                                      |

Do NOT pass:

- `metaOnly: false` — we want verdict inputs, not content
- The wrong rerank for the codegraph state — `"blastRadius"` when on, the
  `{imports 0.5, churn 0.3, ownership 0.2}` fallback when off, matching
  `dinopowers:writing-plans` and `tea-rags:data-driven-generation` Step 6 for
  cross-skill comparability
- `filter` narrowing the file set — the `pathPattern` already scopes; filters
  hide signal

If results are empty (files are brand-new, not yet in git): verdict defaults to
`SAFE (new files)`. Do NOT fabricate blast-radius signals for untracked files.

## Step 3 — Compute verdict per file, aggregate to Task verdict

For each unique `relativePath` in results, extract from `payload.git.file.*`:

- `commitCount` — churn magnitude
- `bugFixRate` — historical quality (percent of commits tagged as fix/bug)
- `blameDominantAuthorPct` (with adaptive label `shared` / `concentrated` /
  `silo` / `deep-silo`) — live-line silo indicator
- `imports` score (from ranking overlay) — blast radius proxy

Compute per-file verdict via this ladder. Use **adaptive labels**, not magic
percentages — labels come from per-codebase percentile distributions returned in
the payload signal `stats.labels` and surfaced through `get_index_metrics`.

| Verdict   | Any of these triggers                                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UNSAFE`  | `imports` score top 5% of result set AND `bugFixRate.label ∈ {"concerning", "critical"}`; OR `blameDominantAuthorPct.label === "deep-silo"` (one author owns the live code) |
| `CAUTION` | `imports` top 15%; OR `bugFixRate.label === "concerning"`; OR `blameDominantAuthorPct.label === "silo"`                                                                     |
| `SAFE`    | none of the above                                                                                                                                                           |

Task verdict = worst of per-file verdicts (UNSAFE dominates CAUTION dominates
SAFE).

Compose guard block:

```
### dinopowers guard — Task N ("<taskIntent>")

| File | imports | churn | bugFix | owner | Verdict |
|---|---|---|---|---|---|
| src/a.ts | 47 imports | 23 commits | 35% | Alice (92%) | CAUTION |
| src/b.ts | 3 imports  | 5 commits  | 0%  | shared (42%) | SAFE |

**Task verdict: CAUTION** — high-blast-radius in `src/a.ts`. Owner Alice has 92% dominance.
```

## Step 4 — Gate the Task execution

Branch on Task verdict BEFORE invoking `superpowers:executing-plans` for this
Task:

| Verdict   | Action                                                                                                                                                                                                                        |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAFE`    | Proceed — invoke `superpowers:executing-plans` for this Task without interruption                                                                                                                                             |
| `CAUTION` | Surface the guard block to the user. Ask "Proceed with Task N?". Wait for explicit confirmation before invoking `superpowers:executing-plans`.                                                                                |
| `UNSAFE`  | Pause — surface block + recommend one of: (a) split Task into smaller Tasks, (b) add owner as co-author/reviewer, (c) require tests-before-edit. Do NOT invoke `superpowers:executing-plans` until user explicitly overrides. |

Never silently convert UNSAFE→CAUTION or CAUTION→SAFE to "keep momentum". The
verdict is a circuit breaker.

**Chaining rule reminder:** when `superpowers:executing-plans` runs a Task, it
may chain into `superpowers:test-driven-development`,
`superpowers:verification-before-completion`,
`superpowers:requesting-code-review` or
`superpowers:finishing-a-development-branch`. Redirect each to the corresponding
`dinopowers:Y` wrapper — see the Chaining rule section above.

## Step 4.5 — Per-Task proven-template lookup (code-generation Tasks)

For the Task you are about to execute, if it is classified as code-generation /
code-modification (per the same heuristic as `dinopowers:writing-plans` Step
3.5: keywords "implement", "add", "write", "extend", "refactor", "modify"

- "function | method | class | helper | module"):

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

## Step 5 — Code-Gen Cascade (MANDATORY for code-generation Tasks)

After verdict gate clears (SAFE proceeds, CAUTION confirmed, UNSAFE overridden),
classify the Task by intent BEFORE invoking `superpowers:executing-plans`.

| Task intent                                                                                              | Action                                                                         |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **Generation**: new file, new function, new class, new method on existing class, rewrite-to-new-template | **MUST** invoke `Skill(tea-rags:data-driven-generation)` BEFORE any Edit/Write |
| **Refactor only**: rename, move, extract, inline, reformat — no new logic                                | Skip Step 5 — no template/style needed                                         |
| **Modification only**: change behavior in-place (bug fix, condition tweak, log message)                  | Skip Step 5 — agent edits in-context, no new pattern                           |
| **Deletion**: remove file, remove function, prune dead code                                              | Skip Step 5 — no generation                                                    |
| **Trivial**: typo, comment update, single-token swap                                                     | Skip Step 5 AND skip wrapper entirely — direct Edit                            |

Why MANDATORY for generation: without `tea-rags:data-driven-generation` the
agent generates code disconnected from project conventions. It misses:

- **Strategy selection** — DEFENSIVE for buggy zones, STABILIZATION for
  high-churn, CONSERVATIVE for legacy, STANDARD elsewhere. Reading SKILL.md text
  alone won't trigger this — only the data-driven skill encodes the
  label-to-strategy ladder.
- **Template via "proven" rerank** — battle-tested code (long-lived, low-churn,
  low-bug, multi-author) found via custom weights
  `{similarity 0.2, stability 0.3, age 0.3, bugFix -0.15, ownership -0.05}`.
  Manual `Read` of one sibling file picks an arbitrary example, not a proven
  one.
- **Silo-author style copy** — when
  `blameDominantAuthorPct.label === "deep-silo"` the data-driven skill instructs
  exact pattern match AND flags the live-line owner for review. Manual style
  copy via Read skips the silo signal entirely.

How to invoke (one Skill call, no parameters needed — the skill reads area
context from this conversation):

```
Skill(tea-rags:data-driven-generation)
```

If `tea-rags:data-driven-generation` reports it lacks area context (no overlay
labels in conversation), it will internally chain to `tea-rags:explore` for
pre-generation gathering. Let it. Do NOT pre-fetch labels yourself — the skill
owns that workflow.

After Step 5 returns (strategy + template + style decided), THEN invoke
`Skill(superpowers:executing-plans)` (or its TDD onward chain via
`Skill(dinopowers:test-driven-development)`) to actually write the code.

**Order matters:** guard (Step 2) → verdict gate (Step 4) → data-driven cascade
(Step 5) → executing-plans chain. Skipping Step 5 for a generation Task is the
same severity as skipping the guard for an existing-file Task.

## Red Flags — STOP and restart from Step 2

- "This Task is small, skip the guard" → if `taskFileList` has ≥1 existing file,
  run Step 2
- Substituted `mcp__tree-sitter__modification_guard` → tree-sitter gives
  structural safety, not git-signal blast radius; both are useful but this
  wrapper is git-first. Run Step 2.
- Named preset instead of custom weights → redo with
  `{imports: 0.5, churn: 0.3, ownership: 0.2}`
- Ran guard AFTER the first Edit → wrong order; revert uncommitted changes if
  possible, restart from Step 2 before next Edit
- Silent downgrade of verdict → surface the true verdict; let user downgrade if
  they want
- `metaOnly: false` on guard call → restart with `metaOnly: true`
- Let `superpowers:executing-plans` chain into a raw
  `superpowers:test-driven-development` /
  `superpowers:verification-before-completion` /
  `superpowers:requesting-code-review` /
  `superpowers:finishing-a-development-branch` without redirecting to the
  `dinopowers:Y` wrapper → intercept and invoke the wrapper instead (see
  Chaining rule)
- Generation Task ran straight to `Read sibling.ts` + `Write new.ts` without
  invoking `Skill(tea-rags:data-driven-generation)` → revert (or pause before
  Edit), restart from Step 5. Manual sibling-Read is exactly what the
  data-driven skill replaces with structured strategy + proven template + silo
  style.
- Invoked `tea-rags:data-driven-generation` for a pure refactor (rename, move,
  extract) → over-trigger; it adds no value when no new code is being written.
  Restart from Step 5 classification; refactor row says SKIP.

## Common Mistakes

| Mistake                                                               | Reality                                                                                                                                                  |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One guard call per plan (not per Task)                                | `dinopowers:writing-plans` does per-plan. This wrapper is per-Task — scope matches edit granularity.                                                     |
| Use `rerank: "codeReview"` because "review before edit" sounds right  | `codeReview` lacks `imports` weight — blast-radius invisible                                                                                             |
| Emit the guard block and proceed without gating                       | The block is not documentation — it's a circuit breaker. CAUTION waits for confirmation.                                                                 |
| Treat UNSAFE as "just a warning"                                      | UNSAFE pauses. User must explicitly override before edits.                                                                                               |
| Pre-fetch ALL plan files in one guard at plan start                   | Context stale by the time Task 5 runs. Guard is per-Task, just-in-time.                                                                                  |
| Invoke `superpowers:executing-plans` for the whole plan at once       | Wrapper is per-Task — gate each Task separately                                                                                                          |
| For new-file Task: `Read sibling.ts` then `Write new.ts` directly     | Skips Step 5. Sibling-by-Read picks arbitrary example, ignores `bugFixRate`/`blameDominantAuthor` signals. Use `Skill(tea-rags:data-driven-generation)`. |
| Generation Task → guard SAFE (new file) → straight to executing-plans | SAFE (new file) only resolves blast-radius gate. Step 5 is a SEPARATE gate — strategy + template + style still needed. Both gates must clear.            |
