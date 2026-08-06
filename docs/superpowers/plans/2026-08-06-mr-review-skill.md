# mr-review Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> dinopowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `mr-review` skill in the tea-rags plugin — signal-driven
review of an external MR or local branch, per the approved spec at
`docs/superpowers/specs/2026-08-06-mr-review-skill-design.md`.

**Architecture:** One skill, two modes (local chat report / external posting
with draft-gate), shared 7-dimension scan core over tea-rags signals. Delivery
mechanism stays outside the skill: it emits a structured comment contract and
the agent posts through whatever platform tooling the session has.

**Tech Stack:** Markdown skill authoring only — no runtime code. tea-rags MCP
tools referenced by the skill: `list_projects`, `index_codebase`, `find_symbol`,
`get_callers`, `find_similar`, `semantic_search`, `hybrid_search`,
`find_cycles`.

**Beads:** epic `tea-rags-mcp-3ei0s`. One task bead per plan Task, 1:1 titles,
sequential deps.

## Global Constraints

- Skill body prose: caveman `ultra`; frontmatter description: caveman `full`
  (keep quoted triggers + every `NOT for X — use Y` boundary) — per
  `.claude/rules/caveman-compression.md`. Output-format contracts (tables,
  call-parameter blocks, JSON shapes) stay byte-exact, never compressed.
- All plugin docs in English.
- Every commit touching `.claude-plugin/tea-rags/**` in the final state must
  land with `plugin.json` bumped 0.30.19 → 0.31.0 (new skill = minor). Bump
  once, in Task 4.
- Signature string (verbatim, used in both references and SKILL.md):
  `🤖 tea-rags mr-review agent`.
- Severity vocabulary: `major` | `minor`. Posted minor comments carry `[minor]`
  prefix. Findings failing the evidence filter are dropped, not posted.
- Commit subjects reference the epic: `(3ei0s)`.
- After each file: `npx prettier --write <file>`; lint with
  `mcp__markdownlint__lint_markdown` (MD013 table-row hits are accepted noise —
  tables don't wrap; fix everything else).

---

### Task 1: SKILL.md — frontmatter, rules, phases 0–2

**Files:**

- Create: `.claude-plugin/tea-rags/skills/mr-review/SKILL.md`

**Interfaces:**

- Produces: phase names
  `0 RESOLVE / 1 ACQUIRE / 2 MAP / 3 SCAN / 4 CLASSIFY / 5 DELIVER` and the
  Phase 2 output shape (list of
  `{file, changedSymbols[], chunkUUIDs[], overlay}`) that Tasks 2–3 reference.

- [ ] **Step 1: Write frontmatter + skeleton**

Frontmatter verbatim (caveman `full` — triggers and boundaries preserved):

```yaml
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
```

Body skeleton (H1 `# MR Review`, then sections in this order): Phase Order list,
Rules, Flow diagram, Phase 0–5 sections, Anti-patterns (stub — filled in Task
4), links to `references/dimension-playbook.md` and
`references/delivery-contract.md`.

- [ ] **Step 2: Write Rules section**

Adapt the risk-assessment rules block, ultra-compressed:

1. Execute YOURSELF — no subagents.
2. Git signals ONLY from overlay — never `git log` / `git blame`. Diff
   acquisition (Phase 1) is the sanctioned exception: review INPUT, not signals.
3. No built-in Search/Grep — tea-rags tools per search-cascade.
4. Evidence filter is hard: every posted comment cites a labeled signal value or
   concrete code (symbol, line, sibling pattern). Can't cite → drop the finding
   (Phase 4), never soften into a speculative nit.
5. Partial reads only, from chunk coordinates.
6. External posting ALWAYS behind one whole-batch draft-gate confirm.
7. Never fake a skipped dimension — name it "not assessed" in summary.

- [ ] **Step 3: Write Phase 0 RESOLVE**

Content requirements (ultra prose in the file):

- Mode detect: `$ARGUMENTS` contains URL → external; else local.
- Project resolve: `list_projects` → match registered alias by cwd (local) or by
  cloned/available checkout of the MR's repo (external; agent must have a local
  checkout — the index lives on a path). No match → STOP, print the
  register/index instruction. Never scan an unindexed repo.
