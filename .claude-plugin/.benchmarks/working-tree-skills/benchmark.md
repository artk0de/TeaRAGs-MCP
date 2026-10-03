# Benchmark: plugin skills under working-tree addressing

**Date:** 2026-10-03 **Epic:** tea-rags-mcp-xi2r9 **Surface:** every
`.claude-plugin/{tea-rags,dinopowers}/**` skill / reference that tells an agent
how to address tea-rags **Status:** P1–P6 applied (owner decisions below); Phase
4 re-run passed — see "Phase 4 results"

## Summary

With WorkingTreeOverlay every read tool resolves the same-repository index from
`path=<any dir in a checkout>` and answers for that tree (`workingTree` marker,
`treeState` on stale rows). The search cascade ("Addressing the Codebase") and
the subagent injection (c1fd5c81f) already say so. The skills do not: 27 recipe
lines address tea-rags by `project=<alias>` (or a `path: <project>` placeholder
that resolves to the main checkout), and 4 freshness lines order a reindex for
uncommitted edits that, from a linked worktree, either reindexes the main
checkout or seeds a separate project. No skill says what `treeState` means.

Followed literally, the current skills misroute 13 of 14 worktree cases (arm A,
19%). An agent with NO skill gets 14/16 (arm C, 88%), so the skills are net
−69pp on addressing. Dispatched subagents are rescued by the injection block
(arm B, 16/16), but only by overriding the skill in 9 cases, which they flag as
a conflict. A main session started inside a linked worktree has no injection and
depends on the cascade winning over an explicit recipe; arm A is the bound for
that case.

## Harness

optimize-skill Phase 2 tool-selection eval. One opus subagent per arm, all 16
cases in one prompt (`workspace/cases.md`, expectation-free), the agent states
its first tea-rags call and, where a result is shown, its reading and next call.
No tools executed. Skills read from `workspace/skill-snapshot/before/`
(c1fd5c81f). Environment: repo `acme`, main checkout `/work/acme`, worktrees
`/work/acme/.claude/worktrees/<name>`, single alias `acme → /work/acme`, no
per-worktree clone.

| Arm | Guidance                                                                |
| --- | ----------------------------------------------------------------------- |
| A   | skill text only (plus the files it delegates its recipe to)             |
| B   | skill text + rendered injection block (`CLAUDE_PROJECT_DIR=/work/acme`) |
| C   | case file only (without-rule baseline)                                  |

Assertions: **A1** first call carries `path=<cwd>`, no project-only call, no
`index_codebase` before searching in a worktree. **A2** `workingTree.tree` ≠ cwd
→ re-call with `path=<cwd>`; a `treeState` row is the index's pre-edit copy,
current code via `find_symbol path=<cwd>`.

Contamination: the eval subagents are dispatched through `Agent`, so the
installed plugin appends its own block; prompts mark it as out of scope after
`END-OF-EVAL`. Arm A cites only skill lines, so the guard held.

## Inventory

| ID  | File → instruction                                                                                                                                                                                                                                                                                                                   | Misroutes in a linked worktree                                                    |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| F1  | `dinopowers/skills/{brainstorming,writing-plans,executing-plans,verification-before-completion,requesting-code-review,receiving-code-review,writing-skills}/SKILL.md` Step 2 recipe: `project: <alias from list_projects — RECOMMENDED, omit path when set>` / `path: <current project path — fallback when no alias is registered>` | yes, 7 lines (main tree)                                                          |
| F1  | `dinopowers/skills/test-driven-development/SKILL.md` Step 2a fallback `project: <alias from list_projects — RECOMMENDED>`, Step 2b `project: <alias>`                                                                                                                                                                                | yes, 2 lines                                                                      |
| F1  | `dinopowers/skills/executing-plans/SKILL.md` `worktree plan → Step 2.0 target (clone alias)`                                                                                                                                                                                                                                         | inherited by callees: arm A addressed an unregistered `acme-worktree-feat-x` (S7) |
| F2  | `tea-rags/skills/tests-as-context/SKILL.md` 6 recipes `project: <alias>` / `<alias from prime digest>`                                                                                                                                                                                                                               | yes, 6 lines                                                                      |
| F3  | `tea-rags/skills/mr-review/SKILL.md` Phase 0 `list_projects → match registered alias: local mode → cwd … No match → STOP`; Phase 2 `find_symbol … project=<alias>`                                                                                                                                                                   | yes: STOP, or prefix-match onto the main tree, 2 lines                            |
| F3  | `tea-rags/skills/mr-review/references/dimension-playbook.md` 7 calls `project=<alias>`                                                                                                                                                                                                                                               | yes, 7 lines                                                                      |
| F4  | `tea-rags/skills/risk-assessment/SKILL.md` Phase 1 + expansion `path: <project>`; `tea-rags/skills/explore/references/pre-gen-pattern.md` PG-2 `path: <project>`                                                                                                                                                                     | yes, 3 lines (read as the project root)                                           |
| F5  | `tea-rags/skills/bug-hunt/SKILL.md` Loop step 0 + Uncommitted probe "reindex BEFORE"; `tea-rags/rules/index-freshness.md` uncommitted-edits row; `dinopowers/FRESHNESS.md` "Searching uncommitted WIP"                                                                                                                               | yes, 4 lines (reindex hits main, or seeds a project)                              |
| F6  | bug-hunt Signal triage, verification / writing-plans / executing-plans Step 3: no `workingTree` / `treeState` reading                                                                                                                                                                                                                | interpretive: arms A and C read a `treeState` row as the current edit             |

