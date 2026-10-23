---
name: dino-executing-plans
description:
  'Execute written implementation plan or tracker issue whose Tasks edit code,
  per-Task SAFE/CAUTION/UNSAFE git-signal verdict before edit AND data-driven
  cascade for code-generation and behavior-modification Tasks (strategy+template
  from proven neighbors, callers + tests-at-risk on modify). Triggers on
  "execute the plan", "start Task N", "выполни план", "начни задачу", "run the
  plan", "implement the plan steps". NOT for one-off edits without a written
  plan. Wraps /executing-plans with tea-rags git-signal verdicts and
  /data-driven-generation cascade.'
---

# dinopowers: executing-plans

> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no
> resource tool, or the read fails), run
> `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.

Wrapper over `/executing-plans`. Adds **pre-touch modification guard** — before
each Task's first Edit/Write, tea-rags impact signals for Task's files →
verdict. High-blast-radius / hotspot / silo files flagged before edits, not
after broken commit.

## Iron Rule

**Every plan Task that modifies files: pre-touch guard MUST run BEFORE that
Task's first Edit/Write/MultiEdit.**

Value = right tool (`semantic_search`) + impact rerank (`"blastRadius"`
codegraph on, `{imports 0.5, churn 0.3, ownership 0.2}` fallback off) + params
(brace-expanded `pathPattern` over Task-local files, `metaOnly: true`) + verdict
ladder (SAFE / CAUTION / UNSAFE) + gating (CAUTION = confirm, UNSAFE = pause).

Purely additive Task (new files only) → skip guard, say so ("guard SAFE — new
file"). Never invent pathPattern to justify guard.

**Plan = any written Task source**: plan file, OR tracker issue handed to an
autonomous task-agent ("Execute beads issue X: write Y in path Z"). Issue = one
Task → full step order below: guard → Step 5 DDG cascade (MUST for new code,
esp. "match shape of A/B") → `/dino-test-driven-development` for its tests →
chain. Never Read neighbours and copy by hand.

## Mandatory Step Order (DO NOT SKIP)

1. **Step 2.0** — addressing, EVERY Task: every tea-rags read passes
   `project=<alias>` + `path=<your working directory>`. No clone, no reindex for
   tree's own edits.
2. Step 2 — SAFE/CAUTION/UNSAFE verdict per Task before any edit
3. Step 4 — verdict gate: STOP and ask user on UNSAFE
4. **MUST** Step 5 — Code-Gen Cascade for generation AND behavior-modification
   Tasks (`/data-driven-generation`)
5. Step 6 — chain into `/executing-plans`

⚠️ Skip Step 5 → ungrounded code. Skip Step 6 → parent workflow never runs. Skip
Step 2.0 → guard reads `main`'s tree → verdict on code branch already changed.

**Chaining rule:** [CHAINING.md](../../CHAINING.md) — every onward `/Y` →
`/dino-Y`. NEVER bypass wrapper. Plus cross-plugin `/data-driven-generation`
(Step 5) — not a redirect, an extra MANDATORY step for Tasks that GENERATE code
or CHANGE behavior (MODIFY).

**Requires superpowers:** `/executing-plans` unavailable → stop, ask the user to
install superpowers (https://github.com/obra/superpowers; steps in
[CHAINING.md](../../CHAINING.md)). NEVER run this enrichment alone and present
it as the full workflow.

**Freshness:** [FRESHNESS.md](../../FRESHNESS.md) (owner
`tea-rags://guide/freshness`). Lag ≠ unusable — never Bash `cat`/`grep`/`Read`
over code; `treeState` row → `find_symbol`.

## Reading the plan — doc-TOC, not wholesale Read

Plan/spec = doc chunks. Per-Task re-consult →
`find_symbol(relativePath: "<plan>.md")` heading TOC → drill active Task via
`doc:<hash>`. NEVER re-Read whole plan mid-execution. Plan file edited → hashes
moved → main checkout: incremental `index_codebase` BEFORE next TOC read; linked
worktree: none (`find_symbol` reads tree).

## Step 1 — Extract Task's file list

| Source                      | Example                                                                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task explicitly names files | "Task 3: update `a.ts`, `b.ts`"                                                                                                                     |
| Task refers to symbols      | "refactor `Class.method()`" → resolve via `find_symbol` to get file                                                                                 |
| Task refers to a small dir  | "update all files in `language/ruby/chunking/`" → `semantic_search` `pathPattern: "<dir>/**"`, `level: "file"`, `metaOnly: true` (one row per file) |

Output: `taskFileList` (paths Task modifies, typically 1-5) + `taskIntent` (one
sentence). Empty (pure new-file creation) → Step 4, verdict
`SAFE (new files only)`.

