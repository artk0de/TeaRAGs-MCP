---
title: Skills
sidebar_position: 1
---

# TeaRAGs Skills

TeaRAGs ships **agent skills** — ready-made playbooks that tell your agent
_when_ and _how_ to use trajectory signals. Instead of writing long system
prompts or manually composing rerank presets, you install the plugin and your
agent learns the workflow.

There are **6 user-invocable skills** grouped into 3 categories, plus 2 internal
strategies that are called automatically by `explore`.

## Investigation

### `/tea-rags:explore`

Unified code investigation. **Breadth-first discovery → depth-first tracing →
output shaped by intent** (human explanation or pre-generation context).

Use when the developer asks to explore, understand, explain, or investigate
code:

- _"how does X work"_, _"show me the architecture of Y"_, _"what does Z do"_
- _"where is X used"_, _"find all X"_, _"antipatterns in X"_, _"best example of
  X"_
- Pre-generation: _"before I code/change/modify/refactor X"_, _"what should I
  know before touching X"_, _"risks before refactoring X"_

Not for active bugs (use `bug-hunt`), not for standalone health scan without a
specific area (use `risk-assessment`).

### `/tea-rags:bug-hunt [symptom]`

**Signal-driven root cause investigation.** Developer describes the bug symptom
— the skill directs the search toward historically buggy code using chunk-level
`bugFixRate`, `churnVolatility`, and `burstActivity`.

No `git log` / `git blame` needed — the overlay carries git signals.

### `/tea-rags:risk-assessment [scope]`

**Multi-dimensional risk scan.** Uses `rank_chunks` with 4 rerank presets
(`hotspots`, `dangerous`, `techDebt`, `securityAudit`) cross-referenced by
overlap count. Returns the zones that need attention.

Scope can be a path, a domain name, or `"whole project"`. Semantic/hybrid search
resolves intent-based scopes before ranking.

Use when asked to evaluate risks, find problematic areas, or identify zones
needing attention. Not for specific bug symptoms — use `bug-hunt` instead.

## Generation

### `/tea-rags:data-driven-generation`

**Selects a generation strategy based on git signal labels from the target
area.** The skill reads overlay labels (`healthy`, `concerning`, `critical`,
etc.) — not hardcoded thresholds — so strategies adapt to each codebase
automatically.

Prerequisite: area context (files, pathPattern, overlay labels) must already
exist in the conversation. If missing, `explore` is invoked first to gather it.

## Index management

### `/tea-rags:index [path]`

**Smart indexing.** First time on a path → full index. Already indexed →
incremental reindex (only changed files). Called directly via the MCP tool, no
subagent.

### `/tea-rags:force-reindex [path]`

**Zero-downtime full re-index.** Builds a new versioned collection in the
background while search continues on the current one. Alias switches atomically
when done.

Requires **explicit user confirmation** — never invoked automatically, even when
index looks stale.

## Internal strategies

These are invoked automatically by `explore` when it detects a matching intent.
You don't call them directly, but it's useful to know they exist:

- **`pattern-search`** — find all implementations of a pattern across the
  codebase (`seed → expand → deduplicate → group`). Triggered when the intent is
  "find all X" or "where do we do Y".
- **`refactoring-scan`** — multi-preset breadth-first scan for refactoring
  candidates. Triggered when the intent is "what to refactor in X" or "cleanup
  Y" without a specific entity.

## Installation

Skills ship with the `tea-rags` Claude Code plugin. This plugin is
**Claude Code only** — it wraps MCP tools into slash-commands. Other MCP
clients (Cursor, Roo Code, Continue, …) can still talk to the `tea-rags`
MCP server directly, but won't have `/tea-rags:<skill>` commands.

:::warning Install the MCP server first
The skills plugin is the **final** step. Before installing it, make sure
the TeaRAGs MCP server is running (via `/tea-rags-setup:install` or a
manual install). See
[Quickstart → Installation](/quickstart/installation).
:::

Inside Claude Code, after the MCP server is set up:

```
/plugin marketplace add artk0de/TeaRAGs-MCP
/plugin install tea-rags@tea-rags
```

(If you installed via `/tea-rags-setup:install`, the marketplace is already
added — just run the `/plugin install` line.)

Restart Claude Code. Every skill is then registered automatically and your
agent can invoke them via `/tea-rags:<skill-name>`.

## Dinopowers — wrappers over `superpowers:*`

