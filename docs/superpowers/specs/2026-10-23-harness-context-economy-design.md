# Harness Context Economy — Design

Date: 2026-10-23. Base: `main` @ `9a9a9e4ad` (columnar response shape; plugins
tea-rags 0.44.14, dinopowers 0.22.7). Harnesses in scope: Claude Code, Codex
CLI, Gemini CLI, Cursor (IDE + cursor-agent). Out of scope: Copilot, Roo, Cline,
Windsurf.

## Problem

Measured at `59f8153` (2026-10-22), unchanged at `9a9a9e4ad` except the prime
thresholds table:

| Always-on item (Claude Code)                | Bytes                    | ≈ tokens |
| ------------------------------------------- | ------------------------ | -------- |
| Rules injection, 9 parts (3 files)          | 69,933                   | 17.5k    |
| `tea-rags prime` on taxdome                 | 12,191 → 2,000 delivered | 3.0k     |
| Skill frontmatter, 29 skills                | 18,622                   | 4.7k     |
| MCP server `instructions`                   | 0                        | 0        |
| Per subagent (tea-rags + dinopowers blocks) | 11,694                   | 2.9k     |
| Per prompt (dinopowers UserPromptSubmit)    | 1,673                    | 0.4k     |

Defects found on the way:

1. **PreCompact injection reaches nobody.** Claude Code adds hook stdout to the
   context only for SessionStart / UserPromptSubmit / UserPromptExpansion /
   PostModelSwitch; PreCompact supports `decision: block` only. SessionStart
   with `matcher: ""` already re-fires on `source: "compact"`. The PreCompact
   group costs 10 process spawns and a prime run per compaction for zero
   context.
2. **Prime overflows the 10,000-char hook cap on polyglot projects.** Above the
   cap Claude Code writes the output to a file and shows a 2,000-char preview.
   On taxdome the model never sees `Signal thresholds`, `Language capability`,
   `Codegraph resolve`; `tests-as-context` and `bug-hunt` always take their
   fallback branch.
3. **Subagent alias line silently missing.** `enforce-tearags-search.sh` calls
   `tea-rags project exist --repository`; the global install is a symlink to the
   repo and `build/` was compiled before `--repository` landed. Hooks follow
   HEAD, the CLI follows the last build — every contract drift between them is
   silent because hooks never fail.
4. **Resource listing noise.** `qdrant://collection/{name}` template enumerates
   every collection (46 rows on this machine).
5. **Three skill descriptions exceed the Agent Skills 1,024-char limit**
   (filter-building 1,585; architecture-diagnostics 1,203; analytics-rerank
   1,113).

## Harness facts (verified 2026-10-22)

|                                  | Claude Code                                             | Codex CLI                                                                      | Gemini CLI                                      | Cursor                                                       |
| -------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------ |
| Model reads MCP resources itself | yes (`ReadMcpResourceTool`)                             | yes (`list_mcp_resources`, `read_mcp_resource`, `list_mcp_resource_templates`) | yes (`list_mcp_resources`, `read_mcp_resource`) | cursor-agent: observed; IDE: observed, undocumented → verify |
| Server `instructions`            | yes, cut at 4,096 chars                                 | yes; first 512 chars self-contained                                            | appended to system instructions                 | undocumented                                                 |
| Context-injecting hooks          | SessionStart, SubagentStart; 10,000-char cap per string | SessionStart, SubagentStart; ~2,500-token cap                                  | SessionStart                                    | `sessionStart` fire-and-forget only                          |
| Skill load-time shell injection  | yes, `` !`cmd` ``                                       | no                                                                             | no (custom commands only, with confirmation)    | no                                                           |
| Always-on rules file             | CLAUDE.md / rules                                       | AGENTS.md                                                                      | GEMINI.md                                       | `.mdc alwaysApply`                                           |

Local Codex: codex-cli 0.162.1; plugins are `.codex-plugin/plugin.json` with
`skills: "./skills/"`; hooks and MCP servers live in `~/.codex/config.toml`.

## Decision

**Resources are the canonical on-demand channel; a CLI mirror delivers the same
text to hooks and skills.** No new MCP tools.

1. **One text, many transports.** Every on-demand document is an MCP resource
   rendered by one builder. `tea-rags resource <uri>` opens the in-process MCP
   session (`openInProcessMcpSession`) and calls `readResource` — same builder,
   same bytes. Hooks and skills shell out to it; models read the resource.
