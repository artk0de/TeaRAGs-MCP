---
paths:
  - "plugins/**"
  - "scripts/gen-harness-*.ts"
---

# Skill Authoring — write once, run in three harnesses (navigator)

Navigator. Points at owning rules; copies none. Tags: [live] seen in a real run,
[static] read from docs/source/generator, [assumed] unverified.

## 1. Pipeline in one screen

| Step | Do                                                                                                                      |
| ---- | ----------------------------------------------------------------------------------------------------------------------- |
| 1    | Edit sources only: `plugins/<name>/**`, `scripts/gen-harness-*.ts`, `scripts/harness/*.ts`                              |
| 2    | `npm run gen:plugins` → `.claude-plugin/<name>/`, `harness/codex/`, `harness/cursor/`, marketplaces, `agent-context.ts` |
| 3    | Bump `plugins/<name>/.claude-plugin/plugin.json` (new file = minor, text = patch)                                       |
| 4    | Commit sources + generated together                                                                                     |
| 5    | Never hand-edit generated paths                                                                                         |

Not generated (hand-kept): `.claude-plugin/marketplace.json`,
`.claude-plugin/.benchmarks/*/evals.json` (eval cases).

| Rule                                      | Owns                                                                                                                        |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `.claude/rules/plugin-sources.md`         | Source vs generated paths, merge driver, generator-test properties                                                          |
| `.claude/rules/plugin-guidance-layers.md` | Which layer owns a fact: prime (state), tool schema (contract), resources+guides (reference/policy), core (always-on ≤3700) |
| `.claude/rules/plugin-versioning.md`      | Bump `plugin.json` per affected plugin on every `plugins/**` edit                                                           |
| `.claude/rules/caveman-compression.md`    | Skill description `full`, body `ultra`; output-format contracts never compressed                                            |

New knowledge → pick layer by `plugin-guidance-layers.md` first, then write the
skill text.

## 2. Harness matrix

