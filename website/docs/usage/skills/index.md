---
title: Skills
sidebar_position: 1
---

# TeaRAGs Skills

TeaRAGs ships **agent skills** — ready-made playbooks that tell your agent
_when_ and _how_ to use trajectory signals. Instead of writing long system
prompts or manually composing rerank presets, you install the plugin and your
agent learns the workflow.

There are **9 user-invocable skills** grouped into 5 categories, plus 6 internal
skills that other skills call on your agent's behalf.

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

### `/tea-rags:architecture-diagnostics [scope]`

**Is the code laid out correctly?** A different question from
`risk-assessment`'s "is it dangerous to touch". The skill calls
`get_architecture_report` and reads the result root cause first: violations of
the Stable Dependencies Principle are judged on components, the unit Martin
defined it for: a module whose facade importers were measured, or otherwise a
plain directory. A stable component depending on a less stable one is grouped
by the unstable target, so one registry that names the features registering in
it shows up as one finding rather than one per feature. Every line carries its
evidence: both instabilities, the afferent and efferent file counts behind them,
the delta, the call weight, the directory relation and the file edges that
carry the dependency.

Dependencies the detector did not judge are counted, not hidden: a component
depending on one nested inside it is composition, and a component with too few
connections has no trustworthy instability. Scripts, spikes, benchmarks,
examples and fixtures are left out of the graph altogether. Requires codegraph.

## Generation

### `/tea-rags:data-driven-generation`

**Selects a generation strategy based on git signal labels from the target
area.** The skill reads overlay labels (`healthy`, `concerning`, `critical`,
etc.) — not hardcoded thresholds — so strategies adapt to each codebase
automatically.

Prerequisite: area context (files, pathPattern, overlay labels) must already
exist in the conversation. If missing, `explore` is invoked first to gather it.

## Review

### `/tea-rags:mr-review [MR/PR URL]`

**Signal-driven review of a merge request or a local branch.** The skill maps
the diff onto indexed symbols, then scans it along 7 dimensions:

| Dimension     | What it catches                                            |
| ------------- | ---------------------------------------------------------- |
| blast-radius  | Hidden coupling, edits to hub code with many callers       |
| shotgun-twins | Siblings that usually change with this code, left untouched |
| fragile-zone  | Edits in historically bug-prone, volatile code             |
| silo-style    | A non-owner editing code with one dominant author          |
| tests         | Scenarios put at risk, changes with no covering tests      |
| invariants    | The diff contradicting the project's docs or specs         |
| cycles        | A new import or call cycle introduced by the diff          |

Signals decide _what_ to flag; each comment states the fact in plain words
("30+ modules import this") and names a concrete fix. A finding the skill cannot
back with a signal value or a code reference is dropped, and one without an
actionable fix is kept as an observation instead of a comment. Output is capped
at 8 comments, 5 of them major.

- **No argument** → local mode: reviews the current branch against `main` plus
  uncommitted changes and reports in chat.
- **MR/PR URL** → external mode: fetches the diff through whatever MR-platform
  mechanism the session has (CLI, MCP server, or HTTP client), shows a draft
  table, and posts inline comments only after **one confirmation for the whole
  batch**. Style nits carry a `[minor]` prefix. The repository must be checked
  out and indexed locally.

Blast-radius and cycle checks use the call graph when `codegraph.symbols` is
enabled. Without it, cycles are reported as "not assessed" and callers are
found by name, which the comments call out as a lower bound.

Not for your own pre-merge flow (use `dinopowers:requesting-code-review`), not
for a health scan without a diff (use `risk-assessment`), not for debugging a
concrete failure (use `bug-hunt`).

## Issue reporting

### `/tea-rags:report-issue [error code, symptom, or 'quarantine']`

**Turns a TeaRAGs failure into a well-formed GitHub issue without creating
duplicates.** The skill collects bounded diagnostics (`tea-rags --version`,
`tea-rags doctor --json`, OS and Node version, the verbatim error code, message
and hint, `tea-rags doctor <project> --quarantine --json` for quarantined
files), then **searches existing issues first**. When a match exists it links
it and stops, suggesting a comment on the existing issue instead.

With no match, it composes the issue body and prints a pre-filled issue URL for
you to submit. If `gh` is installed and authenticated, it offers
`gh issue create` as a one-step alternative, run only after you confirm. Source
code never goes into the issue body, only diagnostics.

Not for configuration or setup errors whose hint already tells you the fix.

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

## Internal skills

