# dinopowers

Wrapper skills over `superpowers:*` that inject tea-rags signals (risk,
ownership, churn, impact) into brainstorming, planning, execution, debugging,
review, and completion flows.

## What this plugin adds

10 wrapper skills that run tea-rags enrichment **before** chaining to the
underlying `superpowers:*` skill. Every wrapper:

1. Extracts an intent/scope from the user request
2. Calls `mcp__tea-rags__*` with calibrated parameters (correct tool, correct
   rerank, correct `metaOnly`)
3. Extracts a context block from results
4. Invokes the underlying `superpowers:*` skill with the block prepended

Plus a **PreToolUse hook on `Agent`** (`scripts/inject-wrapper-routing.sh`) that
appends a wrapper-routing table to every subagent prompt so subagents don't
bypass the enrichment layer.

## Wrapper skills

| Skill                                       | Wraps                                        | tea-rags tooling                                                                          |
| ------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `dinopowers:brainstorming`                  | `superpowers:brainstorming`                  | 3 parallel `semantic_search` with `hotspots`/`ownership`/`techDebt` presets               |
| `dinopowers:writing-plans`                  | `superpowers:writing-plans`                  | `semantic_search` with custom `{imports:0.5, churn:0.3, ownership:0.2}` on plan file list |
| `dinopowers:executing-plans`                | `superpowers:executing-plans`                | Per-Task pre-touch guard with SAFE/CAUTION/UNSAFE verdict                                 |
| `dinopowers:systematic-debugging`           | `superpowers:systematic-debugging`           | Delegates to `Skill(tea-rags:bug-hunt)` for ranked suspects                               |
| `dinopowers:test-driven-development`        | `superpowers:test-driven-development`        | `semantic_search` with `testFile:"only"` + `rerank:"proven"`                              |
| `dinopowers:verification-before-completion` | `superpowers:verification-before-completion` | Collateral-damage scan: HIGH/MEDIUM/LOW-BLAST per edited file                             |
| `dinopowers:receiving-code-review`          | `superpowers:receiving-code-review`          | Impact analysis with AGREE-DIRECT/AGREE-WITH-SCOPE/PUSHBACK verdict                       |
| `dinopowers:requesting-code-review`         | `superpowers:requesting-code-review`         | Reviewer-context bundle (owners + contributors + taskIds + risk flags)                    |
| `dinopowers:finishing-a-development-branch` | `superpowers:finishing-a-development-branch` | Delegates to `Skill(tea-rags:risk-assessment)` on full branch diff                        |
| `dinopowers:writing-skills`                 | `superpowers:writing-skills`                 | `semantic_search` on `**/SKILL.md` for structural patterns                                |

## Design principles

**One project idiom for impact analysis.** Every wrapper that measures blast
radius uses the same custom rerank weights:
`{imports: 0.5, churn: 0.3, ownership: 0.2}`. Established in
`tea-rags:data-driven-generation` Step 6. Deviation breaks cross-wrapper
comparability.

**Composition where the domain skill exists.** `dinopowers:systematic-debugging`
and `finishing-a-development-branch` don't reimplement risk scoring — they
delegate to `Skill(tea-rags:bug-hunt)` / `Skill(tea-rags:risk-assessment)` which
own the methodology (triage labels, PRESENT format, tier classification). Other
wrappers call `mcp__tea-rags__semantic_search` directly because no corresponding
tea-rags skill exists.

**Verdict before action.** Wrappers that gate execution (`executing-plans`,
`receiving-code-review`) compute a verdict on signals and branch behavior (SAFE
→ proceed; CAUTION → confirm; UNSAFE → pause). No silent downgrades.

**Honest fallbacks.** Every wrapper defines what happens when tea-rags can't
help: empty results → report `UNVERIFIABLE` / `TRIVIAL-SCOPE` / `no-area` and
invoke the underlying skill without fabricating signals.

**Subagent routing via hook, not skill.** The wrapper-routing table is injected
into every `Agent` tool invocation's `prompt` by a PreToolUse hook. Subagents
don't need to know which skills exist — the hook tells them.

## Eval methodology

Every skill shipped via `/optimize-skill` with parallel with-rule vs
without-rule baseline subagents. All 10 wrappers hit 100% with-rule pass rate on
first iteration thanks to bootstrap via `dinopowers:writing-skills`. See
`.claude-plugin/.benchmarks/dinopowers-*/benchmark.md` for per-skill results.

**Aggregate benchmark results:**

| Skill                          | Evals | With-rule | Baseline | Delta |
| ------------------------------ | ----- | --------- | -------- | ----- |
| writing-skills                 | 12    | 100%      | 25%      | +75pp |
| brainstorming                  | 13    | 100%      | 23%      | +77pp |
| writing-plans                  | 14    | 100%      | 29%      | +71pp |
| executing-plans                | 15    | 100%      | 53%      | +47pp |
| systematic-debugging           | 15    | 100%      | 27%      | +73pp |
| test-driven-development        | 15    | 100%      | 20%      | +80pp |
| verification-before-completion | 15    | 100%      | 13%      | +87pp |
| receiving-code-review          | 12    | 100%      | 33%      | +67pp |
| requesting-code-review         | 12    | 100%      | 25%      | +75pp |
| finishing-a-development-branch | 13    | 100%      | 38%      | +62pp |

**Mean delta: +71pp.** All wrappers tested across core-rule, parameters,
tool-selection, edge-cases, pressure-resistance, wrong-tool-pressure,
subagent-routing, and control cases.

## Dependencies

- `tea-rags` plugin — required. Provides the MCP tools
  (`mcp__tea-rags__semantic_search`, `bug-hunt`, `risk-assessment` skills) that
  wrappers invoke.
- Codebase must be indexed (`/tea-rags:index`) for enrichment to return signals.
  Unindexed codebases fall through to the `UNVERIFIABLE` / fallback paths.

## Versioning

Every commit that modifies `.claude-plugin/dinopowers/` bumps `plugin.json`
version per the project's plugin-versioning rule — minor bump for new
skills/rules, patch for text-only changes.