| Feature                | Claude Code                                                                       | Codex                                                                                                                                                                                                                                                                                                          | Cursor                                                                                                                                                            |
| ---------------------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package dir            | `.claude-plugin/<name>/` verbatim copy of `plugins/<name>/` [static]              | `harness/codex/<name>/` [static]                                                                                                                                                                                                                                                                               | `harness/cursor/<name>/` [static]                                                                                                                                 |
| Plugin manifest        | `.claude-plugin/plugin.json` [static]                                             | `.codex-plugin/plugin.json`: `skills: "./skills/"`, `hooks` → `hooks/hooks.json` [live]                                                                                                                                                                                                                        | `.cursor-plugin/plugin.json`, default folders [static]                                                                                                            |
| Marketplace            | `.claude-plugin/marketplace.json` [static]                                        | `.agents/plugins/marketplace.json`, `source.path` `./harness/codex/<plugin>` [static]                                                                                                                                                                                                                          | `.cursor-plugin/marketplace.json`, git URL only in cursor-agent [static]                                                                                          |
| CLI version seen       | n/a                                                                               | codex-cli 0.162.1 [live]                                                                                                                                                                                                                                                                                       | cursor-agent 2026.10.22 (logged out) [static]                                                                                                                     |
| Skill invocation       | `/tea-rags:x`, `Skill(tea-rags:x)`, `dinopowers:x` [live]                         | `$x`; dinopowers wrappers `$dino-<s>`; superpowers `$<s>` [live]                                                                                                                                                                                                                                               | `/x`; wrappers `/dino-<s>`; superpowers `/<s>` [static]                                                                                                           |
| Skill frontmatter      | full (as authored) [static]                                                       | reduced to `name` + `description` [static]                                                                                                                                                                                                                                                                     | `name` (= folder) + `description` [static]                                                                                                                        |
| Description budget     | none known in repo [assumed]                                                      | all descriptions together 7000 chars (tea-rags), 5500 (dinopowers); Codex default list ~8000 [live]                                                                                                                                                                                                            | no budget known [assumed]                                                                                                                                         |
| SKILL.md size cap      | 21000 bytes; architecture-diagnostics 15000 (`skill-size-budgets.test.sh`) [live] | same source, same cap [static]                                                                                                                                                                                                                                                                                 | same source; rule files ≤500 lines per docs [static]                                                                                                              |
| Load-time `!` inlining | works [live]                                                                      | none; blocks dropped, skill must tell model to read file/resource [live]                                                                                                                                                                                                                                       | dropped like Codex [static]                                                                                                                                       |
| MCP resource read      | `ReadMcpResourceTool` on `tea-rags://` [live]                                     | `read_mcp_resource{server, uri}`; tool names bare (`mcp__tea-rags__x` → `x`) [static]                                                                                                                                                                                                                          | `FetchMcpResource` (observed name); terminal fallback `tea-rags resource "<uri>" --path "$PWD"` [assumed]                                                         |
| Core instructions      | `rules/core.md` via SessionStart hook + server `instructions` [static]            | `AGENTS.md` (generated `AGENTS.tea-rags.md`) + `tea-rags-core` skill; plugins cannot ship AGENTS.md [live]                                                                                                                                                                                                     | `rules/tea-rags-core.mdc`, `alwaysApply: true`, ≤4096 chars incl. wrapper [static]                                                                                |
| Core size              | `core.md` ≤ 3700 chars [static]                                                   | same; only ~first 16 body lines reliably honoured, top rules go first [live]                                                                                                                                                                                                                                   | same [static]                                                                                                                                                     |
| Hooks                  | `hooks/hooks.json`, `CLAUDE_PLUGIN_ROOT` [static]                                 | plugin `hooks/hooks.json`, `PLUGIN_ROOT`; PreToolUse + SessionStart + SubagentStart [live]                                                                                                                                                                                                                     | `sessionStart` only (`additional_context` ≤10000 chars); no `subagentStart`/`preCompact` injection [static]                                                       |
| Hook block             | PreToolUse exit 2 [assumed]                                                       | exit 2 + stderr reason blocks; reason reaches model; matcher regex on tool_name `^(Bash\|shell\|exec_command)$`; stdin JSON `tool_input.command` [live]                                                                                                                                                        | not available (no tool hooks shipped) [assumed]                                                                                                                   |
| Hook trust             | none [assumed]                                                                    | untrusted until reviewed in `/hooks`; eval uses `--dangerously-bypass-hook-trust` [live]                                                                                                                                                                                                                       | n/a [assumed]                                                                                                                                                     |
| Subagents              | `Agent` tool, SubagentStart hook injects block [static]                           | "spawn a subagent"; SubagentStart hook `additionalContext` [static]                                                                                                                                                                                                                                            | "spawn a subagent"; no injection hook [static]                                                                                                                    |
| Question tool          | `AskUserQuestion` [static]                                                        | "ask the user" [static]                                                                                                                                                                                                                                                                                        | "ask the user" [static]                                                                                                                                           |
| superpowers dep        | separate plugin [static]                                                          | not bundled; enabled remotely as `superpowers@openai-curated-remote`, no config.toml entry [live]                                                                                                                                                                                                              | not bundled; install per superpowers repo [static]                                                                                                                |
| File-read behaviour    | normal [assumed]                                                                  | batches reads (`cat a b`, python loops, heredocs), loses middle of long output → one file per command (`one-file-read.sh`) [live]                                                                                                                                                                              | unknown [assumed]                                                                                                                                                 |
| Live validation        | evals + hooks tests [live]                                                        | eval rounds on codex exec [live]                                                                                                                                                                                                                                                                               | static only; no local Cursor login [live]                                                                                                                         |
| Gen script transforms  | copy only (`gen-harness-claude.ts`)                                               | `gen-harness-codex.ts` + `scripts/harness/transform.ts`: drops `!` blocks, `ReadMcpResourceTool`→`read_mcp_resource`, `mcp__tea-rags__x`→`x`, `Skill(tea-rags:s)`/`/tea-rags:s`→`$s`, Agent→"spawn a subagent", `AskUserQuestion`→ask, `CLAUDE_PLUGIN_ROOT`→`PLUGIN_ROOT`, `CLAUDE_PROJECT_DIR`→`PWD` [static] | codex rules + `/<skill>`, `FetchMcpResource`, `CURSOR_PLUGIN_ROOT`, terminal fallback under every `tea-rags://` title; `rules/references/`→`references/` [static] |

