---
name: mr-review
description:
  'Signal-driven review of merge request or local branch — rank diff risks via
  tea-rags (blast radius, fragile zones, silo style, missing tests, doc
  invariants, cycles, naming), emit plain-language comments each naming a
  concrete fix. Triggers on "review this MR <url>", "review MR/PR", "проведи
  ревью MR", "сделай ревью ветки", "review my branch". External URL → inline
  comments posted via session''s MR-platform mechanism after ONE draft-gate
  confirm, signed agent, [minor] prefix on style nits. NOT for building reviewer
  context before requesting review (use requesting-code-review), NOT for health
  scan without a diff (use risk-assessment), NOT for debugging a concrete
  failure (use bug-hunt).'
---

# MR Review

9-dimension diff scan → actionable comments. Signals decide WHAT to flag;
comment states fact in plain words + names fix. Local = chat report. External =
inline MR comments behind ONE draft-gate, agent-signed, `[minor]` on style nits.

## Phase Order (MANDATORY — do not skip any phase)

1. Phase 0 — RESOLVE mode + project + freshness
2. Phase 1 — ACQUIRE diff + intent
3. Phase 2 — MAP diff → symbols + overlay working set
4. Phase 3 — SCAN 9 dimensions (parallel blocks)
5. Phase 4 — CLASSIFY severity + evidence filter
6. Phase 5 — DELIVER (chat report | draft-gate → post)

## Rules

1. **Execute YOURSELF** — no subagents.
2. **Git signals ONLY from overlay** — never `git log` / `git blame`. Diff
   acquisition (Phase 1) = sanctioned exception: review INPUT, not signals.
3. **No built-in Search/Grep** — tea-rags tools per
   `tea-rags://guide/decision-tree`.
4. **Evidence filter is hard.** Every finding rests on signal value or concrete
   code (symbol, line, sibling pattern). Can't cite → drop in Phase 4, never
   soften into speculative "maybe consider…" nit. Evidence = INTERNAL gate;
   reader wording = rule 6.
5. **Every posted comment carries a fix.** Observation + consequence +
   suggestion. No actionable suggestion ("this file is fragile") → demote to
   observation, never post.