A separate plugin (`dinopowers`) ships 10 **wrapper skills** that run
tea-rags enrichment _before_ chaining to the underlying
[`superpowers:*`](https://github.com/anthropics/skills) skill. Instead of
`superpowers:brainstorming` starting with a blank slate, `dinopowers:brainstorming`
first queries tea-rags for the target area's hotspots / ownership / tech-debt
signals, then hands that context to `superpowers:brainstorming`.

### What ships

| Skill                                       | Wraps                                        | tea-rags tooling                                                                          |
| ------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `dinopowers:brainstorming`                  | `superpowers:brainstorming`                  | 3 parallel `semantic_search` with `hotspots` / `ownership` / `techDebt` presets           |
| `dinopowers:writing-plans`                  | `superpowers:writing-plans`                  | `semantic_search` with custom `{imports:0.5, churn:0.3, ownership:0.2}` on plan file list |
| `dinopowers:executing-plans`                | `superpowers:executing-plans`                | Per-Task pre-touch guard with SAFE / CAUTION / UNSAFE verdict                             |
| `dinopowers:systematic-debugging`           | `superpowers:systematic-debugging`           | Delegates to `tea-rags:bug-hunt` for ranked suspects                                      |
| `dinopowers:test-driven-development`        | `superpowers:test-driven-development`        | `semantic_search` with `testFile:"only"` + `rerank:"proven"`                              |
| `dinopowers:verification-before-completion` | `superpowers:verification-before-completion` | Collateral-damage scan: HIGH / MEDIUM / LOW-BLAST per edited file                         |
| `dinopowers:receiving-code-review`          | `superpowers:receiving-code-review`          | Impact analysis with AGREE-DIRECT / AGREE-WITH-SCOPE / PUSHBACK verdict                   |
| `dinopowers:requesting-code-review`         | `superpowers:requesting-code-review`         | Reviewer-context bundle (owners + contributors + taskIds + risk flags)                    |
| `dinopowers:finishing-a-development-branch` | `superpowers:finishing-a-development-branch` | Delegates to `tea-rags:risk-assessment` on full branch diff                               |
| `dinopowers:writing-skills`                 | `superpowers:writing-skills`                 | `semantic_search` on `**/SKILL.md` for structural patterns                                |

### How the enrichment flows

Every wrapper follows the same 4-step pattern:

1. **Extract intent/scope** from the user request (target area, file list, bug
   symptom, review target, branch scope)
2. **Call `mcp__tea-rags__*`** with calibrated parameters — correct tool,
   correct rerank preset or custom weights, correct `metaOnly`
3. **Extract a context block** from results — risk table, per-file impact,
   ranked suspects, reviewer bundle
4. **Invoke the underlying `superpowers:*` skill** with the block prepended

Plus a PreToolUse hook on the `Agent` tool that appends a wrapper-routing
table to every subagent prompt, so subagents don't bypass the enrichment layer
by invoking `superpowers:*` directly.

### Design principles

- **One project idiom for impact analysis** — wrappers that measure blast
  radius all use `{imports: 0.5, churn: 0.3, ownership: 0.2}` custom rerank.
  Shared idiom = cross-wrapper comparability.
- **Composition where the domain skill exists** —
  `dinopowers:systematic-debugging` delegates to `tea-rags:bug-hunt`;
  `finishing-a-development-branch` delegates to `tea-rags:risk-assessment`.
  Other wrappers call `mcp__tea-rags__semantic_search` directly.
- **Verdict before action** — `executing-plans` and `receiving-code-review`
  compute a verdict on signals (SAFE / CAUTION / UNSAFE, AGREE / PUSHBACK) and
  branch behavior. No silent downgrades.
- **Honest fallbacks** — empty index, new-only files, or out-of-scope intents
  fall through to the underlying skill with explicit `UNVERIFIABLE` /
  `TRIVIAL-SCOPE` / `PASS-THROUGH` notes, never fabricated signals.

### Installation

Dinopowers ships alongside `tea-rags` in the same marketplace. Install after
`tea-rags`:

```
/plugin install dinopowers@tea-rags
```

Requires `tea-rags` (MCP tools) to be installed and the codebase to be
indexed. Unindexed codebases fall through to the fallback paths.

### Eval results

Each wrapper was authored via `/optimize-skill` with parallel with-rule vs
without-rule baseline subagents. All 10 hit 100% with-rule on the first
iteration thanks to bootstrap via `dinopowers:writing-skills`. **Mean delta
+71pp across 136 eval cases.** See
`.claude-plugin/.benchmarks/dinopowers-*/benchmark.md` for per-skill results.

## See Also

- [MCP Tools Atlas](/usage/advanced/mcp-tools) — the 17 underlying tools skills
  compose
- [Rerank Presets](/usage/advanced/rerank-presets) — 15 presets the skills
  compose (`hotspots`, `dangerous`, `techDebt`, etc.)
- [Use Cases](/usage/use-cases) — real-world scenarios mapped to specific skill
  invocations