These skills are not in the slash-command list. Your agent or another skill
invokes them when it detects a matching intent. You don't call them directly,
but knowing they exist explains what your agent does behind the scenes.

### Strategies of `explore`

- **`pattern-search`** — find all implementations of a pattern across the
  codebase (`seed → expand → deduplicate → group`). Triggered when the intent is
  "find all X" or "where do we do Y".
- **`refactoring-scan`** — multi-preset breadth-first scan for refactoring
  candidates. Triggered when the intent is "what to refactor in X" or "cleanup
  Y" without a specific entity.

### `extract-project-patterns`

**Finds battle-tested reference code to use as a template** for code your agent
is about to write or change. It searches in widening scopes: the target
subdomain (L1), then the broader domain (L2), then the whole project (L3). Each
level runs a `proven` rerank restricted to the `battleTested` filter preset,
widening to `production` code (and saying so) when nothing battle-tested
matches. A level is accepted when at least two results are low-churn, old and
bug-free by their overlay labels, or when one such result is a call-graph hub.
Recently written one-off code and code with a critical bug-fix rate are never
returned as templates.

The result carries the locality it was found at (`L1` / `L2` / `L3` / `none`),
which tells the caller how closely to follow it: an L1 template matches the
subdomain, while an L3 template shows a technique whose architectural fit still
needs checking. Called by `data-driven-generation`, `dinopowers:writing-plans`
and `dinopowers:executing-plans`. Requires git enrichment; without overlay
labels there is nothing to gate on and it returns no templates.

### `tests-as-context`

**Uses test scenarios and fixtures as context** for review, verification,
refactoring, debugging and TDD. It reads the DSL test chunks the chunker emits
(`chunkType: "test"` for scenarios, `chunkType: "test_setup"` for fixtures)
through five single-call recipes:

| Recipe                   | Answers                                                   |
| ------------------------ | --------------------------------------------------------- |
| `tests-at-risk`          | Which scenarios exercise the files being changed?         |
| `fixture-lookup`         | Is there already a fixture for this setup?                |
| `regression-archaeology` | When was the test for this behavior first added?          |
| `test-flakiness`         | Which test scenarios or test infrastructure are unstable? |
| `spec-extraction`        | What scenarios must this module satisfy (living docs)?    |

A preflight check runs first. When the index has no DSL test chunks (the
language has no AST test chunking, `.contextignore` excludes the tests, or the
project has none), the skill returns a SKIP verdict and the caller continues
without test context. Output never names a test runner, so it works across
languages. Called by the `dinopowers` wrappers for TDD, code review and
verification.

### `filter-building`

**Translates a scope into search filters.** Users rarely say "filter"; they say
"in the payments domain", "Ruby code", "Alice's recent work", "changed this
week", "for ticket RAGS-142" or "production code, not tests". The skill maps
each of these to the matching typed field (`language`, `testFile`,
`documentation`, `author`, `recentAuthor`, `contributor`, `taskId`,
`modifiedAfter` / `modifiedBefore`, `minAgeDays` / `maxAgeDays`,
`minCommitCount`, `fileExtension`, `chunkType`, `symbolId`), to picomatch
negation in `pathPattern` (`!**/vendor/**`), or to a named filter preset
(`filter: { presets: "production" }`).

It also covers how `level: "file" | "chunk"` sets both the filter scope and the
result granularity, and falls back to a raw Qdrant `must` / `should` /
`must_not` filter only for payload keys without a typed field. The raw key list
comes from the `tea-rags://schema/filters` resource, never from memory.

### `analytics-rerank`

**Picks a rerank preset or builds custom weights** for an analytics question:
ownership, tech debt, hotspots, code review of recent changes, security audit,
blast radius before a change. The decision tree is short: documentation
searches get the `documentationRelevance` preset automatically; otherwise use a
preset when one fits, and build `{ custom: { ... } }` weights when none does.
Preset and weight-key names come from the `tea-rags://schema/presets` and
`tea-rags://schema/signals` resources, generated from the running build.

The skill ships recipes for questions no single preset answers, for example
"Fragile Silo" (code that looks stable but breaks a lot and has one author):
`{ bugFix: 0.45, knowledgeSilo: 0.3, similarity: 0.15, churn: -0.1 }`.
Cross-preset health scans belong to `risk-assessment`, root-cause work to
`bug-hunt`, filter construction to `filter-building`.

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
[`superpowers:*`](https://github.com/obra/superpowers) skill (Jesse Vincent's
skills library for Claude Code — TDD, debugging, planning). Instead of
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
