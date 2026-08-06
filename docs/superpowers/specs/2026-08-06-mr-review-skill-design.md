# mr-review skill — design

Date: 2026-08-06 Status: approved (design), pending spec review Owner: tea-rags
plugin (`.claude-plugin/tea-rags/skills/mr-review/`)

## Problem

Reviewing a merge request today means reading the diff cold. The reviewer has no
ranked signal about which touched files are fragile, which changed symbols are
load-bearing hubs, which sibling code usually changes together with the edited
chunks, or which documented invariants the diff contradicts. tea-rags already
computes all of that — git trajectory signals, codegraph edges, test chunks,
documentation chunks — but no skill turns them into review comments.

## What it does

One skill, two modes, one shared scan core.

- **Local mode** — the user asks for a review of local work (current branch,
  worktree). Findings are reported in chat. Nothing is posted anywhere.
- **External mode** — the user provides an MR/PR URL. Same scan core runs, and
  findings become inline comments on the MR, posted after a single draft-gate
  confirmation, each signed as agent-authored, style nits prefixed `[minor]`.

Mode detection: `$ARGUMENTS` contains a URL → external; otherwise local.

## Delivery is the agent's problem, not the skill's

The skill never names `glab`, `gh`, a specific MCP server, or an HTTP endpoint.
It produces a **delivery contract** — a structured list of comments with
file/line targets — and instructs the agent to deliver them through whatever
MR-platform mechanism the session has available (platform CLI, platform MCP
server, http-client with a configured token). Users wire up that mechanism
themselves, outside this skill. If no mechanism is available, the skill degrades
to printing the contract in chat for manual posting — never fails the review
because posting is impossible.

Contract per comment:

```text
{ file, line (new side of diff), severity: "major" | "minor",
  body (evidence-citing text), signature }
```

Plus one summary comment: verdict, finding counts by severity, scan coverage
(dimensions run / skipped and why).

Comment conventions:

- `[minor]` prefix on every style/naming/docs nit — anything that should not
  block the merge.
- Signature footer on every comment and on the summary:
  `🤖 tea-rags mr-review agent`.
- Comment language mirrors the MR description language; default English.

## Flow

| Phase      | Action                                                                                                                                                                                                                                            | Tools                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| 0 RESOLVE  | Detect mode. Match the repo to a registered tea-rags project (`list_projects` + git remote / cwd match). Not registered → stop with register+index instruction. Freshness gate: fetch target branch; index behind → incremental `index_codebase`. | `list_projects`, git     |
| 1 ACQUIRE  | External: unified diff + MR title/description (intent) via the agent's platform mechanism. Local: `git diff <merge-base>..HEAD` + uncommitted changes; on main → uncommitted only. Empty diff → stop.                                             | platform mechanism / git |
| 2 MAP      | Diff hunks → touched files → changed symbols: intersect changed line ranges with `find_symbol` outline spans per touched file.                                                                                                                    | `find_symbol`            |
| 3 SCAN     | Seven dimensions over changed files/symbols, parallel blocks (table below).                                                                                                                                                                       | tea-rags                 |
| 4 CLASSIFY | Severity + evidence filter + dedup by file:line. Cross-dimension overlap escalates severity (same file flagged by fragile-zone AND blast-radius → major).                                                                                         | —                        |
| 5 DELIVER  | Local: chat report. External: draft table → ONE confirmation for the whole batch → agent posts via available mechanism → report posted/failed per comment.                                                                                        | agent mechanism          |

The diff itself is review INPUT and is acquired via git / the platform — this is
the sanctioned exception to the "no git diff" rule that scan phases still obey
(git signals come only from the overlay, never from raw git commands).

## Scan dimensions (Phase 3)

