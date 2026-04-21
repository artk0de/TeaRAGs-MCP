---
name: receiving-code-review
description:
  Use when receiving code review feedback that proposes a concrete change
  (rename, refactor, move, extract) to a named file or symbol — before agreeing
  or implementing, queries tea-rags imports/churn signals on the affected target
  to assess blast radius of the proposed change. Triggers when
  superpowers:receiving-code-review would normally fire AND the comment names a
  specific target. NOT for stylistic nits (typos, spacing) — those pass through
  directly.
---

# dinopowers: receiving-code-review

Wrapper over `superpowers:receiving-code-review`. Ensures agreement with a
review comment is backed by impact data — does accepting this comment affect 3
callers or 300? — instead of performative "yes" without verification.

## Iron Rule

**tea-rags impact analysis MUST run on the review-comment's target BEFORE
agreeing to implement** — whenever the comment names a concrete symbol or file.

Correct tool (`semantic_search`) + correct custom impact rerank
(`imports: 0.5, churn: 0.3, ownership: 0.2`) + correct parameters (pathPattern
scoping to the target, `metaOnly: true`) + ordering (analysis BEFORE agreement)
is the core value.

If the comment is stylistic-only (typo, spacing, unclear name without structural
change): skip wrapper, pass through to `superpowers:receiving-code-review`. Do
not fabricate a target.

## Chaining rule (MANDATORY)

When the wrapped `superpowers:` skill runs its cycle it may instruct you to
invoke another `superpowers:Y` skill next (TDD after planning, verification
after editing, review after completion, etc.). **Redirect every such onward
`Skill(superpowers:Y)` call to `Skill(dinopowers:Y)` whenever a `dinopowers:Y`
wrapper exists.**

Wrapped skills — use the `dinopowers:` form, NOT `superpowers:`:

- `dinopowers:brainstorming`
- `dinopowers:executing-plans`
- `dinopowers:finishing-a-development-branch`
- `dinopowers:receiving-code-review`
- `dinopowers:requesting-code-review`
- `dinopowers:systematic-debugging`
- `dinopowers:test-driven-development`
- `dinopowers:verification-before-completion`
- `dinopowers:writing-plans`
- `dinopowers:writing-skills`

Why: each `dinopowers:Y` wrapper injects tea-rags signals (ownership, churn,
imports, bugFixRate, risk tiers) BEFORE the inner skill runs. A direct
`superpowers:Y` call skips that enrichment — exactly what this wrapper layer
prevents.

Only invoke `superpowers:Y` directly when Y is NOT in the list above (e.g.
`superpowers:using-git-worktrees`, `superpowers:subagent-driven-development`).

## Step 1 — Extract review target

From the review comment identify:

| Element                                                       | Example                                                |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| **Target** — symbol or file the comment proposes changing     | `ChunkGrouper.group()`, `src/core/contracts/errors.ts` |
| **Change type** — rename / refactor / move / extract / inline | "rename `group` to `aggregate`"                        |
| **Scope** — local (same file) vs cross-cutting                | "rename exported symbol" = cross-cutting               |

Compose:

- `targetPathPattern`: scoping pattern (e.g. `**/chunk-grouper.ts`, or broader
  if cross-cutting)
- `intent`: one-sentence framing of the proposed change

If comment is stylistic-only: skip to Step 4 with verdict
`PASS-THROUGH (non-structural)`. Do not invent structural implications.

## Step 2 — Impact analysis call

Issue ONE `mcp__tea-rags__semantic_search` — SAME idiom as
`dinopowers:writing-plans` / `executing-plans` /
`verification-before-completion`:

```
path:        <current project path>
query:       <intent from Step 1>
pathPattern: <targetPathPattern>
rerank:      { custom: { imports: 0.5, churn: 0.3, ownership: 0.2 } }
limit:       10
metaOnly:    true
```

Do NOT substitute:

| Wrong tool                                   | Why wrong                                                        |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `mcp__tea-rags__hybrid_search`               | Custom impact rerank tied to `semantic_search`                   |
| Named preset (`"hotspots"` / `"codeReview"`) | Named presets miss `imports` weight                              |
| `mcp__tea-rags__find_similar` on target      | Finds structural analogs, not importers                          |
| `grep -rn "ChunkGrouper"` for usages         | Misses the ranked `imports` overlay; noisy with comments/strings |
| `mcp__tree-sitter__trace_impact` as primary  | Structural complement; this wrapper is git-first                 |

Do NOT pass:

- `metaOnly: false` — verdict inputs are signals, not content
- Different weights — must match project idiom
- `filter` narrowing — pathPattern already scopes

If results are empty: verdict `UNVERIFIABLE (target not in index)`. Do not
fabricate.

## Step 3 — Compute agreement verdict

Extract from payload: `imports`, `commitCount`, `bugFixRate`, `dominantAuthor`.

Verdict ladder:

| Verdict            | Triggers                         | Action                                                                                                                          |
| ------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `AGREE-WITH-SCOPE` | imports > 20 OR bugFixRate > 30% | Agree, but expand scope: list all N importers in response + commit to update them OR explain why a partial change is acceptable |
| `AGREE-DIRECT`     | imports ≤ 5 AND bugFixRate ≤ 20% | Agree; small blast radius; single-commit change                                                                                 |
| `PUSHBACK`         | imports > 50 (massive blast)     | Respond with impact data: "renaming X affects N modules across M authors — propose alternative or narrower change first"        |

Compose response block:

```
### Impact analysis for review comment: "<comment>"

Target: <symbol or file>
- imports: <N> (rank <R> of <K> in targetPathPattern)
- churn: <N> commits, last touched <D> days ago
- ownership: <dominantAuthor> (<pct>%)
- bugFixRate: <X%>

Verdict: <AGREE-WITH-SCOPE | AGREE-DIRECT | PUSHBACK>
```

## Step 4 — Invoke superpowers:receiving-code-review

Invoke the `Skill` tool with `superpowers:receiving-code-review`. Prepend the
impact block as context. Phrase handoff as:

> "Before agreeing to this review, note impact signals: …<block>… Respond with
> agreement tied to scope, or respectful pushback if blast radius warrants it.
> Technical rigor, not performative agreement.
>
> Chaining rule reminder: when your cycle would next invoke
> `superpowers:verification-before-completion` (or any wrapped `superpowers:Y`),
> invoke `dinopowers:Y` instead — see the Chaining rule section above."

Let `superpowers:receiving-code-review` run its standard rigorous-response
cycle. This wrapper informs whether agreement is safe and at what scope.

## Red Flags — STOP and restart from Step 2

- "Comment is clear, I'll just do it" → if it names a symbol/file, run Step 2
  anyway
- "It's just a rename" → renames propagate through imports; always analyze
- Substituted grep/git log → redo with semantic_search + custom rerank
- Named preset instead of custom weights → redo
- Agreed before Step 2 (performative yes) → revert, restart
- Pushed back before Step 2 (defensive no) → revert, restart
- Let `superpowers:receiving-code-review` chain into a raw
  `superpowers:verification-before-completion` without redirecting to
  `dinopowers:verification-before-completion` → intercept and invoke the wrapper
  instead (see Chaining rule)

## Common Mistakes

| Mistake                                                         | Reality                                                                  |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Performative "good catch" agreement                             | Rigorous agreement requires impact data. Run Step 2.                     |
| Blanket pushback without evidence                               | Defensive no is as bad as performative yes. Data first.                  |
| Use `rerank: "codeReview"` preset because "this is code review" | codeReview preset is for finding reviewable code, not impact of a change |
| `find_similar` to assess rename blast radius                    | find_similar shows analogs, not callers. Use impact rerank.              |
| Ignore `imports` when comment proposes a rename                 | Rename affects every importer. imports count = response effort           |
| Agree then grep for callers during implementation               | Wrong order — impact analysis informs whether to agree at all            |