**Total: 27 addressing lines + 4 freshness lines = 31 misrouting instructions.**

Not misrouting: `rules/search-cascade.md` Addressing (the owner, correct);
`references/subagent-injection.md` + `scripts/enforce-tearags-search.sh`
(correct); requesting-code-review's `review_changes` note ("project +
`path=<worktree>`", correct); `get_index_metrics` /
`get_index_status project=<alias>` in analytics-rerank, runtime-introspection,
use-cases (index-level, tree-independent); tea-rags:index, force-reindex and
finishing-a-development-branch alias use (write path by design); executing-plans
Step 2.0 clone (a clone registered at `$PWD` reads the right tree; whether the
overlay retires it is an owner question);
`commands/prime.md $CLAUDE_PROJECT_DIR` (session dir, state only). explore,
data-driven-generation, extract-project-patterns and the remaining skills state
no addressing at all. In arm A that silence resolved to `project=acme` (S1, S5).

## Baseline (iteration 0)

| Arm                   | Pass  | Rate | Notes                                                      |
| --------------------- | ----- | ---- | ---------------------------------------------------------- |
| A — skill only        | 3/16  | 19%  | worktree cases 1/14; only S14 + both controls pass         |
| B — skill + injection | 16/16 | 100% | injection overrode the skill in 9 cases (flagged conflict) |
| C — no skill          | 14/16 | 88%  | S4/S12: reads `treeState` rows as the current edit         |

**A vs C: −69pp.** The skills make addressing worse than no guidance.

| ID  | Case                                          | A    | B      | C    |
| --- | --------------------------------------------- | ---- | ------ | ---- |
| S1  | explore: how WorkingTreeDelta works           | FAIL | PASS   | PASS |
| S2  | explore pre-gen: before modifying X           | FAIL | PASS\* | PASS |
| S3  | bug-hunt: failing test after uncommitted edit | FAIL | PASS\* | PASS |
| S4  | bug-hunt: read a `treeState: modified` row    | FAIL | PASS   | FAIL |
| S5  | data-driven-generation: add a method          | FAIL | PASS   | PASS |
| S6  | risk-assessment: domain scan                  | FAIL | PASS\* | PASS |
| S7  | extract-project-patterns from executing-plans | FAIL | PASS   | PASS |
| S8  | dinopowers:brainstorming                      | FAIL | PASS\* | PASS |
| S9  | dinopowers:writing-plans                      | FAIL | PASS\* | PASS |
| S10 | dinopowers:executing-plans, single task       | FAIL | PASS\* | PASS |
| S11 | dinopowers:test-driven-development            | FAIL | PASS\* | PASS |
| S12 | dinopowers:verification + `treeState` rows    | FAIL | PASS   | FAIL |
| S13 | mr-review local mode                          | FAIL | PASS\* | PASS |
| S14 | writing-plans: `workingTree.tree` ≠ cwd       | PASS | PASS   | PASS |
| S15 | control: brainstorming in main checkout       | PASS | PASS   | PASS |
| S16 | control: risk-assessment in main checkout     | PASS | PASS   | PASS |

