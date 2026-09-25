---
name: executing-plans
description:
  Execute written implementation plan whose Tasks edit code, per-Task
  SAFE/CAUTION/UNSAFE git-signal verdict before edit AND data-driven cascade for
  code-generation and behavior-modification Tasks (style from silo authors,
  strategy+template from proven neighbors, callers + tests-at-risk on modify).
  Triggers on "execute the plan", "start Task N", "выполни план", "начни
  задачу", "run the plan", "implement the plan steps". NOT for one-off edits
  without a written plan. Wraps superpowers:executing-plans with tea-rags
  git-signal verdicts and tea-rags:data-driven-generation cascade.
---

# dinopowers: executing-plans

Wrapper over `superpowers:executing-plans`. Adds **pre-touch modification
guard** — before each Task's first Edit/Write, queries tea-rags impact signals
for files Task will modify, produces verdict. High-blast-radius / hotspot /
silo-owned files flagged before edits begin, not after broken commit.

## Iron Rule

**For every plan Task that modifies files, the pre-touch guard MUST run BEFORE
the first Edit/Write/MultiEdit of that Task.**

Core value: correct tool (`semantic_search`), correct impact rerank
(`"blastRadius"` when codegraph on, `{imports 0.5, churn 0.3, ownership 0.2}`
fallback when off), correct params (brace-expanded `pathPattern` over Task-local
files, `metaOnly: true`), correct verdict ladder (SAFE / CAUTION / UNSAFE) +
correct gating (CAUTION = confirm, UNSAFE = pause).

Task purely additive (creates new files, touches no existing ones): skip guard
for that Task — state explicitly. Do not invent pathPattern to justify guard
call.

## Mandatory Step Order (DO NOT SKIP)

1. **Step 2.0** — clone freshness precondition, EVERY Task, right before the
   Step 2 guard (worktree multi-task plans only): clone exists (lazy CREATE) +
   incremental reindex. Skip for single-task plans, explore-only, main-checkout
   work.
2. Step 2 — git-signal SAFE/CAUTION/UNSAFE verdict per Task before any edit
3. Step 4 — verdict-gating: STOP and ask user if any UNSAFE
4. **MUST** Step 5 — Code-Gen Cascade for generation AND behavior-modification
   Tasks (invoke `tea-rags:data-driven-generation`)
5. Step 6 — chain into `superpowers:executing-plans`

⚠️ Skipping Step 5 → ungrounded code. Skipping Step 6 → parent workflow never
runs. Skipping Step 2.0 → guard reads stale clone (or `main`) → verdict computed
on code this branch already changed.

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X
redirects superpowers:X. NEVER bypass the wrapper.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) and worktree-clone
lifecycle in `tea-rags/rules/index-freshness.md`. **NO background reindex
hook**: freshness = READ-side precondition (Step 2.0) run before each Task's
first tea-rags call — not post-commit chore remembered after moving on. Run
`mcp__tea-rags__index_codebase` manually to search uncommitted WIP.

Plus cross-plugin chain for code generation:

- `tea-rags:data-driven-generation` — invoked from Step 5 below for any Task
  that GENERATES code (new files, functions, classes, rewrites) or CHANGES
  behavior of existing symbol (MODIFY). Pulls strategy, template, silo-author
  style; on modify, tests-at-risk + callers. Not a `superpowers:Y` redirect —
  additional MANDATORY step wrapper inserts.

## Reading the plan — doc-TOC, not wholesale Read

Plan/spec/brief = doc-chunk source. Per-Task re-consult →
`find_symbol(relativePath: "<plan>.md")` heading TOC → drill active Task section
via `doc:<hash>`. NEVER wholesale re-Read plan mid-execution. Edited plan file →
section hashes moved → incremental reindex (`mcp__tea-rags__index_codebase`)
BEFORE next TOC read — files-edited-this-session staleness rule, stated for
plans.

## Step 1 — Extract Task's file list

From current plan Task identify:

| Source                      | Example                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------- |
| Task explicitly names files | "Task 3: update `a.ts`, `b.ts`"                                                    |
| Task refers to symbols      | "refactor `Class.method()`" → resolve via `mcp__tea-rags__find_symbol` to get file |
| Task refers to a small dir  | "update all files in `language/ruby/chunking/`" → `Glob`                           |

Output:

- `taskFileList`: relative paths Task will modify (typically 1-5)
- `taskIntent`: one sentence what Task does

If `taskFileList` empty (pure new-file creation): skip to Step 4 with verdict
`SAFE (new files only)`.

## Step 2.0 — Clone freshness precondition (worktree multi-task plans, EVERY Task)

Runs immediately BEFORE the Step 2 guard of EVERY Task — read moment is where
staleness bites. Replaces "create at plan start" + "reindex after each commit"
(both got dropped under momentum). Run **explicitly — user sees each command**;
never a hook.

1. **Exists?** From worktree root:

   ```bash
   tea-rags worktree info --json
   ```

   - `isWorktree: true` → clone exists; target = its `alias`
     (`<src-alias>-worktree-<name>`).
   - `isWorktree: false` → lazy CREATE (fires on first Task that needs it):

     ```bash
     tea-rags worktree create <name> --from <src-alias> --path "$PWD" --no-git
     ```

     `<name>` = short worktree label; `--from` = source alias worktree branched
     from; `--no-git` attaches to existing dir. Source index very large → state
     size, confirm before cloning.

   - CREATE refuses `Target collection already exists` → an earlier
     `index_codebase` on this path already SEEDED an ordinary project from a
     sibling working tree (not a clone: `worktree info` answers `false`,
     `worktree remove` refuses it). Do not delete it. Target = `path: "$PWD"`;
     tell user.

2. **Fresh?** Incremental reindex of target — picks up every prior Task's
   commit; no-op when clean:

   ```
   mcp__tea-rags__index_codebase  project: "<src-alias>-worktree-<name>"   (seeded case: path: "$PWD")
   ```

3. **Read it.** Step 2 guard + every tea-rags call of this Task address SAME
   target — clone alias, never main alias.

- **Gate:** only multi-task plan in worktree. Single-task plans, explore-only
  sessions, main-checkout work → main collection directly: no clone, no Step
  2.0.
- **Subagent-driven:** PARENT runs Step 2.0 before dispatching each Task;
  subagent does not reindex, inherits clone via worktree path.
- Teardown: `dinopowers:finishing-a-development-branch`.

## Step 2 — Pre-touch guard call

Issue ONE `mcp__tea-rags__semantic_search` call — SAME idiom as
`dinopowers:writing-plans` Step 2:

```
project:     <alias from list_projects — RECOMMENDED, omit path when set;
              worktree plan → Step 2.0 target (clone alias)>
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
approximate) when that line absent.

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
- Wrong rerank for codegraph state — `"blastRadius"` when on, the
  `{imports 0.5, churn 0.3, ownership 0.2}` fallback when off, matching
  `dinopowers:writing-plans` and `tea-rags:data-driven-generation` IMPACT step
  for cross-skill comparability
- `filter` narrowing file set — `pathPattern` already scopes; filters hide
  signal

Results empty (files brand-new, not yet in git): verdict defaults to
`SAFE (new files)`. Do NOT fabricate blast-radius signals for untracked files.

## Step 3 — Compute verdict per file, aggregate to Task verdict

For each unique `relativePath` in results, read labels from
`rankingOverlay.file.*` (`{value,label}`; kept under metaOnly), raw values from
`payload.git.file.*` (essential fields only under metaOnly):

- `commitCount` — churn magnitude
- `bugFixRate` — historical quality (percent of commits tagged as fix/bug);
  overlay only under metaOnly (non-essential)
- `blameDominantAuthorPct` (with adaptive label `shared` / `concentrated` /
  `silo` / `deep-silo`) — live-line silo indicator
- `imports` score (from ranking overlay) — blast radius proxy

Compute per-file verdict via this ladder. Use **adaptive labels**, not magic
percentages — labels come from per-codebase percentile distributions in payload
signal `stats.labels`, surfaced through `get_index_metrics`.

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

Never silently convert UNSAFE→CAUTION or CAUTION→SAFE to "keep momentum".
Verdict is circuit breaker.

**Chaining rule reminder:** when `superpowers:executing-plans` runs a Task, it
may chain into `superpowers:test-driven-development`,
`superpowers:verification-before-completion`,
`superpowers:requesting-code-review` or
`superpowers:finishing-a-development-branch`. Redirect each to corresponding
`dinopowers:Y` wrapper — see Chaining rule section above.

## Step 4.5 — Per-Task proven-template lookup (code-generation Tasks)

For Task about to execute, if classified as code-generation (same heuristic as
`dinopowers:writing-plans` Step 3.5: keywords "implement", "add", "write",
"extend" + "function | method | class | helper | module") — i.e. Step 5 row
**Generation** (DDG mode CREATE / EXTEND). **Modification** Tasks skip 4.5: DDG
MODIFY mode skips TEMPLATE — symbol itself is the reference.

1. Plan document already carries `**Proven templates**` subsection for this Task
   (written by writing-plans Step 3.5) → USE that. Skip recipe re-invocation —
   writing-plans output canonical for this Task.
2. Plan does NOT carry per-Task templates (older plan, or written without Step
   3.5 enrichment) → invoke `tea-rags:extract-project-patterns` with:
   - `pathPatternL1` = deepest common ancestor of Task's Affected Files
   - `behaviorQuery` = Task title
   - `limit` = 5 Use returned `templates[0]` and `locality` directly.

Load chosen template into session as `tea-rags:data-driven-generation` Step 2
(TEMPLATE) input — so Code-Gen Cascade (Step 5) starts from correct reference
without re-invoking recipe.

**Skip clause:** non-code Tasks (config, test, doc) bypass this step, proceed
directly to Step 5.

## Step 5 — Code-Gen Cascade (MANDATORY for generation + modification Tasks)

After verdict gate clears (SAFE proceeds, CAUTION confirmed, UNSAFE overridden),
classify Task by intent BEFORE invoking `superpowers:executing-plans`. DDG picks
its own mode (CREATE / EXTEND / MODIFY) via `find_symbol` probe — wrapper only
decides WHETHER to invoke.

| Task intent                                                                                                  | Action                                                                                           |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **Generation**: new file, new function, new class, new method on existing class, rewrite-to-new-template     | **MUST** invoke `Skill(tea-rags:data-driven-generation)` BEFORE any Edit/Write (CREATE / EXTEND) |
| **Modification**: change behavior of EXISTING symbol in place (bug fix, condition tweak, new branch, hotfix) | **MUST** invoke `Skill(tea-rags:data-driven-generation)` BEFORE any Edit/Write (MODIFY)          |
| **Refactor only**: rename, move, extract, inline, reformat — no behavior change                              | Skip Step 5 — DDG out of scope for pure refactor                                                 |
| **Deletion**: remove file, remove function, prune dead code                                                  | Skip Step 5 — no generation                                                                      |
| **Trivial**: typo, comment / log-message text, single-token swap, no behavior change                         | Skip Step 5 AND skip wrapper entirely — direct Edit                                              |

Why MANDATORY for modification — DDG MODIFY mode owns what in-context edit
misses:

- **Tests-at-risk** — `tea-rags:tests-as-context` recipe finds tests pinning
  current behavior → run them; unpinned behavior noted.
- **`get_callers` on modified symbol** — changed behavior propagates through
  real call edges; callers relying on old contract surface BEFORE commit.
- **Symbol-own style + strategy** — minimal diff matched to symbol itself,
  strategy from its own labels (DEFENSIVE on `bugFixRate` critical). Hotfix
  (exact location given) = MODIFY minus STRATEGY/STYLE — DDG decides, not
  wrapper.
- **REUSE for introduced logic** — new branch/guard reuses existing helper
  instead of N-th reimplementation.

Why MANDATORY for generation: without `tea-rags:data-driven-generation` agent
generates code disconnected from project conventions. Misses:

- **Strategy selection** — DEFENSIVE for buggy zones, STABILIZATION for
  high-churn, CONSERVATIVE for legacy, STANDARD elsewhere. Reading SKILL.md text
  alone won't trigger this — only data-driven skill encodes the
  label-to-strategy ladder.
- **Template via "proven" rerank** — battle-tested code (long-lived, low-churn,
  low-bug, multi-author) found via custom weights
  `{similarity 0.2, stability 0.3, age 0.3, bugFix -0.15, ownership -0.05}`.
  Manual `Read` of one sibling file picks arbitrary example, not proven one.
- **Silo-author style copy** — when
  `blameDominantAuthorPct.label === "deep-silo"` data-driven skill instructs
  exact pattern match AND flags live-line owner for review. Manual style copy
  via Read skips silo signal entirely.

How to invoke (one Skill call, no parameters needed — skill reads area context
from this conversation):

```
Skill(tea-rags:data-driven-generation)
```

If `tea-rags:data-driven-generation` reports it lacks area context (no overlay
labels in conversation), it internally chains to `tea-rags:explore` for
pre-generation gathering. Let it. Do NOT pre-fetch labels yourself — skill owns
that workflow.

After Step 5 returns (strategy + template + style decided), THEN invoke
`Skill(superpowers:executing-plans)` (or its TDD onward chain via
`Skill(dinopowers:test-driven-development)`) to write the code.

**Order matters:** freshness (Step 2.0) → guard (Step 2) → verdict gate (Step 4)
→ data-driven cascade (Step 5) → executing-plans chain. Skipping Step 5 for
generation or modification Task = same severity as skipping guard for
existing-file Task.

## Red Flags — STOP and restart from Step 2

- "This Task is small, skip the guard" → if `taskFileList` has ≥1 existing file,
  run Step 2
- Substituted `mcp__tree-sitter__modification_guard` → tree-sitter gives
  structural safety, not git-signal blast radius; both useful but this wrapper
  git-first. Run Step 2.
- Named preset instead of custom weights → redo with
  `{imports: 0.5, churn: 0.3, ownership: 0.2}`
- Ran guard AFTER first Edit → wrong order; revert uncommitted changes if
  possible, restart from Step 2 before next Edit
- Silent downgrade of verdict → surface true verdict; let user downgrade if they
  want
- `metaOnly: false` on guard call → restart with `metaOnly: true`
- Let `superpowers:executing-plans` chain into raw
  `superpowers:test-driven-development` /
  `superpowers:verification-before-completion` /
  `superpowers:requesting-code-review` /
  `superpowers:finishing-a-development-branch` without redirecting to
  `dinopowers:Y` wrapper → intercept, invoke wrapper instead (see Chaining rule)
- Generation Task ran straight to `Read sibling.ts` + `Write new.ts` without
  invoking `Skill(tea-rags:data-driven-generation)` → revert (or pause before
  Edit), restart from Step 5. Manual sibling-Read is exactly what data-driven
  skill replaces with structured strategy + proven template + silo style.
- Invoked `tea-rags:data-driven-generation` for pure refactor (rename, move,
  extract) → over-trigger; adds no value when behavior unchanged. Restart from
  Step 5 classification; refactor row says SKIP.
- Bug fix / condition tweak in existing method edited in-context, "no new
  pattern, DDG not needed" → wrong: Modification row. Pause before Edit, invoke
  DDG (MODIFY: tests-at-risk + `get_callers`).
- Worktree plan, Task N guard issued without Step 2.0 this Task ("clone made at
  start", "reindexed last commit", "nothing changed") → run Step 2.0 now; it is
  per Task, before the guard, unconditional.
- Guard addressed main alias inside worktree plan → redo against clone alias.

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
| Modification Task → guard SAFE → edit in-context                      | SAFE says file is safe to touch, not that callers survive new behavior. DDG MODIFY runs tests-at-risk + `get_callers` — Step 5 still applies.            |
| Reindex clone "after commit" as cleanup of finished Task              | Write-side chore → dropped under momentum. Freshness is Step 2.0 of NEXT Task, run right before its guard.                                               |