- Freshness gate: external → `git fetch` target branch, index behind →
  incremental `index_codebase project=<alias>`; local → incremental reindex when
  uncommitted/unindexed edits matter for MAP (keyed off prime staleness banner).

- [ ] **Step 4: Write Phase 1 ACQUIRE**

- External: obtain unified diff + MR title/description/author through the
  session's MR-platform mechanism (CLI / platform MCP / http-client — whatever
  is configured; the skill does not name commands). No mechanism → STOP for
  external mode with "no MR-platform mechanism available", offer local mode on a
  checked-out branch instead.
- Local: `git diff <merge-base main..HEAD>` + uncommitted (`git diff HEAD`); on
  main → uncommitted only. Empty diff → STOP with explicit message.
- Capture MR description as review intent (feeds D6 invariants).

- [ ] **Step 5: Write Phase 2 MAP**

- Parse hunks → touched files + changed line ranges (new side).
- Per touched source file (cap 15; above → ask user to narrow):
  `find_symbol relativePath=<file> project=<alias>` → outline; intersect changed
  ranges with symbol spans → changed symbols + their chunk UUIDs + full overlay
  (`git.file.*`, `git.chunk.*`, `codegraph.*`).
- Output per file: `{file, changedSymbols[], chunkUUIDs[], overlay}` — the
  working set every Phase 3 dimension reads. Non-indexed touched files (new in
  MR, generated, docs) → listed with `overlay: none`, still eligible for D6.

- [ ] **Step 6: Format, lint, commit**

Run: `npx prettier --write .claude-plugin/tea-rags/skills/mr-review/SKILL.md`
then `mcp__markdownlint__lint_markdown` on it. Expected: clean except MD013
table rows.

```bash
git add .claude-plugin/tea-rags/skills/mr-review/SKILL.md
git commit -m "feat(dx): mr-review skill — frontmatter, rules, resolve/acquire/map phases (3ei0s)"
```

### Task 2: Phases 3–4 + references/dimension-playbook.md

**Files:**

- Create:
  `.claude-plugin/tea-rags/skills/mr-review/references/dimension-playbook.md`
- Modify: `.claude-plugin/tea-rags/skills/mr-review/SKILL.md` (Phase 3 + 4
  sections)

**Interfaces:**

- Consumes: Phase 2 working set shape from Task 1.
- Produces: finding shape
  `{dimension, file, line, severity, evidence, draft body}` consumed by Task 3's
  Phase 5.

- [ ] **Step 1: Write Phase 3 SCAN in SKILL.md**

Ultra prose: dimension table (7 rows, from spec) + rule "parallel blocks; full
per-dimension parameters live in references/dimension-playbook.md; codegraph
rows gated on prime `codegraph.symbols`; tests row follows tests-as-context
preflight". Call budget line: ≤30 tea-rags calls typical MR (≤15 files);
exceeded → narrow scope, never silently truncate coverage.

- [ ] **Step 2: Write references/dimension-playbook.md**

Per dimension, exact parameter block + severity mapping. Content (parameter
blocks byte-exact in the file):

**D1 blast-radius** (codegraph-gated):

```text
per changed symbol (cap 10):
  get_callers symbolId=<Class.method> project=<alias> limit=15
overlay read: codegraph.file.fanIn / transitiveImpact / isHub,
              codegraph.chunk.fanIn / pageRank (labels from prime)
severity: chunk.fanIn frequent+ OR file.isHub → major "hub edit" (cite caller
          list + fanIn label); else observation
```

**D2 shotgun-twins:**

```text
find_similar positiveIds=[<all changed chunk UUIDs, one batch>]
             project=<alias> limit=10 testFile=exclude
co-change evidence = twin file shares git.taskIds with a touched file
severity: similar + shared taskId + untouched in diff → major "usually changes
          together" (cite taskId + twin path); similarity alone → observation
```

