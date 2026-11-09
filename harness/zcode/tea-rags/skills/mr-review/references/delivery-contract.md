# Delivery Contract — Phase 5 DELIVER

Structured review output. Skill emits THIS; agent delivers via whatever
MR-platform mechanism session exposes. Skill names NO commands. Reader =
developer opening MR, not operator of this skill — optimize for them.

## Contract shape

```text
comment := { file, line (new side), severity: "major"|"minor",
             body: observation + consequence + suggestion, signature }
summary := { verdict, counts by severity, dimensions run/skipped + why,
             observations list }
```

`why` = the reason a dimension is not assessed; never the review mode or which
tool judged it.

## Comment body — three parts, in this order

1. **Observation** — what the change does that drew attention, in plain
   language.
2. **Consequence** — why that matters here, concretely.
3. **Suggestion** — what to do instead. Name the file, symbol, or existing
   pattern to follow.

Hard limits: ONE point per comment, at most 3 sentences, at most ONE number.

**No suggestion → not a comment.** Unactionable finding = observation → summary
or nowhere (Phase 4).

## Speak human, not signal

Signals = how review was DERIVED, not what it SAYS. Reader sees fact signal
stands for — never payload key, preset name, label.

| What the signal said (internal) | What the comment says                                            |
| ------------------------------- | ---------------------------------------------------------------- |
| high `bugFixRate`               | "about half the commits here have been bug fixes"                |
| erratic `churnVolatility`       | "this file changes in bursts — rewrites, not small edits"        |
| burst activity                  | "this area has been churning heavily the last few weeks"         |
| high `fanIn` / `isHub`          | "30+ modules import this"                                        |
| high `transitiveImpact`         | "a break here reaches most of the billing flow"                  |
| silo `blameDominantAuthorPct`   | "one person wrote nearly all of this file"                       |
| shared `taskIds` + similarity   | "these two files have changed together in past tickets"          |
| no test coverage found          | "nothing in the suite exercises this branch"                     |
| doc contradiction               | "`docs/billing.md` says invoices never re-open; this lets them"  |
| pre-existing cycle              | "these two modules already import each other; this adds a third" |

**Never appears in a comment body:** tool names (`find_symbol`, `get_callers`,
`semantic_search`, `find_cycles`), the words tea-rags / MCP / rerank / overlay /
signal / preset / confidence, payload keys (`git.file.*`, `codegraph.*`), label
words as jargon (`concerning`, `erratic`, `deep-silo`, `frequent`), chunk UUIDs,
similarity scores, dimension codes (D1…D8).

## Cite only what the reader can open

Evidence must be checkable by someone who has this MR and nothing else:

- **Allowed** — files tracked in the MR's repository: source, tests, docs,
  config, plus symbols and line numbers inside them.
- **Forbidden** — anything that exists only in the reviewing agent's session:
  `CLAUDE.md`, `.claude/rules/**` (gitignored `.local/**` above all), agent
  memory, SessionStart digest / prime output, skill files, local notes.

Before a path enters a comment body:

```bash
git ls-files --error-unmatch <path>   # not tracked → drop the citation
git check-ignore -q <path>            # ignored     → drop the citation
```

Reader would need your agent to open it → not evidence. Point may still hold —
restate from code, or drop finding.

## Volume

≤8 inline comments per MR, ≤5 major. Two findings on one symbol → one comment.
Beyond cap → one summary line each ("3 further minor nits: naming in X, missing
doc on Y…"), never extra inline comments — comment-on-everything review gets
dismissed whole.

## Comment conventions

- `[minor]` prefix on every style/naming/docs nit — anything that should not
  block the merge. Body starts with the prefix, then the point.
- Signature footer on EVERY comment and on the summary:
  `🤖 tea-rags mr-review agent`.
- Comment language mirrors MR description language; default English.
- One inline comment per finding at its file:line. One summary comment total.

## Worked example

Same finding, both ways.

Rejected — signal dump, no action, unopenable citation:

```text
git.file.bugFixRate 48% (concerning) + churnVolatility erratic; codegraph
file.fanIn 34 (frequent), isHub true. D1+D3 overlap → major. Per
.claude/rules/.local/working-style.md this needs coverage.
```

Correct:

```text
This file has been one of the repo's more failure-prone spots — about half its
commits are bug fixes — and 30+ modules import it. The new early return in
`InvoiceBuilder#build` changes behavior for archived clients with no test
covering it. Worth adding a case to `spec/services/invoice_builder_spec.rb`
alongside the existing "skips archived clients" example.

🤖 tea-rags mr-review agent
```

## Delivery

Agent posts through the session's available MR-platform mechanism:

1. Platform MCP server — PREFER when several mechanisms available.
2. Platform CLI.
3. `http-client` MCP with configured token.

None available → print full contract in chat for manual posting, mark review
"delivered locally". NEVER fail the review because posting is impossible.

## Draft-gate (external mode, MANDATORY)

1. Render draft table: `file:line | severity | one-line body` per finding.
2. ONE confirmation for the whole batch — never per-comment, never skipped.
3. Post each comment inline at its file:line + the summary comment.
4. Report per-comment status: posted / failed. Failed → retry once, then surface
   in chat with the unposted body.

## Local mode

No posting. Chat report (D8 naming findings: grouped by verdict, MISFIT /
COLLISION `[minor]`, per SKILL.md Phase 5): findings grouped by severity (major
first), then observations, then dimensions-skipped notes ("blast radius: callers
found by name, not by call graph — codegraph off", "tests: no DSL chunks,
file-level fallback").

Same comment shape, same plain language — the chat report is read by a human
too. Raw signal values stay out of it; quote one only if the user asks why a
finding was raised.

## Degradation matrix

| Condition                        | Behavior                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------- |
| Repo not in tea-rags registry    | Stop; print register + index instructions                                        |
| Index stale vs target branch     | External: incremental `index_codebase`; local: `tea-rags://guide/freshness` rows |
| Codegraph off                    | Blast radius → callers matched by name\*; cycles, naming → "not assessed"        |
| No DSL test chunks               | tests dimension falls back to `testFile: "only"` file-level                      |
| No delivery mechanism in session | Print delivery contract in chat for manual posting                               |
| Empty diff                       | Stop with explicit message                                                       |

\* Callers found by symbol name (`hybrid_search` + `find_symbol`), not by call
graph. Every comment built that way says so and never claims the caller list is
complete.