## Step 2.0 — Addressing (EVERY Task)

1. **Address the tree.** Step 2 guard + every tea-rags read of this Task (and
   every skill it invokes) pass `project=<alias>` +
   `path=<your working directory>` (`tea-rags://guide/freshness` "Addressing the
   Codebase"). Linked worktree → own tree vs repo index, any delta; no clone, no
   reindex for tree's own edits.
2. **Read `workingTree` marker.** `pendingFiles` → rows = index's, re-call for
   current code. `indexOnlyFiles` → non-code rows = index's. Neither triggers
   reindex. `degraded` → its `remedy` under `tea-rags://guide/freshness`
   consent.

- **Subagent-driven:** subagent never reindexes, passes
  `path=<its working directory>`.
- Teardown of existing clone: `/dino-finishing-a-development-branch`.

## Step 2 — Pre-touch guard call

ONE `semantic_search` — same idiom as `/dino-writing-plans` Step 2:

```
project:     <alias>                    ← `tea-rags://guide/freshness` "Addressing the Codebase"
path:        <your working directory>   ← the tree (worktree / branch checkout)
query:       <taskIntent from Step 1>
pathPattern: "{taskFile1,taskFile2,...}"   ← brace expansion
rerank:      "blastRadius"               ← codegraph on; OFF fallback below
limit:       <taskFileList.length * 3>
metaOnly:    true
```

**Codegraph gating for `rerank`:** `"blastRadius"` (real `fanIn` + churn +
bugFix) when codegraph on = graph tools (`get_callers`, `trace_path`, …) in tool
list (unsure → read `tea-rags://project/<alias>/metrics?section=registry`,
`codegraph on|off`); off →
`{ custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }` (import-proxy,
approximate).

Do NOT substitute:

| Wrong tool                                                      | Why wrong                                                                                                               |
| --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `mcp__tree-sitter__modification_guard`                          | Structural (AST) guard, misses git-signal blast radius (imports count, bugFixRate, ownership)                           |
| `hybrid_search`                                                 | Same rerank, but its BM25 leg re-ranks by query-token overlap — signal scan wants semantic + signals                    |
| Named preset `"hotspots"` / `"codeReview"` / `"impactAnalysis"` | `impactAnalysis` does not exist; these miss the blast-radius dimension. `"blastRadius"` IS correct when codegraph is on |
| One call per file, sequential                                   | Brace expansion covers all in one                                                                                       |
| `find_similar` without a prior guard call                       | Finds analogs, doesn't return blast-radius signals                                                                      |

Do NOT pass:

- `metaOnly: false` — verdict inputs, not content. User wants the code too →
  separate call AFTER the verdict: `find_symbol(relativePath:)` outline, then
  member bodies; never flip the guard
- wrong rerank for codegraph state — must match `/dino-writing-plans` +
  `/data-driven-generation` IMPACT step (cross-skill comparability)
- `filter` narrowing — `pathPattern` scopes; filters hide signal

Empty (brand-new, untracked) → `SAFE (new files)`. Never fabricate blast-radius
for untracked files.

## Step 3 — Compute verdict per file, aggregate to Task verdict

Per unique `relativePath`: labels from `rankingOverlay.file.*` (`{value,label}`;
table columns `rankingOverlay.file.<signal>.value` / `.label`; kept under
metaOnly), raw from `payload.git.file.*` (essentials only under metaOnly):

- `commitCount` — churn magnitude
- `bugFixRate` — % fix/bug commits; overlay only under metaOnly
- `blameDominantAuthorPct` (label `shared` / `concentrated` / `silo` /
  `deep-silo`) — live-line silo indicator
- blast radius — `codegraph.file.fanIn` (blastRadius, codegraph on) or `imports`
  (custom fallback)

Ladder uses **adaptive labels**, never magic percentages — labels = per-codebase
percentiles. Need boundaries → read
`tea-rags://project/<alias>/metrics?section=labelMap&language=<lang>`.

| Verdict   | Any of these triggers                                                                                                                                                                      |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `UNSAFE`  | blast radius (fanIn / imports) top 5% of result set AND `bugFixRate.label ∈ {"concerning", "critical"}`; OR `blameDominantAuthorPct.label === "deep-silo"` (one author owns the live code) |
| `CAUTION` | blast radius (fanIn / imports) top 15%; OR `bugFixRate.label === "concerning"`; OR `blameDominantAuthorPct.label === "silo"`                                                               |
| `SAFE`    | none of the above                                                                                                                                                                          |