**D3 fragile-zone** (zero extra calls — Phase 2 overlay):

```text
overlay read: git.file.bugFixRate / churnVolatility / recencyWeightedFreq,
              git.chunk.bugFixRate on changed chunks
severity: concerning+/erratic+/burst labels → major when paired with missing
          test update (D5 cross-ref), else minor "fragile zone — extra care"
```

**D4 silo-style:**

```text
trigger: git.file.blameDominantAuthorPct at silo/deep-silo label AND MR author
         (external) / git user (local) ≠ blameDominantAuthor
then:    semantic_search query=<changed symbol behavior>
           pathPattern=<same dir glob> rerank="proven" limit=5 project=<alias>
severity: minor — style/naming deviation from proven neighbors, cite the
          neighbor file:line pattern
```

**D5 tests:**

```text
1. tests-as-context tests-at-risk recipe (skill preflight decides DSL vs
   fallback)
2. coverage per changed symbol: find_symbol on mirrored test path first;
   else hybrid_search query=<symbols of ONE domain cluster> testFile="only"
   metaOnly=true limit=15 — one call per cluster, NEVER one batched call
   (BM25 crowding → fabricated "untested")
severity: no coverage + (D1 hub OR D3 fragile) → major "untested change in
          hub/fragile zone"; no coverage alone → minor; verdict only from the
          symbol's own cluster call
```

**D6 invariants:**

```text
concepts = changed symbol names + MR description nouns (cap 5 queries)
semantic_search query=<concept> documentation="only" limit=5 metaOnly=false
severity: diff contradicts documented behavior → major, cite doc path:line +
          the contradicted statement
```

**D7 cycles** (codegraph-gated):

```text
find_cycles scope=file pathPattern=<touched-dirs glob> project=<alias>
severity: cycle through a touched file whose diff adds the closing import →
          major; pre-existing cycle merely touched → observation
```

- [ ] **Step 3: Write Phase 4 CLASSIFY in SKILL.md**

- Dedup findings by file:line (keep highest severity).
- Cross-dimension overlap on same file/symbol → escalate one level (spec
  examples: fragile+blast-radius → major; D5 pairing rules above).
- Evidence filter pass: finding without citable signal label or code reference →
  dropped. Observations (non-posted class) survive only into the chat summary,
  never into the posting contract.
- Output: finding list in delivery-contract shape (Task 3).

- [ ] **Step 4: Format, lint, commit**

prettier + markdownlint on both files.

```bash
git add .claude-plugin/tea-rags/skills/mr-review/
git commit -m "feat(dx): mr-review scan dimensions + classify — playbook with exact call params (3ei0s)"
```

### Task 3: Phase 5 + references/delivery-contract.md

**Files:**

- Create:
  `.claude-plugin/tea-rags/skills/mr-review/references/delivery-contract.md`
- Modify: `.claude-plugin/tea-rags/skills/mr-review/SKILL.md` (Phase 5 section)

**Interfaces:**

- Consumes: finding shape from Task 2.
- Produces: the posted-comment contract (shape below) — the skill's external
  output format, referenced verbatim by SKILL.md.

- [ ] **Step 1: Write references/delivery-contract.md**

Contract shape (byte-exact block):

```text
comment := { file, line (new side), severity: "major"|"minor",
             body: evidence-citing text, signature }
summary := { verdict, counts by severity, dimensions run/skipped + why,
             observations list }
```

Conventions section: `[minor]` prefix rule; signature footer
`🤖 tea-rags mr-review agent` on every comment and summary; comment language
mirrors MR description language, default English; one inline comment per finding
at its file:line, one summary comment.

Delivery section: agent posts through whatever MR-platform mechanism the session
exposes (platform CLI, platform MCP server, http-client with configured token) —
the skill never names commands; several available → prefer the platform MCP
server; none → print the full contract in chat for manual posting and mark the
review delivered-locally.

Draft-gate section: render draft table (file:line, severity, one-line body per
finding) → ONE confirmation for the whole batch → post → report per-comment
posted/failed status. Failed posts → retry once, then surface in chat.