\* passed by overriding the skill; the agent reported the conflict.

Typical arm-A failures: `semantic_search(project:"acme", …)` straight from the
dinopowers recipe (S8–S11); `index_codebase(project:"acme")` before searching
(S3, S12), which reindexes `/work/acme` and leaves the edit invisible;
`Read(offset:40, limit:48)` on a `treeState: modified` row's stale line range
(S4).

## Patches (drafted at baseline, applied in Phase 4)

Layer ownership: addressing and `workingTree` / `treeState` reading are
selection policy, owned by `tea-rags/rules/search-cascade.md` → "Addressing the
Codebase", which is already correct. The patches restate nothing. Each recipe
keeps one placeholder line, `path: <your working directory>`, and links the
cascade section; both plugins point at that one section rather than carrying N
copies of the rationale. No new rule file, so `inject-rules.sh --count` stays
unchanged.

**dinopowers SKILL.md edits (P1, P2) MUST go through
`dinopowers:writing-skills`** (wrapper-pattern enforcement). Bump plugin
versions on apply: tea-rags patch, dinopowers patch
(`.claude/rules/plugin-versioning.md`).

### P1 — dinopowers recipes (F1): 7 files, identical hunk

`brainstorming`, `writing-plans`, `verification-before-completion`,
`requesting-code-review`, `receiving-code-review`, `writing-skills` Step 2:

```diff
-project:     <alias from list_projects — RECOMMENDED, omit path when set>
-path:        <current project path — fallback when no alias is registered>
+path:        <your working directory>   ← tea-rags search-cascade "Addressing the Codebase"; never project alone
```

`executing-plans` Step 2:

```diff
-project:     <alias from list_projects — RECOMMENDED, omit path when set;
-              worktree plan → Step 2.0 target (clone alias)>
-path:        <current project path — fallback when no alias is registered>
+path:        <your working directory>   ← tea-rags search-cascade "Addressing the Codebase"; never project alone
```

and the two Step 2.0 lines that route reads to the clone alias and send
single-task worktree work to "main collection directly" (arm A cited both in S7
and S10):

```diff
-3. **Read it.** Step 2 guard + every tea-rags call of this Task address SAME
-   target — clone alias, never main alias.
+3. **Read it.** Step 2 guard + every tea-rags call of this Task (and every
+   skill it invokes) pass `path=<your working directory>` — never an alias alone.
@@
-- **Gate:** only multi-task plan in worktree. Single-task plans, explore-only
-  sessions, main-checkout work → main collection directly: no clone, no Step
-  2.0.
+- **Gate:** only multi-task plan in worktree. Single-task plans, explore-only
+  sessions, main-checkout work → no clone, no Step 2.0; reads still pass
+  `path=<your working directory>`.
```

The clone lifecycle stays. Whether the overlay retires it is a separate owner
decision.

### P2 — dinopowers:test-driven-development (F1)

```diff
-project:     <alias from list_projects — RECOMMENDED>
-path:        <current project path — fallback when no alias>
+path:        <your working directory>   ← tea-rags search-cascade "Addressing the Codebase"
@@ Step 2b
-project:     <alias>
+path:        <your working directory>
```

### P3 — tea-rags:tests-as-context (F2): 6 recipes

```diff
-  project:     <alias>                 (and `<alias from prime digest>`)
+  path:        <your working directory>
```

plus one line under the skill's first recipe heading:
`Addressing: search-cascade "Addressing the Codebase" — path alone; never project alone.`

### P4 — tea-rags:mr-review (F3)

`SKILL.md` Phase 0:

```diff
-**Project:** `list_projects` → match registered alias: local mode → cwd;
-external mode → local checkout of MR's repo (index lives on a path — checkout
-REQUIRED). No match → STOP, print register + index instruction. Never scan
-unindexed repo.
+**Checkout:** local mode → cwd; external mode → local checkout of MR's repo
+(checkout REQUIRED). Every call passes `path=<checkout>` (search-cascade
+"Addressing the Codebase"). Answer reports no index for that repository → STOP,
+print register + index instruction. Never scan unindexed repo.
```

Phase 2 MAP: `project=<alias>` → `path=<checkout>`.
`references/dimension-playbook.md`: delete `project=<alias>` from all 7 calls
and add one header line: `Every call: path=<checkout> (SKILL Phase 0).`
External-mode freshness (`index_codebase project=<alias>`) stays: that is the
write path.

