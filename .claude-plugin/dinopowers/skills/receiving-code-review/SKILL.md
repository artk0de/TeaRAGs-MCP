---
name: receiving-code-review
description:
  Assess a reviewer's suggested change (rename, refactor, move, extract) by
  querying tea-rags imports/churn signals on the affected target to measure
  blast radius before agreeing or pushing back. Triggers on "reviewer suggests",
  "should I rename", "ревьюер предлагает", "стоит ли переименовать", "code
  review feedback", "PR comment about", "review feedback says", "PR comment
  wants", "address the review", "сделай как просит ревьюер", "code review wants
  me to", "let's refactor this per review". NOT for vague stylistic nits without
  a named symbol. Wraps superpowers:receiving-code-review with tea-rags
  blast-radius signals.
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

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X
redirects superpowers:X. NEVER bypass the wrapper.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) — MUST run
`mcp__tea-rags__reindex_changes` if any file was edited in this session, BEFORE
the first tea-rags call.

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
project:     <alias from list_projects — RECOMMENDED, omit path when set>
path:        <current project path — fallback when no alias is registered>
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

Extract from payload: `imports`, `commitCount`, `bugFixRate`,
`blameDominantAuthor` (live-line owner) + `recentDominantAuthor` (recent
committer).

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
- live-line owner: <blameDominantAuthor> (<blameDominantAuthorPct>%)
- recent committer: <recentDominantAuthor> (<recentDominantAuthorPct>%)
- bugFixRate: <X%>

Verdict: <AGREE-WITH-SCOPE | AGREE-DIRECT | PUSHBACK>
```

## Step 3a — Tests bound to the target

When the proposed change is rename / move / extract / signature change on a
symbol, the tests bound to the current name or signature need to be identified
BEFORE agreeing. Invoke `Skill(tea-rags:tests-as-context)` with:

```
recipe: "tests-at-risk"
affectedFiles: [<file containing the target symbol>]   ← single-element array OK
intent: <intent from Step 1, e.g. "rename ChunkGrouper.group to aggregate">
```

The recipe accepts a single-element `affectedFiles` for symbol-scoped changes —
internally it uses a `must_not relativePath any-of` filter, which works
identically for one or many paths.

The recipe surfaces DSL leaf test chunks that exercise the affected symbol.
Append to the impact block:

```
**Tests bound to current name/signature:**
- <file>:<line> — <describe-it path>
- <file>:<line> — <describe-it path>
```

If recipe returned SKIP: append
`**Tests bound:** unavailable (no DSL test chunks indexed)`. If recipe returned
empty list: append
`**Tests bound:** no obvious test bindings — the change may still affect untested paths`.

The bound-test list raises the cost of the proposed change visibly: agreeing to
a rename that breaks 6 named scenarios is a different conversation than agreeing
to one with no test bindings. Phrasing stays runner-agnostic — list scenarios,
never name a runner.

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