Degradation matrix — copy the six-row table from the spec verbatim.

- [ ] **Step 2: Write Phase 5 DELIVER in SKILL.md**

Ultra prose: local mode → chat report (findings by severity + observations +
dimensions-skipped notes); external mode → draft-gate flow per
references/delivery-contract.md. Never post without the gate; never claim posted
without per-comment status.

- [ ] **Step 3: Format, lint, commit**

prettier + markdownlint on both files.

```bash
git add .claude-plugin/tea-rags/skills/mr-review/
git commit -m "feat(dx): mr-review delivery contract + deliver phase — draft-gate, agent-side posting (3ei0s)"
```

### Task 4: Anti-patterns, compression pass, version bump, smoke test

**Files:**

- Modify: `.claude-plugin/tea-rags/skills/mr-review/SKILL.md` (Anti-patterns
  section + final compression pass)
- Modify: `.claude-plugin/tea-rags/.claude-plugin/plugin.json` (version)

**Interfaces:**

- Consumes: complete SKILL.md + references from Tasks 1–3.

- [ ] **Step 1: Write Anti-patterns section**

Minimum set (ultra prose):

- Posting without draft-gate → restart Phase 5.
- Comment without citable evidence → drop, don't soften.
- One batched hybrid_search for all clusters' test coverage → fabricated
  "untested"; stratify per domain cluster.
- Reviewing MR-branch state instead of diff-vs-indexed-base → skill reviews the
  diff; no MR-branch checkout, no per-MR reindex.
- Hardcoding platform commands (glab/gh) into comments or flow → delivery is the
  agent's mechanism, contract only.
- Claiming "no cycles" / "no hubs" with codegraph off → "not assessed".
- Skipping freshness gate → stale-index review misses recent base changes.

- [ ] **Step 2: Caveman compression pass**

Re-read SKILL.md body; compress remaining unhurried prose to `ultra` (strip
articles, filler, hedging). Verify description stays `full` with all quoted
triggers and every NOT-for boundary intact. Tables, parameter blocks, contract
shapes untouched.

- [ ] **Step 3: Bump plugin version**

Edit `.claude-plugin/tea-rags/.claude-plugin/plugin.json`:
`"version": "0.30.19"` → `"0.31.0"`. (If main moved the version past 0.30.19 by
merge time, bump minor from whatever HEAD has.)

- [ ] **Step 4: Smoke test — local mode on this worktree**

Execute the skill's flow manually against the current worktree (branch diff =
spec + plan + skill markdown):

Run phases 0–5 in local mode. Expected:

- Phase 0: mode=local, project resolves to `tea-rags`.
- Phase 1: non-empty diff (markdown files).
- Phase 2: touched files map with `overlay: none` for new files.
- Phase 3: codegraph dimensions report "not assessed" for markdown-only working
  set; tests dimension degrades per preflight; no fabricated findings.
- Phase 5: chat report renders with dimensions-skipped notes.

FAIL criteria: any dimension fakes a result on missing signals, or flow stops on
a degradation case the matrix says must continue.

- [ ] **Step 5: Final lint + commit**

prettier + markdownlint over the skill directory.

```bash
git add .claude-plugin/tea-rags/
git commit -m "feat(dx): mr-review anti-patterns, compression pass, plugin 0.31.0 (3ei0s)"
```

- [ ] **Step 6: Beads**

From the main checkout: close all four task beads with commit hashes as
evidence; epic `3ei0s` stays open until merge + this plan's completion note.

## Self-Review Notes

- Spec coverage: modes (T1 P0/P1, T3 P5), delivery contract (T3), 7 dimensions
  (T2), evidence filter (T1 rules + T2 P4), severity rules (T2 playbook + P4),
  review baseline / non-goals (T4 anti-patterns), degradation matrix (T3 copy
  - T4 smoke), versioning (T4). No uncovered spec section.
- No placeholders: every step carries its concrete content or exact command.
- Naming consistent: phase names, finding shape, contract shape identical across
  tasks.
