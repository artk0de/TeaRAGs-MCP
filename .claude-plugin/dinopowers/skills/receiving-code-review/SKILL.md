---
name: receiving-code-review
description:
  Assess reviewer's suggested change (rename, refactor, move, extract) — query
  tea-rags imports/churn signals on affected target, measure blast radius before
  agreeing or pushing back. Triggers on "reviewer suggests", "should I rename",
  "ревьюер предлагает", "стоит ли переименовать", "code review feedback", "PR
  comment about", "review feedback says", "PR comment wants", "address the
  review", "сделай как просит ревьюер", "code review wants me to", "let's
  refactor this per review". NOT for vague stylistic nits without a named
  symbol. Wraps superpowers:receiving-code-review with tea-rags blast-radius
  signals.
---

# dinopowers: receiving-code-review

Wrapper over `superpowers:receiving-code-review`. Agreement with review comment
backed by impact data — accepting this comment affects 3 callers or 300? — not
performative "yes" without verification.

## Iron Rule

**tea-rags impact analysis MUST run on the review-comment's target BEFORE
agreeing to implement** — whenever comment names concrete symbol or file.

Correct tool (`semantic_search`) + correct custom impact rerank
(`imports: 0.5, churn: 0.3, ownership: 0.2`) + correct parameters (pathPattern
scoping to target, `metaOnly: true`) + ordering (analysis BEFORE agreement) =
core value.

Comment stylistic-only (typo, spacing, unclear name without structural change):
skip wrapper, pass through to `superpowers:receiving-code-review`. Don't
fabricate target.

**Chaining rule:** see [CHAINING.md](../../CHAINING.md) — every dinopowers:X
redirects superpowers:X. NEVER bypass wrapper.

**Index freshness:** see [FRESHNESS.md](../../FRESHNESS.md) and
`tea-rags/rules/index-freshness.md`. No background reindex hook — worktree-plan
freshness explicit (clone + per-task reindex in `dinopowers:executing-plans`);
run `mcp__tea-rags__index_codebase` manually to search code edited but not yet
committed, BEFORE first tea-rags call.

## Step 1 — Extract review target

From review comment identify:

| Element                                                       | Example                                                |
| ------------------------------------------------------------- | ------------------------------------------------------ |
| **Target** — symbol or file the comment proposes changing     | `ChunkGrouper.group()`, `src/core/contracts/errors.ts` |
| **Change type** — rename / refactor / move / extract / inline | "rename `group` to `aggregate`"                        |
| **Scope** — local (same file) vs cross-cutting                | "rename exported symbol" = cross-cutting               |

Compose:

- `targetPathPattern`: scoping pattern (e.g. `**/chunk-grouper.ts`, or broader
  if cross-cutting)
- `intent`: one-sentence framing of proposed change

Comment stylistic-only: skip to Step 4 with verdict
`PASS-THROUGH (non-structural)`. Don't invent structural implications.

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

Results empty: verdict `UNVERIFIABLE (target not in index)`. Don't fabricate.

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

## Step 3.5 — Trace the call route the change rides (optional, preferred when the comment names a call relationship)

