---
name: dino-verification-before-completion
description:
  'Before claiming work complete, scan tea-rags imports/churn on just-edited
  files for collateral-damage candidates (files whose dependents could break),
  then run verification commands so success claims rest on evidence. Triggers on
  "ready to commit", "all done", "should be fixed now", "готово", "можно
  коммитить", "commit and push", "проверь перед commit", "все работает". NOT for
  mid-work sanity checks without a completion claim. Wraps
  /verification-before-completion with a tea-rags collateral-damage scan.'
---

# dinopowers: verification-before-completion

> **Resources in Cursor:** if a `tea-rags://` resource cannot be read (no
> resource tool, or the read fails), run
> `tea-rags resource "<uri>" --path "$PWD"` in the terminal — same content.

Wrapper over `/verification-before-completion`. Adds **collateral-damage scan**:
before "complete", tea-rags blast-radius signals (imports, churn, ownership) on
just-edited files → which dependents to verify.

## Iron Rule

**Collateral-damage scan MUST run BEFORE claiming "done"** — whenever session
edited ≥1 existing file. Diff size irrelevant: 2-line change in high-blast file
= catastrophe; renames break imports.

Core value: `semantic_search` + impact rerank (`"blastRadius"` codegraph on,
`{imports 0.5, churn 0.3, ownership 0.2}` off) + brace-expanded `pathPattern`
over `git diff --name-only HEAD` + `metaOnly: true` + verdict surfacing
high-`fanIn`/`imports` files with explicit "verify dependents".

Only new files (no existing-file edits) → skip scan, verdict
`SAFE (no existing-file edits)`. Never fabricate pathPattern.

**Subagents run the scan themselves.** Task-agent / explore / any subagent
claiming or verifying completion → scan FIRST (read-only `semantic_search`, no
reindex), verdict per file, THEN `/verification-before-completion`. "Report to
parent" covers reindex / drift remedies only — never hand the scan itself to the
parent.

**Codegraph on?** Graph tools (`get_callers`, `trace_path`, `review_changes`, …)
in your tool list; unsure → read
`tea-rags://project/<alias>/metrics?section=registry` (`codegraph on|off`).

