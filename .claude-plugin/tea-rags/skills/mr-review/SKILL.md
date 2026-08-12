---
name: mr-review
description:
  Signal-driven review of merge request or local branch — rank diff risks via
  tea-rags (blast radius, fragile zones, silo style, missing tests, doc
  invariants, cycles), emit plain-language comments each naming a concrete fix.
  Triggers on "review this MR <url>", "review MR/PR", "проведи ревью MR",
  "сделай ревью ветки", "review my branch". External URL → inline comments
  posted via session's MR-platform mechanism after ONE draft-gate confirm,
  signed agent, [minor] prefix on style nits. NOT for own-branch pre-merge flow
  (use dinopowers:requesting-code-review), NOT for health scan without a diff
  (use risk-assessment), NOT for debugging a concrete failure (use bug-hunt).
argument-hint: "[MR/PR URL — omit for local review]"
---

# MR Review

Signal-driven diff review: 7-dimension scan (blast radius, co-change twins,
fragile zones, silo style, tests, doc invariants, cycles) → comments a reviewer
can act on. Signals decide WHAT to flag; the comment states the fact in plain
words and names a fix. Local mode = chat report. External mode = inline MR
comments behind ONE draft-gate, agent-signed, `[minor]` prefix on style nits.

## Phase Order (MANDATORY — do not skip any phase)

1. Phase 0 — RESOLVE mode + project + freshness
2. Phase 1 — ACQUIRE diff + intent
3. Phase 2 — MAP diff → symbols + overlay working set
4. Phase 3 — SCAN 7 dimensions (parallel blocks)
5. Phase 4 — CLASSIFY severity + evidence filter
6. Phase 5 — DELIVER (chat report | draft-gate → post)

## Rules

1. **Execute YOURSELF** — no subagents.
2. **Git signals ONLY from overlay** — never `git log` / `git blame`. Diff
   acquisition (Phase 1) = sanctioned exception: review INPUT, not signals.
3. **No built-in Search/Grep** — tea-rags tools per search-cascade.
4. **Evidence filter is hard.** Every finding rests on a signal value or
   concrete code (symbol, line, sibling pattern). Can't cite → drop in Phase 4,
   never soften into speculative nit. Evidence is the INTERNAL gate — how it is
   worded for the reader is rule 6.
5. **Every posted comment carries a fix.** Observation + consequence +
   suggestion. No actionable suggestion → demote to observation, never post.
6. **Speak human, not signal.** Body states the FACT the signal stands for ("30+
   modules import this"), never the signal itself. Banned in body: tool names,
   payload keys (`git.*`, `codegraph.*`), preset/label jargon (`concerning`,
   `deep-silo`), UUIDs, scores, dimension codes. Translation table:
   `references/delivery-contract.md`.
7. **Cite only reader-openable paths** — files tracked in the MR's repo. Agent
   session context (CLAUDE.md, `.claude/rules/**` incl. gitignored `.local/**`,
   memory, prime, skills) is NEVER evidence in a comment.
8. **Partial reads only** — chunk coordinates from results.
9. **External posting ALWAYS behind one whole-batch draft-gate confirm.**
10. **Never fake skipped dimension** — name it "not assessed" in summary.

## Flow

```text
0. RESOLVE   → mode (URL? external : local) + registry alias + freshness
1. ACQUIRE   → unified diff + MR title/description/author
2. MAP       → hunks → {file, changedSymbols[], chunkUUIDs[], overlay}
3. SCAN      → 7 dimensions — references/dimension-playbook.md
4. CLASSIFY  → severity + evidence filter + dedup
5. DELIVER   → local: chat report | external: draft-gate → post
              (references/delivery-contract.md)
```

## Phase 0: RESOLVE

**Mode:** `$ARGUMENTS` contains URL → external. Else local.

**Project:** `list_projects` → match registered alias: local mode → cwd;
external mode → local checkout of MR's repo (index lives on a path — checkout
REQUIRED). No match → STOP, print register + index instruction. Never scan
unindexed repo.

**Freshness:** external → `git fetch` target branch; index behind target →
incremental `index_codebase project=<alias>`. Local → incremental reindex when
prime staleness banner fires and MAP needs current symbols.

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
   `find_symbol relativePath=<file> project=<alias>` → outline. Intersect
   changed ranges with symbol spans → changed symbols + chunk UUIDs.
3. Output per file: `{file, changedSymbols[], chunkUUIDs[], overlay}` — working
   set every Phase 3 dimension reads. Overlay = `git.file.*`, `git.chunk.*`,
   `codegraph.*` from find_symbol payloads.