### P5 — `path: <project>` placeholders (F4)

`risk-assessment/SKILL.md` (Phase 1 `rank_chunks`, expansion `find_similar`) and
`explore/references/pre-gen-pattern.md` (PG-2):

```diff
-  path: <project>
+  path: <your working directory>
```

### P6 — freshness vs overlay (F5, F6)

This changes freshness policy, so the owner decides it. The draft keeps the
main-checkout reindex and drops it only where it cannot help.

`tea-rags/rules/index-freshness.md` uncommitted-edits row:

```diff
-| Uncommitted edits the index has not seen (`git status` lists paths), before searching them | `index_codebase` (incremental) | no — reindex silently |
+| Uncommitted edits the index has not seen, in the alias's own checkout | `index_codebase` (incremental) | no — reindex silently |
+| Uncommitted edits in a linked worktree (`workingTree.tree` ≠ alias checkout) | none — read tools overlay the tree; `treeState` rows → `find_symbol` (search-cascade Addressing) | — |
```

`tea-rags/skills/bug-hunt/SKILL.md`:

```diff
-0. `git status --porcelain -uall` → uncommitted paths (see Uncommitted probe).
-   Paths listed → reindex BEFORE step 1 (index-freshness, uncommitted-edits row).
+0. `git status --porcelain -uall` → uncommitted paths (see Uncommitted probe).
+   Paths listed → index-freshness uncommitted-edits rows (linked worktree: no reindex).
@@ Uncommitted probe, last bullet
-- Probe reads INDEXED content → step 0 listed paths → reindex BEFORE the search
-  message, always. …
+- Probe hit with `treeState` = index's pre-edit copy: its text and line range are
+  stale. Judge the edit from `find_symbol path=<cwd>` (current tree), never
+  from the row. Main checkout: reindex first per index-freshness.
```

`dinopowers/FRESHNESS.md` "Searching uncommitted WIP": replace the bullet with a
pointer to the two index-freshness rows above (single owner).

`dinopowers/skills/verification-before-completion/SKILL.md` Step 3 (via
writing-skills), one line:
`Rows with treeState = pre-edit copies of your edited files: fanIn/churn of dependents stand, text does not — current code via find_symbol.`

## Expected effect

| Arm                   | Now                | Expected after P1–P6                                                    |
| --------------------- | ------------------ | ----------------------------------------------------------------------- |
| A — skill only        | 3/16 (19%)         | 16/16: S1/S5 need explore/DDG to inherit cascade addressing (see below) |
| B — skill + injection | 16/16, 9 conflicts | 16/16, 0 conflicts                                                      |
| C — no skill          | 14/16              | unchanged (reference)                                                   |

S1 and S5 fail in arm A because explore and data-driven-generation say nothing
about addressing and the agent defaults to the only alias. P1–P5 do not touch
them. If the Phase 4 re-run still fails them, add the same one-line pointer to
explore's Step 0 and DDG's Prerequisites. These are predictions: re-run arms A
and B against a `skill-snapshot/after/` once the patches are applied (Phase 4)
before claiming them.

## Owner decisions (resolved, applied)

Original open questions:

- P6: should a main-checkout session still reindex for uncommitted edits, now
  that `find_symbol` and hybrid BM25 have floors and only dense ranking lags?
- executing-plans Step 2.0 / index-freshness "Worktree-clone lifecycle": is a
  per-worktree clone still needed under the overlay, given that arm B dropped it
  on its own?

Resolved by the owner (2026-10-03):

1. P1–P5 as drafted; one source of truth = search-cascade "Addressing the
   Codebase"; explore + data-driven-generation get the one-line pointer (S1,
   S5).
2. P6: linked worktree never reindexes for its own uncommitted edits; the main
   checkout keeps the incremental-reindex rule (dense vectors lag otherwise).
3. Per-worktree clone is no longer default — only when `workingTree.degraded`
   reports a delta over the 200-file overlay cap. Teardown stays for clones that
   exist.
4. Addressing section + injection block: every tool (search, find_symbol, graph
   tools, review_changes, get_naming_lexicon, analytics presets) takes the same
   `path`; `floors` (`chunks`, `sparse`, `codegraph`) say which layers came from
   the tree.
