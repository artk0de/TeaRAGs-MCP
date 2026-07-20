# extract-project-patterns Eval-Fix Wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix two correctness defects in the `extract-project-patterns`
locality-cascade recipe (lone-ideal-hub gate, Rails-aware L2 derivation) and
close the class-declaration blind spot in `data-driven-generation` Step 5 — all
recipe-level (SKILL.md) edits, zero `src/` changes.

**Architecture:** Three independent recipe edits discovered by a live eval run
against a Rails monolith. Verified fact shaping the plan: `rerank: "proven"`
responses already carry `payload.codegraph.symbols.file.isHub` (raw codegraph
block bypasses `overlayMask`), so the gate rule is computable from current
responses and `ProvenPreset` stays untouched. Final task live-validates gate
inputs on the Rails index.

**Tech Stack:** Markdown skill recipes (`.claude-plugin/tea-rags/skills/`),
tea-rags MCP tools (`find_symbol`, `semantic_search`) for validation,
markdownlint, beads.

## Global Constraints

- Skill bodies are caveman-compressed at `ultra`
  (`.claude/rules/caveman-compression.md`) — author edits compressed; never
  compress output-format contracts (code fences, field names, globs).
- Every commit touching `.claude-plugin/` bumps
  `.claude-plugin/tea-rags/.claude-plugin/plugin.json` patch version
  (`.claude/rules/plugin-versioning.md`). Baseline: `0.30.3`. Task 1 → `0.30.4`,
  Task 2 → `0.30.5`, Task 3 → `0.30.6`.
- Project docs/commits in English; commit headers ≤ 100 chars, conventional
  commits.
- Run `markdownlint` (MCP `mcp__markdownlint__lint_markdown`) on every edited
  `.md`; fix findings before commit.
- Worktree-only commits (`worktree-extract-patterns-eval-fixes`). NEVER merge to
  main, NEVER push — both user-gated.
- No `src/` edits anywhere in this plan. No reindex of any project.
- Beads: epic `tea-rags-mcp-q3vfy`; tasks 1-4 = `tea-rags-mcp-80kdq` →
  `tea-rags-mcp-9zi65` → `tea-rags-mcp-eyjom` → `tea-rags-mcp-d56vk` (dep
  chain); follow-ups `tea-rags-mcp-c6mq8`, `tea-rags-mcp-o88g5`.
  `bd update --status=in_progress` on start, `bd close` on commit.

---

### Task 1: Lone-ideal-hub gate rule

**Files:**

- Modify:
  `.claude-plugin/tea-rags/skills/extract-project-patterns/SKILL.md:63-68`
  (quality-gate list)
- Modify: `.claude-plugin/tea-rags/.claude-plugin/plugin.json` (version `0.30.3`
  → `0.30.4`)

**Interfaces:**

- Consumes: `payload.codegraph.symbols.file.isHub` — already present in
  `proven`-reranked responses (verified live 2026-07-21).
- Produces: gate semantics later tasks and eval fixtures rely on:
  `ideal_count ≥ 2` OR (`ideal_count == 1` AND lone ideal isHub) accepts a
  level; in the lone-ideal branch `templates[0]` is the lone ideal itself.

Why this rule: `ideal_count ≥ 2` is replication-proof and structurally
anti-local — L3 wins over L2 purely on denominator size (small subdomains can't
produce 2 ideals). `isHub` (fanIn > collection p95) is usage-proof: independent
corroboration stronger than a second non-hub ideal. Eval evidence: native-domain
`CreateAction` (ideal + isHub) lost L2 to a foreign-domain L3 template.

- [ ] **Step 1: Apply the gate edit**

In `.claude-plugin/tea-rags/skills/extract-project-patterns/SKILL.md`, replace:

```markdown
2. Apply quality gate over result overlay labels:
   - `ideal_count` = chunks where
     - `commitCount` label is `"low"` or `"typical"`, AND
     - `ageDays` label is `"old"` or `"legacy"`, AND
     - `bugFixRate` label is `"healthy"`
   - If `ideal_count ≥ 2` → return top result + locality annotation. Stop.
```