**Diff review, same gate** (codegraph on) = `/data-driven-generation` Step 7
GATE — read its `references/step-7-verify.md` and run it; nothing here narrows
it. BEFORE "done" / commit when session edited files: ONE
`review_changes(changes:{}, sections:["naming","incompleteChange","cohesion","architecture","norms"])`
(`{}` = uncommitted edit; committed branch → `changes:{base}`, base =
`git merge-base HEAD main`, never a sibling / integration branch; findings from
a stack below = its owner's, cite the commit, no triage). Triage: no
`preExisting` → repair; `preExisting` + `remedy` → apply the remedy;
`preExisting`, no `remedy` → one report line + bead suggestion, commit allowed.
After every repair: re-run the SAME `review_changes` + targeted tests — target
gone AND no new finding, else revert the whole round; 2 rounds left a must-fix →
ask the user (finding, rounds tried, why reverted; fix / accept with reason /
bead), no commit. `truncated` / `built: false` / skipped files = PARTIAL ≠ pass
→ re-run with `files` batches. `entryPoint` / `compositionRoot` /
`foundationTerminal` QUOTED from the finding = placement, not defect. Report
`GATE review_changes: introduced=<n>, partial=<true|false>`.

## Verdict Ladder (PRESCRIPTIVE — apply before claiming done)

🛑 STOP — read the ladder, then act.

Blast signal = `fanIn` when codegraph on (real dependents), else `imports`
proxy.

| Verdict        | Triggers                                                              | Action (MUST state)                                                                                |
| -------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `UNVERIFIABLE` | scan ran, returned empty (file unindexed / not in git)                | "blast radius unknown" → run FULL suite conservatively; never relabel SAFE                         |
| `HIGH-BLAST`   | `fanIn`/`imports` top 10% of result set (or absolute: >20 dependents) | Surface block to user BEFORE verification runs; recommend FULL suite (all dependents, not own dir) |
| `MEDIUM-BLAST` | `fanIn`/`imports` top 30% (or 5-20 dependents)                        | Run tests of the dependents' area (integration around the file)                                    |
| `LOW-BLAST`    | `fanIn`/`imports` < 5 dependents                                      | File's own tests suffice                                                                           |

`SAFE (no existing-file edits)` only when Step 1 finds no existing-file edit and
the scan never ran. Scan given as numbers / "empty" in the prompt = Step 2
output → name verdict AND its Action now.

Prescriptive, not informational — DO NOT skip; never downgrade HIGH-BLAST to
"probably fine" without evidence. Block says WHICH tests to run; LOW-BLAST needs
no full suite. HIGH-BLAST under time pressure ("deadline", "just the quick
ones"): never pick a narrower set yourself — show the block, state the full
dependent suite it requires, wait for the user's explicit override that
acknowledges the risk before running less. Say: "HIGH-BLAST on <file> — full
dependent suite required. Running only <narrower set> needs your explicit
override acknowledging the risk (untested dependents may break) — reply
'override, I accept the risk'." Deadline in the request ≠ that override.

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every /dino-X
redirects /X. NEVER bypass the wrapper. Open each chained SKILL.md with its own
read.

**Requires superpowers:** `/verification-before-completion` unavailable → stop,
ask the user to install superpowers (https://github.com/obra/superpowers; steps
in [CHAINING.md](../../CHAINING.md)). NEVER run this enrichment alone and
present it as the full workflow. Available = `$verification-before-completion` /
`/verification-before-completion` is in your skills list; superpowers is a
separate plugin, never under the dinopowers dir — a missing file next to the
wrapper is not "unavailable".

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) +
`tea-rags://guide/freshness`. Linked worktree → overlay serves edits, never
reindex. Main checkout → incremental `index_codebase` BEFORE first call over
uncommitted edits, or once `changedFiles` > 0 — no consent (drift `--force` →
ask separately). Lag ≠ unusable (core rules).

## Step 1 — Collect edited file set

From `git status --short` / `git diff --name-only`:

| Source                                 | Example                                  |
| -------------------------------------- | ---------------------------------------- |
| Modified files (`M`) in working tree   | `src/core/domains/explore/reranker.ts`   |
| Staged files (`M`/`R` in index)        | `tests/explore/reranker.test.ts`         |
| Files changed in session (uncommitted) | any file touched by Edit/Write/MultiEdit |

Output:

- `editedFiles`: relative paths with content changes + renames under OLD path
  (its dependents break); new-only files excluded
- `intent`: one sentence — what session changed

`editedFiles` empty → Step 4, verdict `SAFE (no existing-file edits)`.

## Step 2 — Collateral-damage scan call

ONE `semantic_search` — SAME idiom as `/dino-writing-plans` /
`/dino-executing-plans`:

```
project:     <alias>                    ← `tea-rags://guide/freshness` "Addressing the Codebase"
path:        <your working directory>   ← the tree (worktree / branch checkout)
query:       <intent from Step 1>
pathPattern: "{editedFile1,editedFile2,...}"   ← brace expansion
rerank:      "blastRadius"               ← codegraph on; OFF fallback below
limit:       <editedFiles.length * 3>
metaOnly:    true
```

**Codegraph gating for `rerank`:** on → `"blastRadius"` (real `fanIn`); off →
`{ custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }` (import-proxy).

Do NOT substitute:

| Wrong tool                                                      | Why wrong                                                                                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `hybrid_search`                                                 | BM25 leg re-ranks by token overlap — want semantic + signals                                                                |
| Named preset `"hotspots"` / `"codeReview"` / `"impactAnalysis"` | `impactAnalysis` doesn't exist; `hotspots` = BUG-prone history, not BLAST radius. `"blastRadius"` correct when codegraph on |
| `mcp__tree-sitter__trace_impact`                                | Structural call trace = complementary, not git-signal blast radius; tea-rags first                                          |
| One call per file                                               | Brace expansion covers all                                                                                                  |
| Built-in `grep -r "import.*<file>"`                             | Misses ranked `imports` overlay; miscounts re-exports (barrel `export … from`); slower                                      |
| `git log --oneline <files>`                                     | History of edited files, not dependents                                                                                     |

Do NOT pass:

- `metaOnly: false` — verdict inputs = signals, not content
- Different weights — must match `/dino-writing-plans` / `executing-plans` /
  `/data-driven-generation` IMPACT step (cross-skill comparability)
- `filter` narrowing — `pathPattern` scopes

Empty results (files brand-new / not in git) → Step 4, verdict
`UNVERIFIABLE (edited files not indexed)`. Never fabricate signals.

## Step 3 — Compute collateral-damage verdict

Per unique `relativePath`: raw values from `payload.git.file.*` + labels from
`rankingOverlay.file.*` (kept under metaOnly; payload never labelled):

- blast radius — `codegraph.file.fanIn` (blastRadius, codegraph on) or `imports`
  score (custom fallback, off)
- `commitCount` — churn
- `blameDominantAuthorPct` + adaptive label — silo risk (use label `silo` /
  `deep-silo`, codebase-relative, not magic %)

`treeState` rows (your edited files) = the index's PRE-EDIT copies — say so:
fanIn + churn of dependents stay valid (unless those dependents were edited too;
graph edges follow cascade floor rule); row text and lines are stale — never
evidence the edit is correct. Current code via
`find_symbol project=<alias> path=<your working directory>`; linked worktree →
no reindex (Index freshness above).

Apply Verdict Ladder per file. Aggregate:

```
### dinopowers collateral-damage scan

| Edited file | imports | churn | verdict |
|---|---|---|---|
| src/core/contracts/errors.ts | 47 | 23 commits | HIGH-BLAST |
| src/adapters/qdrant/client.ts | 12 | 8 commits | MEDIUM-BLAST |
| tests/explore/strategies.test.ts | 0 | 2 commits | LOW-BLAST |

**Verify before claiming done:**
- `errors.ts` imported by 47 modules → run the project's test suite covering all dependents
- `client.ts` imported by 12 modules → run integration tests touching the qdrant adapter
- `strategies.test.ts` → no dependents; the file's own tests are sufficient
```

Runner-agnostic — never name runners (vitest, jest, pytest, rspec…). Reader
resolves actual test command from project context (package.json scripts,
Makefile, CI).

## Step 3a — Tests-at-risk lookup (targeted verification)

Invoke `/tests-as-context` with:

```
recipe: "tests-at-risk"
affectedFiles: <editedFiles from Step 1>
intent: <intent from Step 1>
```

Recipe → DSL leaf test chunks bound to change. Per HIGH/MEDIUM-BLAST file with
non-empty list, augment verdict block:

```
**Targeted scenarios for high-blast files:**
- src/core/contracts/errors.ts → run the tests for these scenarios:
  - tests/errors/typed-errors.test.ts:42 — TypedError > propagates cause
  - tests/api/handler-errors.test.ts:78 — handler > error response shape
```

Runner-agnostic ("run the tests for these files", "execute these scenarios via
the project's standard test command").

Recipe SKIP (no DSL test chunks) → add
`**Targeted scenarios:** unavailable (no DSL test chunks indexed) — verification scope guided by blast-radius signals only`.

Recipe empty (preflight passed, no match) → add
`**Targeted scenarios:** no obvious test bindings — run general verification covering blast-radius dependents`.

## Step 4 — Invoke /verification-before-completion

Invoke `Skill` tool with `/verification-before-completion`. Prepend
collateral-damage block. Handoff:

> "Before claiming done, the edited files have these blast-radius signals:
> …<block>… Run verification commands that exercise HIGH-BLAST dependents, not
> just files directly edited. Evidence before assertions.
>
> Chaining rule reminder: when your cycle would next invoke
> `/finishing-a-development-branch` (or any wrapped `/Y`), invoke `/dino-Y`
> instead — see the Chaining rule section above."

Inner skill runs verification (tests, type-check, lint, build). Wrapper informs
scope, never substitutes.

## Red Flags — STOP and restart from Step 2

- "Only tests need to run, change isolated" / "edited files' tests pass" → ANY
  edited file `imports > 0` → run Step 2; dependents may break
- "git diff small, skip scan" / "trivial rename" → run Step 2
- Substituted `grep -r` / `git log` → redo with `semantic_search` + Step 2
  rerank
- Rerank wrong for codegraph state → redo: on → `"blastRadius"`, off →
  `{imports: 0.5, churn: 0.3, ownership: 0.2}` (tea-rags analytics-rerank)
- `rerank: "hotspots"` → bug history, not blast radius; redo
- Skipped verification after surfacing HIGH-BLAST → wrapper informs scope, never
  substitutes
- Ran scan, ignored block in verification → block is prescriptive
- `metaOnly: false` → restart
- Inner skill chained raw `/finishing-a-development-branch` → intercept, invoke
  `/dino-finishing-a-development-branch` (Chaining rule)