5. Patch bumps: tea-rags 0.40.0 → 0.40.1, dinopowers 0.21.7 → 0.21.8.

## Phase 4 results

Same harness, cases unchanged. Arm A guidance = `skill-snapshot/after/` plus
`search-cascade-addressing.md` (the section every recipe now points to — the
"files it delegates its recipe to" rule). Arm B adds
`workspace/injection-block-after.md` (7786 bytes, rendered by the hook). Answers
in `workspace/iteration-{1,2}/arm-{A,B}.md`. Arm C not re-run (no-skill
reference does not change).

| Run                    | A — skill only | B — skill + injection       | Notes                                                                                                                                                                                                            |
| ---------------------- | -------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Baseline (iteration 0) | 3/16 (19%)     | 16/16, 9 skill overrides    | —                                                                                                                                                                                                                |
| Iteration 1            | 16/16          | 16/16, 0 decision conflicts | latent: plan-edit reindex had no worktree split; DDG `find_co_changed(project, …)`; explore "Read surrounding context" ignored `treeState`; extract-project-patterns stated no addressing (S7 passed via caller) |
| Iteration 2            | **16/16**      | **16/16, 0 conflicts**      | latent fixes applied; no addressing / reindex / `treeState` disagreement left                                                                                                                                    |

**A: 19% → 100% (+81pp). B: conflicts 9 → 0.** Every case flipped in arm A
except the three that already passed (S14, S15, S16):

| ID  | Case                                          | A before | A after | B before | B after |
| --- | --------------------------------------------- | -------- | ------- | -------- | ------- |
| S1  | explore: how WorkingTreeDelta works           | FAIL     | PASS    | PASS     | PASS    |
| S2  | explore pre-gen: before modifying X           | FAIL     | PASS    | PASS\*   | PASS    |
| S3  | bug-hunt: failing test after uncommitted edit | FAIL     | PASS    | PASS\*   | PASS    |
| S4  | bug-hunt: read a `treeState: modified` row    | FAIL     | PASS    | PASS     | PASS    |
| S5  | data-driven-generation: add a method          | FAIL     | PASS    | PASS     | PASS    |
| S6  | risk-assessment: domain scan                  | FAIL     | PASS    | PASS\*   | PASS    |
| S7  | extract-project-patterns from executing-plans | FAIL     | PASS    | PASS     | PASS    |
| S8  | dinopowers:brainstorming                      | FAIL     | PASS    | PASS\*   | PASS    |
| S9  | dinopowers:writing-plans                      | FAIL     | PASS    | PASS\*   | PASS    |
| S10 | dinopowers:executing-plans, single task       | FAIL     | PASS    | PASS\*   | PASS    |
| S11 | dinopowers:test-driven-development            | FAIL     | PASS    | PASS\*   | PASS    |
| S12 | dinopowers:verification + `treeState` rows    | FAIL     | PASS    | PASS     | PASS    |
| S13 | mr-review local mode                          | FAIL     | PASS    | PASS\*   | PASS    |
| S14 | writing-plans: `workingTree.tree` ≠ cwd       | PASS     | PASS    | PASS     | PASS    |
| S15 | control: brainstorming in main checkout       | PASS     | PASS    | PASS     | PASS    |
| S16 | control: risk-assessment in main checkout     | PASS     | PASS    | PASS     | PASS    |

\* before: passed only by overriding the skill (conflict flagged). After: no
overrides.

### Applied beyond the drafts

- Every dinopowers "Index freshness" paragraph (brainstorming, writing-plans,
  requesting/receiving-code-review, TDD, systematic-debugging, verification,
  finishing) split by checkout: linked worktree never reindexes for its own
  edits; main checkout reindexes before searching uncommitted WIP.
- writing-plans / executing-plans "edited plan → reindex before next TOC read"
  split the same way (find_symbol reads the TOC from the tree).
- finishing-a-development-branch: clone teardown "MANDATORY when one exists";
  "No clone → no cleanup" covers overlay-read worktrees.
- data-driven-generation `find_co_changed(path=…)`; explore "Read surrounding
  context" excepts `treeState` rows; extract-project-patterns gets the pointer.
- requesting-code-review `review_changes` note: `path=<worktree>` alone.

### Defect-closure rounds (owner policy: every defect found is fixed)