Non-indexed touched files (new in MR, generated, docs) → `overlay: none`, still
eligible for D6.

## Phase 3: SCAN

Seven dimensions over working set, parallel blocks. Full per-dimension
parameters + severity mapping:
[references/dimension-playbook.md](./references/dimension-playbook.md) — execute
its parameter blocks byte-exact.

| Dimension     | Catches                              | Mechanism                                             |
| ------------- | ------------------------------------ | ----------------------------------------------------- |
| blast-radius  | hidden coupling, hub edits           | `get_callers` + overlay fanIn/transitiveImpact/isHub  |
| shotgun-twins | co-change siblings untouched in MR   | `find_similar` batch on changed chunks + taskIds      |
| fragile-zone  | edits in panic zones                 | overlay bugFixRate/churnVolatility/burst — 0 calls    |
| silo-style    | non-owner edits silo file            | blameDominantAuthor\* + proven neighbors as reference |
| tests         | scenarios at risk, uncovered changes | tests-as-context + stratified per-cluster coverage    |
| invariants    | diff contradicts docs/specs          | `semantic_search documentation="only"` on concepts    |
| cycles        | MR introduces import/call cycle      | `find_cycles` scoped to touched dirs                  |

Gating: prime lists `codegraph.symbols` → D1 + D7 run on the graph. Absent → D7
"not assessed" (cycles need the graph, no substitute); D1 degrades to
name-matched callers (`hybrid_search` symbol name + `find_symbol`) and every
comment built on it says callers were found by name, not by call graph — a lower
bound, never "these are all the callers". tests follows tests-as-context
preflight.

Call budget: ≤30 tea-rags calls typical MR (≤15 files). Exceeded → narrow scope
with user, never silently truncate coverage.

## Phase 4: CLASSIFY

1. Dedup findings by file:line — keep highest severity. Two findings on same
   symbol → merge into one.
2. Cross-dimension overlap on same file/symbol → escalate one level (fragile +
   blast-radius → major).
3. Evidence filter pass: no citable signal label / code reference → DROP
   finding. Observations (non-posted class) survive only into chat summary,
   never into posting contract.
4. **Fix gate:** write the suggestion — concrete file/symbol/pattern to follow.
   Can't name one → demote to observation.
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
dimensions-skipped notes. No posting.

**External:** draft table (`file:line | severity | one-line body`) → ONE
whole-batch confirmation → agent posts inline comments + summary via session's
MR-platform mechanism (MCP server preferred, else CLI, else http-client) →
per-comment posted/failed status, failed retried once then surfaced in chat.

Never post without the gate. Never claim posted without per-comment status. No
mechanism → print contract in chat, mark "delivered locally".

## Anti-patterns

- **Posting without draft-gate** → restart Phase 5. Gate is circuit breaker, not
  decoration.
- **Comment without citable evidence** → drop, don't soften into "maybe
  consider…" nit.
- **Comment reading as a signal dump** (`bugFixRate 48% concerning`, `fanIn 34`,
  `D1+D3 overlap`) → reader sees telemetry, not review. State the fact in words.
- **Diagnosis with no fix** ("this file is fragile") → either name what to do or
  move it to observations.
- **Citing agent-side context** (`.claude/rules/.local/*`, CLAUDE.md, memory,
  prime) → reader cannot open it; it is not evidence in an MR.
- **Naming the tooling in a comment** ("get_callers shows…", "tea-rags flags…")
  → reviewer cares about the code, not how it was found.
- **20 comments on one MR** → cap at 8, fold the rest into the summary. A wall
  of nits gets dismissed whole.
- **One batched hybrid_search for all clusters' test coverage** → BM25 crowding
  fabricates "untested". Stratify per domain cluster (playbook D5).
- **Reviewing MR-branch state instead of diff-vs-indexed-base** → skill reviews
  the diff like a human reviewer; no MR-branch checkout, no per-MR reindex.
- **Hardcoding platform commands (glab/gh) into flow or comments** → delivery =
  agent's session mechanism; skill emits contract only.
- **Claiming "no cycles" / "no hubs" / "no other callers" with codegraph off** →
  cycles are "not assessed"; name-matched callers are a lower bound, say so.
- **Skipping freshness gate** → stale-index review misses recent base changes,
  signals lie.
- **Fabricating overlay for `overlay: none` files** → new/unindexed files have
  no signals; only D6 applies to them.