**Signals given as numbers** (prompt / user states the guard result:
`imports=40 (top 12%)`, `bugFixRate=32%`, `shared (42%)`) = Step 2 output.
Compute the verdict on them NOW — never defer to "the full guard result", never
re-run. Stated rank (`top 12%`) feeds the blast row directly; stated label words
(`shared`, `silo`, `concerning`) are labels; ONE trigger suffices — missing
signals never block it. No trigger stated (low imports, 0% bugFix, `shared`) →
SAFE, proceed without pausing; commit count alone never triggers. Example: top
12% → CAUTION + "Proceed with Task 2?"; imports=2, 0%, shared → SAFE. UNSAFE
blast row = conjunction — verdict line names BOTH halves:
`imports top 2% AND bugFixRate concerning → UNSAFE`; blast top 5% alone =
CAUTION. A bare percent (`bugFixRate=45%`, no label) → its label from
`tea-rags://project/<alias>/metrics?section=labelMap` (`concerning` ≥ p75,
`critical` ≥ p95) BEFORE the verdict; never a fixed cut like 40%.

Task verdict = worst per-file (UNSAFE > CAUTION > SAFE). Guard block:

```
### dinopowers guard — Task N ("<taskIntent>")

| File | imports | churn | bugFix | owner | Verdict |
|---|---|---|---|---|---|
| src/a.ts | 47 imports | 23 commits | 35% | Alice (92%) | CAUTION |
| src/b.ts | 3 imports  | 5 commits  | 0%  | shared (42%) | SAFE |

**Task verdict: CAUTION** — high-blast-radius in `src/a.ts`. Owner Alice has 92% dominance.
```

## Step 4 — Gate the Task execution

Branch on Task verdict BEFORE invoking `/executing-plans`:

| Verdict   | Action                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SAFE`    | Proceed without interruption — Step 4.5 / Step 5 (code-gen, modify Tasks), then `/executing-plans`                                                                                                                 |
| `CAUTION` | Surface the guard block to the user. Ask "Proceed with Task N?". Wait for explicit confirmation before invoking `/executing-plans`.                                                                                |
| `UNSAFE`  | Pause — surface block + recommend one of: (a) split Task into smaller Tasks, (b) add owner as co-author/reviewer, (c) require tests-before-edit. Do NOT invoke `/executing-plans` until user explicitly overrides. |

Guard block = circuit breaker, not documentation. NEVER silently downgrade
(UNSAFE→CAUTION, CAUTION→SAFE) "to keep momentum"; surface true verdict, user
may downgrade.

**Pre-emptive "skip it" is NOT an override.** Deadline / "no time" / "пропусти
UNSAFE" said before or alongside the verdict → still surface the block +
recommendations and wait. Say: "Guard is UNSAFE for Task N — <signals>. Options:
(a)/(b)/(c). Reply 'override Task N' to proceed anyway." Explicit override =
user reply AFTER seeing the block, naming the Task.

**Chaining reminder:** Task run may chain into `/test-driven-development`,
`/verification-before-completion`, `/requesting-code-review`,
`/finishing-a-development-branch` → redirect each to `/dino-Y`.

## Step 4.5 — Per-Task proven-template lookup (code-generation Tasks)

Code-generation Task (heuristic = `/dino-writing-plans` Step 3.5: "implement" /
"add" / "write" / "extend" + "function | method | class | helper | module") =
Step 5 **Generation** row (DDG CREATE / EXTEND). **Modification** Tasks skip 4.5
— DDG MODIFY skips TEMPLATE (symbol itself = reference). Non-code Tasks (config,
test, doc) → straight to Step 5.

1. Plan carries `**Proven templates**` for this Task (writing-plans Step 3.5) →
   USE it, no recipe re-invocation (plan canonical).
2. No per-Task templates (older plan) → `/extract-project-patterns`:
   - `pathPatternL1` = deepest common ancestor of Task's Affected Files
   - `behaviorQuery` = Task title
   - `limit` = 5

   Use returned `templates[0]` + `locality` directly.

Chosen template → `/data-driven-generation` Step 2 (TEMPLATE) input, so Step 5
starts from right reference without re-invoking recipe.

## Step 5 — Code-Gen Cascade (MANDATORY for generation + modification Tasks)

Gate cleared (SAFE / CAUTION confirmed / UNSAFE overridden) → classify Task
BEFORE `/executing-plans`. DDG picks own mode (CREATE / EXTEND / MODIFY) via
`find_symbol` probe — wrapper decides only WHETHER to invoke.

| Task intent                                                                                                  | Action                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| **Generation**: new file, new function, new class, new method on existing class, rewrite-to-new-template     | **MUST** invoke `/data-driven-generation` BEFORE any Edit/Write (CREATE / EXTEND)                                          |
| **Modification**: change behavior of EXISTING symbol in place (bug fix, condition tweak, new branch, hotfix) | **MUST** invoke `/data-driven-generation` BEFORE any Edit/Write (MODIFY); state "Step 4.5 skipped — MODIFY skips TEMPLATE" |
| **Refactor only**: rename, move, extract, inline, reformat — no behavior change                              | Skip Step 5; new name → `get_naming_lexicon(names[])` BEFORE Edit, `MISFIT` → use `suggestion` (naming note)               |
| **Deletion**: remove file, remove function, prune dead code                                                  | Skip Step 5 — no generation                                                                                                |
| **Trivial**: typo, comment / log-message text, single-token swap, no behavior change                         | Skip Step 5 AND skip wrapper entirely — direct Edit                                                                        |

**Naming note (rename / extract, codegraph on):** new name →
`get_naming_lexicon(names=[{name, kind, type?}], language, pathPattern)` (`kind`
∈ `param` | `local` | `field` | `constant` | `return` | `type` — never
`variable`) before Edit (`language` = edited file's; evidence never crosses
languages). `MISFIT` → `suggestion`; `NEW_TERM` → `topTerms` word if same
meaning; `NO_CONVENTION` → `prefer.exact` or name like `prefer.analogous`.
Plan-fixed names checked too. Reading: `/data-driven-generation` Step 5 "Naming
(lexicon)".

Why MANDATORY — in-context edit / sibling `Read` misses what DDG owns:

- **Modification (MODIFY):** tests-at-risk (`/tests-as-context` → run tests
  pinning current behavior, note unpinned); `get_callers` on modified symbol
  (callers relying on old contract surface BEFORE commit); symbol-own style +
  strategy (DEFENSIVE on `bugFixRate` critical; hotfix = MODIFY minus
  STRATEGY/STYLE — DDG decides); REUSE existing helper for new branch/guard.
- **Generation:** strategy ladder (DEFENSIVE buggy / STABILIZATION high-churn /
  CONSERVATIVE legacy / STANDARD); template via `proven` preset (not arbitrary
  sibling); `deep-silo` → exact pattern match + live-line owner flagged for
  review.

Invoke (one call, no params — skill reads area context from conversation):

```
/data-driven-generation
```

DDG lacks area context (no overlay labels) → it chains to `/explore` itself. Let
it; NEVER pre-fetch labels.

Step 5 returns (strategy + template + style) → THEN `/executing-plans` (or TDD
chain via `/dino-test-driven-development`).

**Order:** addressing (2.0) → guard (2) → gate (4) → cascade (5) →
`/executing-plans` — DDG return ≠ done; name the chain into executing-plans as
the last step of every Task, subagent runs included. Skipping Step 5 on
generation/modification = same severity as skipping guard on existing file.
Guard SAFE resolves blast-radius gate only — Step 5 separate gate, both must
clear.

## Red Flags — STOP, restart from Step 2

- "Task small, skip guard" → ≥1 existing file in `taskFileList` → Step 2
- `mcp__tree-sitter__modification_guard` substituted → structural, not
  git-signal blast radius; wrapper git-first → Step 2
- Wrong rerank for codegraph state → redo: `"blastRadius"` when codegraph on
  (graph tools present), else `{imports: 0.5, churn: 0.3, ownership: 0.2}`
  (tea-rags analytics-rerank). `"codeReview"` lacks `imports` → blast radius
  invisible
- Guard AFTER first Edit → revert uncommitted if possible, Step 2 before next
  Edit
- Guard block emitted, no gating / UNSAFE treated as warning → CAUTION waits for
  confirmation, UNSAFE pauses until explicit override
- `metaOnly: false` on guard → restart with `metaOnly: true`
- One guard per plan, or all plan files pre-fetched at start → stale by Task 5;
  guard per-Task, just-in-time
- `/executing-plans` for whole plan at once → gate each Task
- Inner cycle chains raw `/test-driven-development` /
  `/verification-before-completion` / `/requesting-code-review` /
  `/finishing-a-development-branch` → intercept, invoke `/dino-Y`
- Generation Task: `Read sibling.ts` + `Write new.ts` without
  `/data-driven-generation` → revert (or pause before Edit), restart from Step 5
- DDG for pure refactor (rename, move, extract) → over-trigger; refactor row =
  SKIP
- Bug fix / condition tweak edited in-context "DDG not needed" → Modification
  row; pause, invoke DDG (MODIFY: tests-at-risk + `get_callers`)
- Alias without `path` inside worktree → wrong tree; redo with
  `project=<alias>` + `path=<your working directory>`
- Reindexed / cloned for worktree's own uncommitted edits, `pendingFiles`, or
  "after commit" cleanup → unneeded; overlay reads tree