After iteration 2 the owner required every eval-reported defect to be fixed, not
deferred. Iterations 3–11 re-ran arms A and B against each revision and asked
the agents to list DEFECTS (wrong instruction, or two instructions where
following one violates the other) separately from gaps. Every case stayed PASS
in every round; the rounds closed defects, verified against source
(`src/mcp/tools/**`, presets, drift monitors) before any edit.

| Iter | A     | B               | Fixed in this revision                                                                                                                                                                                                                                                                           |
| ---- | ----- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 3    | 16/16 | 16/16           | the six owner items: Red Flags vs `blastRadius` (analytics-rerank owns it); PG-2 `symbol:` (find_symbol schema); D1 `#`/`.` convention; `treeState` pointer in risk-assessment + mr-review; Drift row split; graph answer without `codegraph` floor                                              |
| 4    | 16/16 | 16/16           | seven dinopowers rows claiming "rerank tied to semantic_search" were false (hybrid_search shares the schema) → real reason (BM25 leg); partial Read → `find_symbol`; Glob → tea-rags listing; DDG Step 0 "in index" → tree; architecture report by `path`                                        |
| 5    | 16/16 | 16/16           | injection graph branch scoped (fixes the WT2 regression); bug-hunt one-tool rule in a worktree; PG-1 known symbol → `find_symbol`; `proven` + `level: "chunk"`; `proven` described as the named preset (weights were misquoted); `degraded` remedy under consent; clone `--path` = worktree root |
| 6    | 16/16 | 16/16           | linked-worktree test = cwd vs alias path (was keyed on the answer); `project` = no-cwd option; `get_index_metrics` by `path`; blast signal = fanIn \| imports; injection override scoped to Grep/Glob/Read routing; verification `base`; brainstorming call count                                |
| 7    | 16/16 | 16/16           | clone-mode addressing owned by the cascade + subagent alias hand-off; index skill no longer seeds a linked worktree; finishing teardown "when a clone exists"; seeded project = own-checkout rows                                                                                                |
| 8    | 16/16 | 16/16           | executing-plans SAFE row no longer skips Steps 4.5/5; subagent clone alias; `git diff --name-only HEAD`; mr-review 9 dimensions + external-mode qualifiers                                                                                                                                       |
| 9    | 16/16 | 16/16           | tests-as-context single-shot vs old-server re-issue; "read call" wording; cascade `project` no longer "another repo"; wrong-tree rule keys on the tree you addressed; review wrappers follow the shared `blastRadius` idiom                                                                      |
| 10   | 16/16 | 16/16, 0 latent | index skill wording; risk-assessment phantom PG-2 delegation; injection `path` rule allows a skill-named checkout; re-check via `find_symbol`, `hybrid_search` only for its tree rows                                                                                                            |
| 11   | 16/16 | 16/16, 2 latent | mr-review call budget arithmetic (caps sum ≤49); verification ladder overlap at 5, renames under their old path, staged `M`/`R`; executing-plans CAUTION signal; systematic-debugging `healthy` SKIP and empty `trace_path` aligned with bug-hunt (namesakes + floor first)                      |

Iteration 11 (final text): arm A 16/16, no defects; arm B 16/16, 0 case
conflicts, 2 latent conflicts — `pattern-search` / `refactoring-scan` allowed a
ripgrep fallback for any target, and explore's EXEMPLAR row routed "no rerank
corpus" to ripgrep. Both collide with the block's "identifiers never via
ripgrep" rule; the skill-choice clause covers only tea-rags tools. Fixed:
ripgrep fallback limited to literal text, identifiers → `hybrid_search`. A
targeted ripgrep-axis scan over every tea-rags and dinopowers skill then checked
for siblings: one more (`bug-hunt` rule 3, same unqualified ripgrep allowance),
fixed the same way; the other 17 ripgrep mentions are prohibitions.

### Gaps reported, deliberately not patched

Eval agents also listed gaps: things left unspecified that forced no wrong or
contradictory choice. Examples: the single-file brace `pathPattern` form, how to
derive the fresh-probe window without prime thresholds, whether tree-read
outline ids are valid `find_similar` positives, and whether `rankingOverlay`
labels survive on tree-served rows. The last two depend on server behaviour this
wave does not define, so documenting them would mean inventing facts. They are
listed in the `iteration-*/arm-*.md` answers.