2. **URI scheme.**
   - Static: `tea-rags://guide/{topic}` — `core`, `navigation`, `decision-tree`,
     `freshness`, `degraded`, `filters`, `presets`, `signals`, `signal-labels`,
     `indexing`, `search-examples`, `language-capability`, `overview`.
     `tea-rags://schema/*` stays as aliases for one release.
   - Per project (resource templates): `tea-rags://project/{alias}/digest` (slim
     prime, ≤2,500 bytes) and
     `tea-rags://project/{alias}/metrics{?language,section}` (`thresholds`,
     `labelMap`, `capability`, `resolve`, `registry`).
3. **Layering.** `mcp` may import only `core/api/public`; `cli` may not import
   `mcp`. Digest/metrics formatters move from `src/cli/prime/` to
   `src/mcp/resources/project/`. `tea-rags prime` becomes a CLI wrapper: it
   reads the digest through the in-process session and appends CLI-only lines
   (update check, auto-update verdict). `--full` appends the metrics resource
   (today's output, for humans).
4. **Single source for prose.** Markdown under `.claude-plugin/tea-rags/rules/`
   stays the authoring surface: `core.md` (always-on) + `guides/*.md` (on
   demand). `scripts/gen-agent-context.ts` emits
   `src/mcp/resources/generated/agent-context.ts` (string constants: core
   - guides) so the published `build/` carries them. A drift-guard test fails
     when the generated file and the markdown disagree (precedent:
     `scripts/gen-language-compatibility.ts` + `drift-guard.test.ts`).
5. **Always-on core** (≤3,700 chars): addressing rule → tool routing table →
   three invariants (never Read after find_symbol; lag never licenses leaving
   tea-rags; empty `get_callers` under low resolve ≠ absence) → "read
   `tea-rags://guide/<topic>` when <trigger>" catalog → destructive-tools line.
   Delivered as server `instructions` (every harness that honours it) and as the
   first SessionStart part in Claude Code / Codex (belt and braces).
6. **Session digest.** SessionStart hook runs `tea-rags prime` (now slim, always
   under every cap). The core carries "no digest in context → read
   `tea-rags://project/<alias>/digest`" for harnesses whose hook cannot deliver.
7. **Compaction.** Delete the PreCompact group. SessionStart re-fires on
   `compact`.
8. **Subagents.** Block ≤3,000 bytes; still produced by the plugin hook (the
   block is plugin policy, not server state). dinopowers per-prompt routing
   moves to SessionStart (one injection, re-fired on compaction).
9. **Skills.** Dead weight out, body/references decomposition, data via
   resources. Claude Code skills whose need is unconditional and small inline it
   at load: `` !`tea-rags resource "<uri>" --path "$PWD" || true` ``. Every
   skill keeps a model-read trigger line for the other harnesses. Gate: full
   re-run of the eval suites under `.claude-plugin/.benchmarks/`.
10. **Codex harness.** Generated from the same sources: `.codex-plugin` package
    with transformed skills, AGENTS.md snippet carrying the core, `config.toml`
    fragments for `[mcp_servers.tea-rags]` and `[[hooks.SessionStart]]` /
    `[[hooks.SubagentStart]]`. Live-tested in the local Codex against the
    worktree build.

## Budgets (enforced by tests)

| Artifact                           | Cap                                                          |
| ---------------------------------- | ------------------------------------------------------------ |
| Server `instructions`              | ≤ 4,096 chars; first 512 self-contained                      |
| Injected rules core (all parts)    | ≤ 8,000 bytes, 1 part                                        |
| `tea-rags prime` / digest resource | ≤ 2,500 bytes target, test cap 9,000 on a 4-language fixture |
| Subagent block incl. alias line    | ≤ 3,000 bytes target, test cap 9,000                         |
| Skill description                  | ≤ 1,024 chars                                                |
| `resources/list` entries           | ≤ 20                                                         |

Expected effect (Claude Code): session start and every compaction ~24–25k →
~6.6k tokens; per subagent 2.9k → ≤1.3k; per prompt −0.4k; a skill needing
project metrics reads ≤5KB instead of `get_index_metrics` (42KB).

## Risks

- Model skips a guide read → wrong routing. Mitigation: explicit triggers in the
  core; eval suites re-run as the gate.
- Silent truncation (4,096 / 10,000 / Codex 2,500 tokens). Mitigation: size
  tests on generated artifacts.
- In-process digest differs from today's prime (registry env replay, Qdrant cold
  path). Mitigation: parity test on fixtures; prime keeps its Qdrant-cold and
  path-not-found outputs.
- Cursor IDE model-side resource read unproven — out of this epic's live test;
  manual check documented.