with:

```markdown
2. Apply quality gate over result overlay labels:
   - `ideal_count` = chunks where
     - `commitCount` label is `"low"` or `"typical"`, AND
     - `ageDays` label is `"old"` or `"legacy"`, AND
     - `bugFixRate` label is `"healthy"`
   - If `ideal_count ≥ 2` → return top result + locality annotation. Stop.
   - **Lone-ideal-hub**: `ideal_count == 1` AND lone ideal's
     `payload.codegraph.symbols.file.isHub == true` → level accepted,
     `templates[0]` = lone ideal itself (NOT top-by-score). Stop. Why: hub =
     usage-proof (fanIn > p95), corroborates single replication. No
     `codegraph.symbols` in payload → branch inert, normal fall-through.
```

- [ ] **Step 2: Bump plugin version**

In `.claude-plugin/tea-rags/.claude-plugin/plugin.json`: `"version": "0.30.3"` →
`"version": "0.30.4"`.

- [ ] **Step 3: Lint**

Run `mcp__markdownlint__lint_markdown` on the edited SKILL.md. Expected: no new
violations (fix any).

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/tea-rags/skills/extract-project-patterns/SKILL.md .claude-plugin/tea-rags/.claude-plugin/plugin.json
git commit -m "improve(dx): lone-ideal-hub accepts locality level in extract-project-patterns gate" \
  -m "Why: ideal_count>=2 is anti-local on small subdomains; isHub is usage-proof corroboration. Eval: native-domain CreateAction (ideal+isHub) lost L2 to foreign L3."