## 3. Cross-harness best practices

Evidence = Codex eval round of plan Task 22 (`T22 r<round>`).

| #   | Practice                                                                                                                                                  | Evidence                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | Output contract sits next to the step that writes it. Give literal lines to copy with slots, not descriptions ("describing compliance is not compliance") | (T22 r5, r11, r19: literal lines / skeletons) |
| 2   | Exception rule sits beside the routing row it modifies, says replace vs extend. No competing routing layers                                               | (T22 r20: E9 routing table vs BREADTH)        |
| 3   | Plan-only answer still owes every output contract; `[planned; not run]` only for tool results not gathered                                                | (T22 r11, r18)                                |
| 4   | Mandatory reference read named at the decision point; distant "MANDATORY" link is skipped                                                                 | (T22 r5: mandatory opens)                     |
| 5   | One file per read command                                                                                                                                 | (T22 r17-r19; `one-file-read.sh`)             |
| 6   | Neutral examples only; never paste an eval case's input/answer into a skill                                                                               | (eval-5 contamination)                        |
| 7   | Raise a size cap when needed; never trim behaviour-carrying text to fit                                                                                   | (r20 regressions)                             |
| 8   | Eval graders grade by expectation text only; no "strictness reference" from past rounds                                                                   | (T22 r19: 6/16 → 11/16 on regrade)            |

## 4. Per-harness pitfalls

| Harness     | Pitfall                                                                                                                                                                           |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code | Source IS the Claude dialect; Codex/Cursor syntax in source breaks it. Load-time `!` works here only                                                                              |
| Claude Code | SKILL.md > 21000 bytes (15000 for architecture-diagnostics) fails `skill-size-budgets.test.sh`                                                                                    |
| Codex       | Skills list overflow (7000 / 5500) drops or shortens descriptions: new skill needs a short description                                                                            |
| Codex       | No `!` inlining: next to every `` !`…` `` line keep a plain "read file/resource X" instruction                                                                                    |
| Codex       | Core past ~16 body lines loses rules: top rules first, core ≤ 3700 chars                                                                                                          |
| Codex       | Multi-file `cat`/loops hide the middle: one file per command                                                                                                                      |
| Codex       | Plugin hooks inert until trusted in `/hooks`                                                                                                                                      |
| Cursor      | No subagent/preCompact injection: rules a subagent needs must live in the skill text                                                                                              |
| Cursor      | Resource tool name/availability only observed: keep terminal fallback                                                                                                             |
| Cursor      | Everything [static]; no live run since cursor-agent needs a logged-in account (`harness/cursor/LIVE-TEST.md`)                                                                     |
| All         | Skill names: Cursor requires `name` = folder; wrappers rename to `dino-<s>` in Codex/Cursor, so refer to skills via transformable forms (`dinopowers:<s>`, `Skill(tea-rags:<s>)`) |

## 5. Pre-commit checklist

```bash
npm run gen:plugins
bash tests/hooks/skill-size-budgets.test.sh
bash tests/hooks/skill-resource-refs.test.sh
bash tests/hooks/codex-one-file-read.test.sh
npx vitest run tests/scripts/gen-harness-codex.test.ts
```

- Plugin version bumped (`plugin-versioning.md`), then `gen:plugins` re-run.
- Edited md formatted (prettier).
- Affected Codex eval cases re-run (cases in
  `.claude-plugin/.benchmarks/*/evals.json`).
- Generated diff reviewed: Codex skills-list totals in `harness/codex/README.md`
  still under 7000 / 5500.

## Sources of truth

`harness/codex/README.md`, `harness/cursor/README.md`,
`harness/cursor/LIVE-TEST.md`, `harness/cursor/MANUAL-TEST.md`,
`scripts/gen-harness-{claude,codex,cursor}.ts`, `scripts/harness/transform.ts`,
`docs/superpowers/specs/2026-10-23-harness-facts.md`.