Step 2 gives **single-symbol** blast-radius number — importer count of target.
When review comment names **relationship between two symbols** ("change how `X`
calls `Y`", "this method should not reach `Z`", "route this through `W`
instead"), change rides a **call route**, not one symbol. Promote single fanIn
to actual PATH: call `mcp__tea-rags__trace_path` between the two named endpoints
to SEE the route the change travels and which step is highest-impact chokepoint.
**Requires codegraph** (prime shows `codegraph.symbols`); when off, `trace_path`
not registered — stay with Step 2 single-symbol fanIn, note route view
unavailable.

```
mcp__tea-rags__trace_path(
  from="<caller symbol the comment names>",   # e.g. the X in "how X calls Y"
  to="<callee symbol the comment names>",     # e.g. the Y, or the Z it "should not reach"
  rerank="blastRadius"                          # rank each hop by fanIn / import impact
)
```

Read the result like this:

- **`dangerRanking[0]`** — highest-impact step ON route, not necessarily either
  endpoint. Chokepoint the proposed change ripples through. "What does this
  change touch" becomes concrete hop with measured fanIn instead of one number
  on named symbol.
- **`dangerOverlay`** per step — carries `imports` / churn for that hop, so a
  quiet intermediate everything routes through surfaces instead of hiding
  between the two named endpoints.
- **Empty result** — NO static call path from `from` to `to`. Review comment's
  premise ("X reaches Y") may be **structurally false** — useful pushback input:
  change targets a route that doesn't exist as reviewer imagines. Confirm before
  agreeing.

Preset selection for the trace:

| Situation                                                     | `rerank`      |
| ------------------------------------------------------------- | ------------- |
| "What does this change ripple through" — impact-ranked route  | `blastRadius` |
| "Who else owns the steps I'd touch" — who to loop into the PR | `ownership`   |

Use `rerank="ownership"` to see who owns each step on route — reviewer named two
symbols, but change rides hops owned by others who should be looped into review.
Bound search with `maxDepth` / `maxPaths` if graph deep or branchy.

Append traced route under impact block from Step 3:

```
**Call route the change rides (<from> → <to>), danger-ranked:**
- chokepoint: <dangerRanking[0] symbol> @ <file>:<line>
  overlay: imports <N>, churn <Y>
- also on route: <next step> @ <file>:<line>
  owner (ownership preset): <blameDominantAuthor> — loop into review
```

Result empty: append
`**Call route:** no static path <from> → <to> — the reviewer's "X reaches Y" premise may not hold; confirm before agreeing`.

Danger-ranked route makes "what does this change ripple through" concrete: a
chokepoint with measured fanIn and named owner is different conversation than a
single import count on the symbol reviewer happened to name.

## Step 3a — Tests bound to the target

When proposed change is rename / move / extract / signature change on a symbol,
tests bound to current name or signature must be identified BEFORE agreeing.
Invoke `Skill(tea-rags:tests-as-context)` with:

```
recipe: "tests-at-risk"
affectedFiles: [<file containing the target symbol>]   ← single-element array OK
intent: <intent from Step 1, e.g. "rename ChunkGrouper.group to aggregate">
```

Recipe accepts single-element `affectedFiles` for symbol-scoped changes —
internally uses `must_not relativePath any-of` filter, works identically for one
or many paths.

Recipe surfaces DSL leaf test chunks exercising the affected symbol. Append to
impact block:

```
**Tests bound to current name/signature:**
- <file>:<line> — <describe-it path>
- <file>:<line> — <describe-it path>
```

Recipe returned SKIP: append
`**Tests bound:** unavailable (no DSL test chunks indexed)`. Recipe returned
empty list: append
`**Tests bound:** no obvious test bindings — the change may still affect untested paths`.

Bound-test list raises cost of proposed change visibly: agreeing to a rename
that breaks 6 named scenarios is different conversation than one with no test
bindings. Phrasing stays runner-agnostic — list scenarios, never name a runner.

## Step 4 — Invoke superpowers:receiving-code-review

Invoke `Skill` tool with `superpowers:receiving-code-review`. Prepend impact
block as context. Phrase handoff as:

> "Before agreeing to this review, note impact signals: …<block>… Respond with
> agreement tied to scope, or respectful pushback if blast radius warrants it.
> Technical rigor, not performative agreement.
>
> Chaining rule reminder: when your cycle would next invoke
> `superpowers:verification-before-completion` (or any wrapped `superpowers:Y`),
> invoke `dinopowers:Y` instead — see the Chaining rule section above."

Let `superpowers:receiving-code-review` run standard rigorous-response cycle.
Wrapper informs whether agreement safe and at what scope.

## Red Flags — STOP and restart from Step 2

- "Comment is clear, I'll just do it" → if names symbol/file, run Step 2 anyway
- "It's just a rename" → renames propagate through imports; always analyze
- Substituted grep/git log → redo with semantic_search + custom rerank
- Named preset instead of custom weights → redo
- Agreed before Step 2 (performative yes) → revert, restart
- Pushed back before Step 2 (defensive no) → revert, restart
- Let `superpowers:receiving-code-review` chain into a raw
  `superpowers:verification-before-completion` without redirecting to
  `dinopowers:verification-before-completion` → intercept and invoke wrapper
  instead (see Chaining rule)

## Common Mistakes

| Mistake                                                             | Reality                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Performative "good catch" agreement                                 | Rigorous agreement requires impact data. Run Step 2.                                                                           |
| Blanket pushback without evidence                                   | Defensive no is as bad as performative yes. Data first.                                                                        |
| Use `rerank: "codeReview"` preset because "this is code review"     | codeReview preset is for finding reviewable code, not impact of a change                                                       |
| `find_similar` to assess rename blast radius                        | find_similar shows analogs, not callers. Use impact rerank.                                                                    |
| Ignore `imports` when comment proposes a rename                     | Rename affects every importer. imports count = response effort                                                                 |
| Agree then grep for callers during implementation                   | Wrong order — impact analysis informs whether to agree at all                                                                  |
| Comment names "how X calls Y" but you only ran single-symbol Step 2 | The change rides a route. `trace_path(from=X, to=Y, rerank="blastRadius")` shows the chokepoint, not just one fanIn (Step 3.5) |
| Loop in only the symbol's owner when the change crosses a route     | The hops between X and Y have other owners. `rerank="ownership"` on the route surfaces who else to loop in                     |
