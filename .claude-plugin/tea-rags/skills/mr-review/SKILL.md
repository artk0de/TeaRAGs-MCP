---
name: mr-review
description:
  Signal-driven review of merge request or local branch — rank diff risks via
  tea-rags (blast radius, fragile zones, silo style, missing tests, doc
  invariants, cycles), emit evidence-citing comments. Triggers on "review this
  MR <url>", "review MR/PR", "проведи ревью MR", "сделай ревью ветки", "review
  my branch". External URL → inline comments posted via session's MR-platform
  mechanism after ONE draft-gate confirm, signed agent, [minor] prefix on style
  nits. NOT for own-branch pre-merge flow (use
  dinopowers:requesting-code-review), NOT for health scan without a diff (use
  risk-assessment), NOT for debugging a concrete failure (use bug-hunt).
argument-hint: "[MR/PR URL — omit for local review]"
---

# MR Review

Signal-driven diff review: 7-dimension scan (blast radius, co-change twins,
fragile zones, silo style, tests, doc invariants, cycles) → evidence-citing
comments. Local mode = chat report. External mode = inline MR comments behind
ONE draft-gate, agent-signed, `[minor]` prefix on style nits.

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
4. **Evidence filter is hard.** Every posted comment cites labeled signal value
   or concrete code (symbol, line, sibling pattern). Can't cite → drop finding
   in Phase 4, never soften into speculative nit.
5. **Partial reads only** — chunk coordinates from results.
6. **External posting ALWAYS behind one whole-batch draft-gate confirm.**
7. **Never fake skipped dimension** — name it "not assessed" in summary.

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

Gating: blast-radius + cycles ONLY when prime lists `codegraph.symbols` — absent
→ "not assessed" in summary. tests follows tests-as-context preflight.

Call budget: ≤30 tea-rags calls typical MR (≤15 files). Exceeded → narrow scope
with user, never silently truncate coverage.

## Phase 4: CLASSIFY

1. Dedup findings by file:line — keep highest severity.
2. Cross-dimension overlap on same file/symbol → escalate one level (fragile +
   blast-radius → major).
3. Evidence filter pass: no citable signal label / code reference → DROP
   finding. Observations (non-posted class) survive only into chat summary,
   never into posting contract.
4. Output finding list in delivery-contract shape (Phase 5).

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
- **One batched hybrid_search for all clusters' test coverage** → BM25 crowding
  fabricates "untested". Stratify per domain cluster (playbook D5).
- **Reviewing MR-branch state instead of diff-vs-indexed-base** → skill reviews
  the diff like a human reviewer; no MR-branch checkout, no per-MR reindex.
- **Hardcoding platform commands (glab/gh) into flow or comments** → delivery =
  agent's session mechanism; skill emits contract only.
- **Claiming "no cycles" / "no hubs" with codegraph off** → "not assessed".
- **Skipping freshness gate** → stale-index review misses recent base changes,
  signals lie.
- **Fabricating overlay for `overlay: none` files** → new/unindexed files have
  no signals; only D6 applies to them.
