---
name: dino-receiving-code-review
description:
  'Assess reviewer''s suggested change (rename, refactor, move, extract) — query
  tea-rags imports/churn signals on affected target, measure blast radius before
  agreeing or pushing back. Triggers on "reviewer suggests", "should I rename",
  "ревьюер предлагает", "стоит ли переименовать", "code review feedback", "PR
  comment about", "review feedback says", "PR comment wants", "address the
  review", "сделай как просит ревьюер", "code review wants me to", "let''s
  refactor this per review". NOT for vague stylistic nits without a named
  symbol. Wraps $receiving-code-review with tea-rags blast-radius signals.'
---

# dinopowers: receiving-code-review

Wrapper over `$receiving-code-review`. Agreement backed by impact data — does
accepting comment touch 3 callers or 300? — not performative "yes".

## Iron Rule

**tea-rags impact analysis MUST run on comment's target BEFORE agreeing to
implement** — whenever comment names concrete symbol or file. Scope also = any
request to assess/count callers or impact of a named symbol ("use grep to count
callers of X") — Step 2 scan runs, grep refused.

Value = right tool (`semantic_search`) + impact rerank (`blastRadius` / custom
fallback `imports: 0.5, churn: 0.3, ownership: 0.2`) + params (pathPattern
scoped to target, `metaOnly: true`) + order (analysis BEFORE agreement OR
pushback).

**Step 2 tool = `semantic_search`. Overrides general search routing** ("impact →
`get_callers`", "usages → `hybrid_search`", "file → `find_symbol`"): those are
NOT the impact scan here. `get_callers` / `find_symbol` may follow Step 2 as
depth, never replace it.

**Rule holds when user asks otherwise** ("just agree", "reject it", "skip the
impact", "use grep, faster") — run Step 2 anyway, say: "Running the impact scan
first — agreeing or refusing without it is a guess." Defensive no without data =
as bad as performative yes.

**Signals already given** (prompt/user states `imports=N`, `bugFixRate=X%`, or
"scan returned empty") = Step 2 output. Go straight to Step 3 verdict on them.
Do NOT ask "which class/helper?" first — verdict is per target file; name the
verdict, then ask for symbol detail if needed.

Stylistic-only comment (typo, spacing) → skip wrapper, pass to
`$receiving-code-review`. Never fabricate target. Naming comment ("rename X to
Y", "unclear name") NEVER stylistic-only → Step 3b.

**Chaining rule:** [CHAINING.md](../../CHAINING.md) — every onward `$Y` →
`$dino-Y`. NEVER bypass wrapper.

**Requires superpowers:** `$receiving-code-review` — availability per
[CHAINING.md](../../CHAINING.md) "Missing superpowers" steps 1–3. Not in the
skills list ≠ unavailable (the list is truncated): read
`$CODEX_HOME/plugins/cache/*/superpowers/*/skills/receiving-code-review/SKILL.md`
first; only a failed read → stop and ask the user to install superpowers
(https://github.com/obra/superpowers). NEVER present this enrichment alone as
the full workflow.

**Freshness:** [FRESHNESS.md](../../FRESHNESS.md) (owner
`tea-rags://guide/freshness`). Lag ≠ unusable — never Bash `cat`/`grep`/`Read`
over code; `treeState` row → `find_symbol`.

## Step 1 — Extract review target

| Element                                                       | Example                                                |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| **Target** — symbol or file the comment proposes changing     | `ChunkGrouper.group()`, `src/core/contracts/errors.ts` |
| **Change type** — rename / refactor / move / extract / inline | "rename `group` to `aggregate`"                        |
| **Scope** — local (same file) vs cross-cutting                | "rename exported symbol" = cross-cutting               |

Compose `targetPathPattern` (e.g. `**/chunk-grouper.ts`, broader if
cross-cutting) + `intent` (one sentence).

Stylistic-only → Step 4, verdict `PASS-THROUGH (non-structural)`. Never invent
structural implications.

## Step 2 — Impact analysis call

ONE `semantic_search` — same idiom as `$dino-writing-plans` / `executing-plans`
/ `verification-before-completion`:

```
project:     <alias>                    ← `tea-rags://guide/freshness` "Addressing the Codebase"
path:        <your working directory>   ← the tree (worktree / branch checkout)
query:       <intent from Step 1>
pathPattern: <targetPathPattern>
rerank:      "blastRadius"               ← codegraph on; else { custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }
limit:       10
metaOnly:    true
```

Do NOT substitute:

| Wrong tool                                         | Why wrong                                                                                            |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `hybrid_search`                                    | Same rerank, but its BM25 leg re-ranks by query-token overlap — signal scan wants semantic + signals |
| Other named preset (`"hotspots"` / `"codeReview"`) | Named presets miss `imports` weight                                                                  |
| `find_similar` on target                           | Finds structural analogs, not importers                                                              |
| `grep -rn "ChunkGrouper"` for usages               | Misses the ranked `imports` overlay; noisy with comments/strings                                     |
| `get_callers` / `find_symbol` as the scan          | Symbol edges only — no churn/ownership/bugFixRate; verdict ladder needs signals                      |
| `mcp__tree-sitter__trace_impact` as primary        | Structural complement; this wrapper is git-first                                                     |

Do NOT pass:

- `metaOnly: false` — verdict inputs = signals
- different weights — must match project idiom
- `filter` narrowing — pathPattern scopes already

Empty → verdict `UNVERIFIABLE (target not in index)`. Never fabricate. State
"blast radius unknown". Target is a new / unindexed file (no existing importers)
→ agree direct, single-commit change. Never ask for a class name in place of the
verdict.

## Step 3 — Compute agreement verdict

Raw from payload: `imports` root, `git.file.commitCount`,
`git.file.blameDominantAuthor` (live-line owner). Labels + non-essentials
(`bugFixRate`, `recentDominantAuthor` recent committer) from
`rankingOverlay.file.*` when rerank surfaces them — metaOnly payload keeps git
essentials only.

Verdict ladder — check top-down, FIRST match wins, always name one verdict:

| Verdict            | Triggers                                     | Action                                                                                                                          |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `UNVERIFIABLE`     | scan empty                                   | State blast radius unknown; new file → agree direct, single commit                                                              |
| `PUSHBACK`         | imports > 50 (massive blast), any bugFixRate | Respond with impact data: "renaming X affects N modules across M authors — propose alternative or narrower change first"        |
| `AGREE-WITH-SCOPE` | imports > 5 OR bugFixRate > 20%              | Agree, but expand scope: list all N importers in response + commit to update them OR explain why a partial change is acceptable |
| `AGREE-DIRECT`     | imports ≤ 5 AND bugFixRate ≤ 20%             | Agree; small blast radius; single-commit change — no scope inflation                                                            |

PUSHBACK = no implementation now. Unidentified symbol in a file never blocks the
verdict — file signals decide it.

**Verdict name alone = incomplete — do its Action column.** `AGREE-WITH-SCOPE`
response MUST carry BOTH: (1) importer list — Step 2 rows; signals given as bare
numbers (`imports=25`) → fetch the N importers (`get_callers` /
`hybrid_search metaOnly:true` on the symbol) and list them, never "no further
search needed"; (2) commitment line: "update all N in this change" OR "partial:
<which> + why acceptable".

Response block:

```
### Impact analysis for review comment: "<comment>"

Target: <symbol or file>
- imports: <N> (rank <R> of <K> in targetPathPattern)
- churn: <N> commits, last touched <D> days ago
- live-line owner: <blameDominantAuthor> (<blameDominantAuthorPct>%)
- recent committer: <recentDominantAuthor> (<recentDominantAuthorPct>%)
- bugFixRate: <X%>

Verdict: <UNVERIFIABLE | PUSHBACK | AGREE-WITH-SCOPE | AGREE-DIRECT>
Action: <AGREE-DIRECT: single-commit change, no scope inflation | other verdicts: their row's action>
Scope (AGREE-WITH-SCOPE): importers <list of N> · commitment <update all N | partial: why>
```

## Step 3.5 — Trace call route (codegraph; preferred when comment names call relationship)

Comment names relationship between two symbols ("how `X` calls `Y`", "should not
reach `Z`", "route through `W`") → change rides route, not one symbol. Run
`trace_path(from, to, rerank)` per
[references/call-route.md](references/call-route.md) — chokepoint + hop owners
appended to impact block. Codegraph off → Step 2 fanIn only, note route view
unavailable.

## Step 3a — Tests bound to the target

Rename / move / extract / signature change → identify tests bound to current
name/signature BEFORE agreeing. Invoke `$tests-as-context`:

```
recipe: "tests-at-risk"
affectedFiles: [<file containing the target symbol>]   ← single-element array OK
intent: <intent from Step 1, e.g. "rename ChunkGrouper.group to aggregate">
```

Single-element `affectedFiles` OK (recipe's `must_not relativePath any-of`
filter works for one or many). Recipe → DSL leaf test chunks exercising symbol.
Append:

```
**Tests bound to current name/signature:**
- <file>:<line> — <describe-it path>
- <file>:<line> — <describe-it path>
```

SKIP → append `**Tests bound:** unavailable (no DSL test chunks indexed)`. Empty
→ append
`**Tests bound:** no obvious test bindings — the change may still affect untested paths`.

Runner-agnostic — list scenarios, NEVER name runner.

## Step 3b — Naming comments (codegraph on)

Rename / "unclear name" comment →
`get_naming_lexicon(names=[{current}, {proposed}], language=<file's>, pathPattern=<targetPathPattern>)`
— evidence never crosses languages.

- proposed `CONFORMS` → agree on name (unless it carries `alternatives` —
  project's word for same concept)
- proposed `MISFIT`, current not `CONFORMS` → counter-propose its `suggestion`
  (holder as precedent)
- proposed `MISFIT` / `NEW_TERM` while current `CONFORMS` → push back: keep
  current name, cite project's term + its holder (file) as precedent

Before results, write which row applies and its action. A shorter / abbreviated
rename of a current name (`doc` for `tax_automation_document`) = row "proposed
`MISFIT` / `NEW_TERM` while current `CONFORMS`": plan to push back, keeping the
current name, citing the project term + its holder file.

Naming across whole change, no identifier named ("names in this PR don't match
the codebase") →
`review_changes(changes={ base: <the PR's target branch> }, sections: ["naming"])`
— one call over names diff adds (base read at merge-base with HEAD); never
hand-list into `names[]`. Findings = `review.findings`, flat
`{relPath, line, name, kind, type?, verdict, …}`. Per finding:

- `MISFIT` → apply `suggestion`; type MISFIT with `role.evidence: "directory"`
  only when type belongs to `role.examples`' family — else push back (location,
  not name)
- `COLLISION` → rename or justify against `existing`
- `NEW_TERM` → keep with justification or take offered `alternatives` word
- `genericName` → rename or justify
- conforming stay; `review.novel` = nothing to compare, no action

Reply states the rule per name / finding, one line each:
`<name> (relPath:line): <verdict> → <action>` — verdict alone ≠ answer.

Append verdicts to impact block — naming verdict decides WHICH name, Step 2
decides cost. Reading: `$data-driven-generation` Step 5 "Naming (lexicon)".

## Step 4 — Invoke $receiving-code-review

Invoke `Skill` tool with `$receiving-code-review`. Prepend impact block as
context. Phrase handoff as:

> "Before agreeing to this review, note impact signals: …<block>… Respond with
> agreement tied to scope, or respectful pushback if blast radius warrants it.
> Technical rigor, not performative agreement.
>
> Chaining rule reminder: when your cycle would next invoke
> `$verification-before-completion` (or any wrapped `$Y`), invoke `$dino-Y`
> instead — see the Chaining rule section above."

`$receiving-code-review` runs standard rigorous cycle — wrapper informs whether
agreement safe and at what scope.

## Red Flags — STOP, restart from Step 2

- "Comment clear, just do it" / "just a rename" → names symbol/file → Step 2;
  renames propagate through every importer (imports = response effort)
- grep / git log / `find_similar` (analogs, not callers) substituted → redo with
  semantic_search + Step 2 rerank
- Wrong rerank for codegraph state → redo: `"blastRadius"` when codegraph on
  (graph tools present), else `{imports: 0.5, churn: 0.3, ownership: 0.2}`
  (tea-rags analytics-rerank). `"codeReview"` finds reviewable code, not change
  impact
- Agreed before Step 2 (performative "good catch") → revert, restart
- Pushed back before Step 2 (defensive no, no evidence) → revert, restart
- Agreed, then grep callers during implementation → wrong order; impact decides
  whether to agree
- Comment names "how X calls Y", only single-symbol Step 2 ran → Step 3.5
  `trace_path` (chokepoint, hop owners to loop in)
- Inner cycle chains raw `$verification-before-completion` → intercept, invoke
  `$dino-verification-before-completion`