| Dimension     | Catches                                                                      | Mechanism                                                                         |
| ------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| blast-radius  | hidden coupling, hub edits                                                   | `get_callers` on changed symbols + overlay `fanIn` / `transitiveImpact` / `isHub` |
| shotgun-twins | siblings that historically change together but are untouched in this MR      | `find_similar` on changed chunks, filter by co-change evidence                    |
| fragile-zone  | edits landing in panic zones                                                 | overlay `bugFixRate` / `churnVolatility` / burst signals on touched files         |
| silo-style    | non-owner editing a deep-silo file → style scrutiny against proven neighbors | `blameDominantAuthor*` overlay + proven-preset neighbors as style reference       |
| tests         | scenarios at risk, changed branches without coverage                         | `tests-as-context` (tests-at-risk recipe) + per-symbol coverage check             |
| invariants    | diff contradicting documented behavior/specs                                 | `semantic_search` `documentation: "only"` on diff concepts                        |
| cycles        | MR introducing an import/call cycle                                          | `find_cycles` scoped to touched directories                                       |

Codegraph-gated dimensions (blast-radius, cycles) run only when prime lists
`codegraph.symbols`; otherwise skipped and named as "not assessed" in the
summary — never silently, never faked. tests dimension follows the
tests-as-context preflight (DSL test chunks absent → file-level fallback, else
skip with note).

## Evidence filter (hard rule)

Every posted comment MUST cite either a signal value with its label
(`bugFixRate 48% concerning`) or concrete code (symbol, line, existing sibling
pattern). A finding that cannot cite evidence is dropped in Phase 4, not
softened into a speculative nit. Posting a hallucinated finding on a real MR
costs reviewer trust — the filter is the price of external posting.

## Severity rules

- **major** — broken/contradicted documented invariant; hub edit with untested
  changes; edit in fragile zone without test updates; new cycle; missing
  co-change twin with co-change evidence.
- **minor** (`[minor]` prefix) — style deviation from silo/proven neighbors,
  naming, docs nits, test-description wording.
- Cross-dimension overlap escalates one level. Single weak signal without
  overlap → chat-report only in external mode (not posted), listed under
  "observations".

## Review baseline

Review runs against the indexed base branch state — like a human reviewer who
reads the diff knowing the existing code. The skill does NOT check out the MR
branch and does NOT reindex per MR (minutes on a large project, near-zero signal
gain). Freshness gate in Phase 0 only ensures the base index is not stale
relative to the target branch.

## Non-goals

- No platform-specific commands inside the skill (no glab/gh cookbook).
- No MR-branch checkout, no per-MR reindex.
- No auto-posting without the draft-gate confirmation.
- No subagent fan-out — direct execution like risk-assessment (bounded diff
  scope, cross-dimension overlap needs one context).
- Not a replacement for dinopowers:requesting-code-review (own-branch pre-merge
  flow) — this skill reviews someone else's MR or gives a local review verdict.

## Degradation matrix

| Condition                        | Behavior                                                                |
| -------------------------------- | ----------------------------------------------------------------------- |
| Repo not in tea-rags registry    | Stop; print register + index instructions                               |
| Index stale vs target branch     | Incremental `index_codebase`, then proceed                              |
| Codegraph off                    | Skip blast-radius + cycles; summary says "structural axis not assessed" |
| No DSL test chunks               | tests dimension falls back to `testFile: "only"` file-level check       |
| No delivery mechanism in session | Print delivery contract in chat for manual posting                      |
| Empty diff                       | Stop with explicit message                                              |

## Affected files

- `.claude-plugin/tea-rags/skills/mr-review/SKILL.md` — new; caveman ultra body,
  full-compressed description with triggers + NOT-for boundaries (vs bug-hunt,
  risk-assessment, dinopowers review wrappers).
- `.claude-plugin/tea-rags/skills/mr-review/references/` — dimension playbook
  (per-dimension call parameters, severity mapping), delivery contract spec.
- `.claude-plugin/tea-rags/.claude-plugin/plugin.json` — version 0.30.19 →
  0.31.0 (new skill = minor bump).

## Estimate

Sub-epic lower bound: P25 0.5 / P50 1 / P75 1.5 burst days (markdown authoring +
references + trigger-description tuning; no runtime code).