6. **Speak human, not signal.** Body states FACT the signal stands for ("30+
   modules import this"), never signal itself. Banned in body: tool names
   ("get_callers shows…", "tea-rags flags…"), payload keys (`git.*`,
   `codegraph.*`), preset/label jargon (`concerning`, `deep-silo`), UUIDs,
   scores, dimension codes. Translation table:
   `references/delivery-contract.md`.
7. **Cite only reader-openable paths** — files tracked in MR's repo. Agent
   session context (CLAUDE.md, `.claude/rules/**` incl. gitignored `.local/**`,
   memory, SessionStart digest, skills) is NEVER evidence in a comment.
8. **Depth → `find_symbol`, never Read** — `symbol=<symbolId>` for body,
   `relativePath` for outline.
9. **External posting ALWAYS behind one whole-batch draft-gate confirm** —
   circuit breaker, not decoration. Posted without it → restart Phase 5.
10. **Never fake skipped dimension** — name it "not assessed" in summary.

## Flow

```text
0. RESOLVE   → mode (URL? external : local) + checkout path + freshness
1. ACQUIRE   → unified diff + MR title/description/author
2. MAP       → hunks → {file, changedSymbols[], chunkUUIDs[], overlay}
3. SCAN      → 9 dimensions — references/dimension-playbook.md
4. CLASSIFY  → severity + evidence filter + dedup
5. DELIVER   → local: chat report | external: draft-gate → post
              (references/delivery-contract.md)
```

## Phase 0: RESOLVE

**Mode:** `$ARGUMENTS` contains URL → external. Else local.

**Checkout:** local mode → cwd; external mode → local checkout of MR's repo
(checkout REQUIRED). Every call passes `path=<checkout>`. Answer reports no
index for that repository → STOP, print register + index instruction. Never scan
unindexed repo.

**Freshness (gate — skipped → stale index misses recent base changes, signals
lie):** external → `git fetch` target branch; index behind target → incremental
`index_codebase project=<alias>`. Local → `tea-rags://guide/freshness` (lag ≠
unusable, reindex triggers; linked worktree: no reindex — overlay reads tree).

## Phase 1: ACQUIRE

**External:** unified diff + MR title/description/author via session's
MR-platform mechanism (platform CLI / platform MCP server / http-client —
whichever configured; skill names no commands). No mechanism → STOP external
mode ("no MR-platform mechanism available"), offer local mode on checked-out
branch instead.

**Local:** `git diff <merge-base main..HEAD>` + uncommitted (`git diff HEAD`).
On main → uncommitted only. Empty diff → STOP, say so.

MR description = review intent — feeds D6 invariants.

## Phase 2: MAP

1. Parse hunks → touched files + changed line ranges (new side).
2. Per touched source file — cap 15, above → ask user to narrow scope:
   `find_symbol relativePath=<file> rerank="hotspots" path=<checkout>` →
   outline. Intersect changed ranges with symbol spans → changed symbols + chunk
   UUIDs.
3. Output per file: `{file, changedSymbols[], chunkUUIDs[], overlay}` — working
   set every Phase 3 dimension reads. Overlay = labels from
   `rankingOverlay.{file,chunk}.*` + raw values from payload `git.*`,
   `codegraph.symbols.*` (payload never carries labels).

Non-indexed touched files (new in MR, generated, docs) → `overlay: none`, still
eligible for D6; never fabricate overlay for them. Local mode: row with
`treeState` = pre-edit index copy, lines stale → `find_symbol` for current code.

## Phase 3: SCAN

Nine dimensions over working set, parallel blocks. Full per-dimension
parameters + severity mapping:
[references/dimension-playbook.md](./references/dimension-playbook.md) — execute
its parameter blocks byte-exact (diff-review has no block: its call is the table
row).

| Dimension     | Catches                                                                  | Mechanism                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| blast-radius  | hidden coupling, hub edits                                               | `get_callers` + overlay fanIn/transitiveImpact/isHub                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| shotgun-twins | co-change siblings untouched in MR                                       | `find_similar` batch on changed chunks + taskIds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| fragile-zone  | edits in panic zones                                                     | overlay bugFixRate/churnVolatility/burst — 0 calls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| silo-style    | non-owner edits silo file                                                | blameDominantAuthor\* + proven neighbors as reference                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| tests         | scenarios at risk, uncovered changes                                     | tests-as-context + stratified per-cluster coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| invariants    | diff contradicts docs/specs                                              | `semantic_search documentation="only"` on concepts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| cycles        | MR introduces import/call cycle                                          | `find_cycles` scoped to touched dirs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| naming        | new names off the project vocabulary                                     | local: ONE own `review_changes(changes:{base:<target branch>}, sections:["naming"], project, path)` call (not folded into diff-review's) — named in the plan even when verdicts are already in context (they come from that call), no hand-built `names[]`; external (MR not checked out — tree lacks its code): `get_naming_lexicon names[]` from the diff's added-line declarations (`kind` param/local/field/constant/return/type; called method → `return`), never `changes` / `review_changes` on the local tree. Report = the Phase 5 **Local** D8 shape, copied (one form, defined there) |
| diff-review   | incomplete changes, cohesion, diff-scoped architecture, dependency norms | `review_changes(changes:{base}, sections:["incompleteChange","cohesion","architecture"])` — naming is D8's own call; architecture findings (+ `change.nonLocal`, `change.resolved`; never `change.persisting`) → `$architecture-diagnostics` Phase 3h decides each (classification + its `repair/<family>.md`), not this skill's evidence/fix gate — never re-judge or hedge them; severity follows `tier` (critical > active > structural), `change.touchedActive` = high; norms: list every `MISFIT` (edge + `expectedPath`), note `exclusionsUnchecked`                                       |

Gating: codegraph on (graph tools `get_callers` / `find_cycles` in tool list;
unsure → `tea-rags://project/<alias>/metrics?section=registry`) → D1 + D7 + D8
run on graph. Off → D7, D8 "not assessed" (no substitute; never "no cycles"); D1
degrades to name-matched callers (`hybrid_search` symbol name + `find_symbol`),
every comment on it says callers found by name, not call graph — lower bound,
never "these are all the callers". tests follows tests-as-context preflight.

Call budget: ≤30 tea-rags calls typical MR, ≤49 at every cap (playbook).
Exceeded → narrow scope with user, never silently truncate coverage.

## Phase 4: CLASSIFY

1. Dedup findings by file:line — keep highest severity. Two findings on same
   symbol → merge into one.
2. Cross-dimension overlap on same file/symbol → escalate one level (fragile +
   blast-radius → major).
3. Evidence filter pass: no citable signal label / code reference → DROP
   finding. Observations (non-posted class) survive only into chat summary,
   never into posting contract.
4. **Fix gate:** write the suggestion — concrete file/symbol/pattern to follow.
   Can't name one → demote to observation. Architecture findings skip steps 3–4:
   the Phase 3h disposition stands.
5. **Source-visibility gate:** every cited path must be tracked in the MR's repo
   (`git ls-files --error-unmatch`, not `git check-ignore`d). Agent-side path →
   restate the point from the code, else drop the finding.
6. **Volume cap:** ≤8 posted comments, ≤5 major. Overflow → one summary line
   each, never extra inline comments.
7. **Humanize:** rewrite each body as observation → consequence → suggestion, ≤3
   sentences, ≤1 number, zero signal jargon (rule 6).
8. Output finding list in delivery-contract shape (Phase 5).

## Phase 5: DELIVER

Contract shape + conventions + degradation:
[references/delivery-contract.md](./references/delivery-contract.md).

**Local:** chat report — findings by severity (major first), observations,
dimensions-skipped notes. No posting. **D8 naming overrides the severity
grouping, local too:** naming findings grouped by verdict (MISFIT, COLLISION,
NEW_TERM); every finding must include `review.findings[].relPath:line`; MISFIT
and COLLISION marked `[minor]`; then one summary line, literally
`conforming: <n>; novel: <n>` (counts from the review answer; a count it lacks →
`n/a`). Verdict = group heading only; each finding line, literally:
`<relPath>:<line> — [minor] <plain observation; consequence; fix = suggestion + holder>`
(NEW_TERM: no `[minor]`). No verdict codes / tool names in finding lines; the
summary never names the review mode.

**External:** draft table (`file:line | severity | one-line body`) → ONE
whole-batch confirmation → agent posts inline comments + summary via session's
MR-platform mechanism (MCP server preferred, else CLI, else http-client) →
per-comment posted/failed status, failed retried once then surfaced in chat.

Never post without the gate. Never claim posted without per-comment status. No
mechanism → print contract in chat, mark "delivered locally".

## Anti-patterns (not covered by Rules)

- **20 comments on one MR** → cap 8, fold rest into summary. Wall of nits gets
  dismissed whole.
- **One batched hybrid_search for all clusters' test coverage** → BM25 crowding
  fabricates "untested". Stratify per domain cluster (playbook D5).
- **External mode: reviewing MR-branch state instead of diff-vs-indexed-base** →
  review diff like human reviewer; no MR-branch checkout, no per-MR reindex.
  (Local mode reads your tree via `path` — that is the diff.)
- **Hardcoding platform commands (glab/gh) into flow or comments** → delivery =
  agent's session mechanism; skill emits contract only.