```

---

### Task 2: Semantic-segment L2 derivation (Rails-aware)

**Files:**

- Modify:
  `.claude-plugin/tea-rags/skills/extract-project-patterns/SKILL.md:40-53`
  (cascade block + L2 examples)
- Modify: `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md:77-80`
  (stale "first 2 segments" reference)
- Modify: `.claude-plugin/tea-rags/.claude-plugin/plugin.json` (version `0.30.4`
  → `0.30.5`)

**Interfaces:**

- Produces: L2 derivation invariant referenced by callers and eval fixtures: L2
  = infra prefix (kept in glob, not counted) + first semantic segment; semantic
  tail ≤ 1 segment → skip L2.

Why: "first 2 segments" worked only because tea-rags layout puts a marker
(`domains`) + domain in positions 1-2. On Rails, positions 1-2 are
`app/services` — both infrastructure — so L2 degenerates to the whole layer (≈
L3-within-layer). Behavior change flagged and approved: `chunker/hooks` now
yields a valid L2 (`**/chunker/**`) instead of skipping.

- [ ] **Step 1: Apply the derivation edit**

In `.claude-plugin/tea-rags/skills/extract-project-patterns/SKILL.md`, replace:

````markdown
```
L1 pathPattern = pathPatternL1                    (deepest subdomain)
L2 pathPattern = first 2 path segments of L1      (broader domain)
                 if L1 has ≤ 2 segments → L2 = L1, skip L2 step entirely
L3 pathPattern = null                             (project-wide)
```

**L2 derivation example.**

- L1 = `**/domains/trajectory/git/rerank/derived-signals/**` → segments
  `[domains, trajectory, git, rerank, derived-signals]` → L2 =
  `**/domains/trajectory/**`.
- L1 = `**/chunker/hooks/**` → segments `[chunker, hooks]` → L2 = L1, skip L2,
  jump to L3.
````

with:

````markdown
```
L1 pathPattern = pathPatternL1                         (deepest subdomain)
L2 pathPattern = infra prefix + first semantic segment (broader domain)
L3 pathPattern = null                                  (project-wide)
```

**L2 derivation.** Split L1 segments: leading run from skip-vocabulary = infra
prefix (NOT counted, KEPT in glob); rest = semantic tail. L2 = glob cut after
first semantic segment. Semantic tail ≤ 1 segment → L2 = L1, skip L2 step
entirely.

Skip-vocabulary (infra/layer prefixes): `app`, `src`, `lib`, `core`, `packages`,
`internal`, `domains`; Rails layers: `services`, `models`, `controllers`,
`jobs`, `workers`, `mailers`, `concerns`, `graphql`.

- L1 = `**/domains/trajectory/git/rerank/derived-signals/**` → prefix
  `[domains]`, semantic `[trajectory, git, rerank, derived-signals]` → L2 =
  `**/domains/trajectory/**`.
- L1 = `**/app/services/crm/accounts/**` → prefix `[app, services]`, semantic
  `[crm, accounts]` → L2 = `**/app/services/crm/**` (NOT `**/app/services/**` —
  layer-wide L2 = degenerate L3).
- L1 = `**/app/services/billing/**` → semantic `[billing]`, 1 segment → skip L2.
- L1 = `**/chunker/hooks/**` → no prefix, semantic `[chunker, hooks]` → L2 =
  `**/chunker/**`.
````

- [ ] **Step 2: Fix the stale caller reference**

In `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`, replace:

```markdown
Read `templates[0]` as reference for Step 4 (GENERATE). Recipe owns the locality
cascade (L1 = subdomain, L2 = first 2 segments, L3 = project) and the quality
gate (commitCount low/typical + ageDays old/legacy + bugFixRate healthy; reject
if bugFixRate critical or ageDays recent + commitCount low).
```

with:

```markdown
Read `templates[0]` as reference for Step 4 (GENERATE). Recipe owns the locality
cascade (L1 = subdomain, L2 = first semantic segment with infra prefixes
skipped, L3 = project) and the quality gate (commitCount low/typical + ageDays
old/legacy + bugFixRate healthy; lone ideal on hub file also accepts; reject if
bugFixRate critical or ageDays recent + commitCount low).
```

- [ ] **Step 3: Bump plugin version**

`"version": "0.30.4"` → `"version": "0.30.5"`.

- [ ] **Step 4: Lint**

Run `mcp__markdownlint__lint_markdown` on both edited SKILL.md files. Expected:
no new violations.

- [ ] **Step 5: Commit**

```bash
git add .claude-plugin/tea-rags/skills/extract-project-patterns/SKILL.md .claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md .claude-plugin/tea-rags/.claude-plugin/plugin.json
git commit -m "improve(dx): semantic-segment L2 derivation with infra-prefix skip (Rails-aware)" \
  -m "Why: 'first 2 segments' captures layer (app/services) not domain on Rails; L2 degenerated to layer-wide. chunker/hooks behavior change: valid L2 instead of skip (approved)."
```

---

### Task 3: Class-declaration Read check in data-driven-generation Step 5

**Files:**

- Modify:
  `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md:113-119` (Step
  5 list)
- Modify: `.claude-plugin/tea-rags/.claude-plugin/plugin.json` (version `0.30.5`
  → `0.30.6`)

**Interfaces:**

- Consumes: `templates[0].path` from Step 2 (TEMPLATE).
- Produces: Step 5 item 3 — declaration verification against the template file
  head. Placed in Step 5 (not Step 2) because Step 5 is NEVER skipped, so the
  check survives the Hotfix path.

Why: chunk headers carry `symbolId`/`name` but not `class X < Y` / `include Z` —
declarations are unrecoverable from index data. Long-term fix
(codegraph-surfaced class context in `find_symbol`) is a beads follow-up; this
Read is the sanctioned interim (declaration lines live OUTSIDE any chunk, so
search-cascade's no-re-read doctrine does not apply).

- [ ] **Step 1: Apply the Step 5 edit**

In `.claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md`, replace:

```markdown
### Step 5: VERIFY GENERATED

Verify ALL referenced identifiers:

1. find_symbol(metaOnly=true) for every function name, type name. ripgrep for
   import paths (find_symbol doesn't cover imports).
2. 0 results = hallucinated identifier → fix before committing.
```

with:

```markdown
### Step 5: VERIFY GENERATED

Verify ALL referenced identifiers:

1. find_symbol(metaOnly=true) for every function name, type name. ripgrep for
   import paths (find_symbol doesn't cover imports).
2. 0 results = hallucinated identifier → fix before committing.
3. Generated class declaration modeled on template (superclass / include / mixin
   / implements): chunk headers DON'T carry declarations — Read template file
   head (`templates[0].path`, declaration lines only, limit ~30) + verify
   generated declaration against real one. Wrong base class / missing include →
   fix before committing. Sanctioned Read: declaration lives OUTSIDE chunk.
```

- [ ] **Step 2: Bump plugin version**

`"version": "0.30.5"` → `"version": "0.30.6"`.

- [ ] **Step 3: Lint**

Run `mcp__markdownlint__lint_markdown` on the edited SKILL.md. Expected: no new
violations.

- [ ] **Step 4: Commit**

```bash
git add .claude-plugin/tea-rags/skills/data-driven-generation/SKILL.md .claude-plugin/tea-rags/.claude-plugin/plugin.json
git commit -m "improve(dx): template class-declaration Read check in data-driven-generation Step 5" \
  -m "Why: superclass/includes unrecoverable from chunk headers; Step 5 never skipped so check survives hotfix path. Long-term codegraph surface tracked in beads."
```

---

### Task 4: Live validation of gate inputs on the Rails index

**Files:** none (read-only MCP validation; outcome recorded as beads comment on
the epic).

**Interfaces:**

- Consumes: Task 1 gate semantics, Task 2 derivation rule.
- Produces: recorded evidence that (a) `proven`-reranked responses on the Rails
  index carry `codegraph.symbols.file.isHub` + gate labels, (b) new L2
  derivation yields a domain-scoped glob for the eval's failing case.

- [ ] **Step 1: Resolve Rails project alias**

Run `mcp__tea-rags__list_projects`. Expected: an alias for the Rails monolith
(taxdome). If absent → mark task blocked in beads with reason "Rails index
unavailable", stop task (plan remains valid; validation deferred).

- [ ] **Step 2: Fetch the eval subject**

Run `mcp__tea-rags__find_symbol` with `project=<alias>`,
`symbol="CreateAction"`, `rerank="proven"`, `metaOnly=true`, `limit=5`.

Expected: result whose payload has `git.file` labels (`commitCount` low/typical,
`ageDays` old/legacy, `bugFixRate` healthy) AND
`codegraph.symbols.file.isHub == true`.

Fallback if `CreateAction` missing/renamed: `mcp__tea-rags__semantic_search`
with `project=<alias>`, `query="service create action"`, `rerank="proven"`,
`isHub=true`, `pathPattern="**/app/services/**"`, `metaOnly=true`, `limit=5` —
any row with ideal labels + `isHub` proves gate inputs available.

- [ ] **Step 3: Walk the new rules on the fetched result**

Manually apply: (a) lone-ideal-hub gate → level accepted with `templates[0]` =
the ideal; (b) L2 derivation on its `relativePath` → expect
`**/app/services/<domain>/**`, NOT `**/app/services/**`.

- [ ] **Step 4: Record evidence**

```bash
bd comments add tea-rags-mcp-q3vfy "Task 4 validation: <alias> <symbol> isHub=<val>, labels=<...>, derived L2=<glob>. Gate + derivation verified live."
bd close tea-rags-mcp-d56vk
```

---

## Out of scope (beads follow-ups, created with the epic)

1. **Codegraph class-context in `find_symbol`** — surface superclass/includes
   from codegraph DB in tool responses; removes the Task 3 Read long-term.
   Labels: `api`, `dx`.
2. **Canon-drift check of template vs `.claude/rules/*`** — INFO-severity flags
   in `data-driven-generation` when the proven template drifts from declared
   canon. Labels: `dx`.
