# Benchmark: tea-rags plugin adapted to ZCode (harness/zcode)

**Date:** 2026-11-09 **Surface:** `scripts/gen-harness-zcode.ts` →
`harness/zcode/` (tea-rags, dinopowers, tea-rags-setup + marketplace), wired as
`npm run gen:harness-zcode` and into `npm run gen:plugins`; workspace MCP
connection `.zcode/config.json`. **Plugin version:** tea-rags 0.55.8 (source
unchanged — a new generated surface, no `plugins/` behavior edit). **Eval
cases:** imported from the Claude Code plugin benchmarks (search-cascade,
working-tree-injection, addressing-consistency, index-lag-overlay) + new
ZCode-delta cases. **Actor:** ZCode Agent-tool subagents (general-purpose),
model GLM-5.3 (the session's; one run per case per arm, owner-chosen),
dispatched from inside ZCode itself — the target harness.

## Summary

| Arm                           | Pass       | Rate | Notes                                                                                                                                                                          |
| ----------------------------- | ---------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Injection path (scripts)      | 5/5 probes | 100% | session-rules, session-digest, turn-routing, subagent-context (alias resolved live), search-drift deny on 3rd alternation — all emit ZCode-schema JSON with ZCode-shaped stdin |
| core-routing with-injection   | 8/8        | 100% | incl. controls ZA6/ZA7                                                                                                                                                         |
| subagent-block with-injection | 8/8        | 100% | incl. control ZB3                                                                                                                                                              |
| zcode-deltas with-injection   | 6/6        | 100% | incl. control ZC5                                                                                                                                                              |
| core-routing no-rule          | 7/8        | 88%  | ZA1 → Read (the canonical cascade gap)                                                                                                                                         |
| subagent-block no-rule        | 3/8 letter | 38%  | ZB4/ZB6 wrong tool (Read for understand/stale — the two gaps the block fixes); ZB1/ZB2/ZB5 right tool, no path addressing                                                      |
| zcode-deltas no-rule          | 4/6        | 67%  | ZC2 → WebFetch (no CLI fallback known), ZC4 → rg+Read (lag mistrust) — exactly the deltas the injection adds                                                                   |

**With-injection 22/22 (100%); controls held in every suite.** The no-rule arms
fail exactly where the repo's own benchmarks measured baseline gaps (doc-TOC
Read, stale-row trust, resource route unknown) — the delta pattern matches
search-cascade (+over Read), working-tree-injection (Read-understand,
treeState), index-lag-overlay (lag ≠ unusable).

## Harness facts the adaptation rests on (zcode.cjs bundle + zcode-guide plugin, 2026-11-09)

- Manifest `.zcode-plugin/plugin.json`; component fields `skills`, `hooks`,
  `mcpServers` (plugin `.mcp.json`); `agents` recorded but NOT executed → no
  agent-type shipping.
- Hook events: exactly seven — **no `SubagentStart`** (0 occurrences in
  zcode.cjs). Hook stdout is parsed as JSON under a strict schema → the Claude
  plugin's plain-text SessionStart output would be discarded; every prose
  payload is wrapped as `hookSpecificOutput.additionalContext` by generated
  scripts.
- `PreToolUse` supports `permissionDecision: "deny"` +
  `permissionDecisionReason` and `updatedInput`; `Task` ↔ `Agent` matcher
  aliases; `timeout` in seconds.
- MCP tools `mcp__<server>__<tool>`, server name normalized `[^a-zA-Z0-9_-]` →
  `_` (hyphens survive): `mcp__tea-rags__find_symbol` — matchers spell
  `tea[-_]rags`.
- No model-side MCP resource tool (`ReadMcpResource` absent) → the sources'
  inline `tea-rags resource <uri>` fallback is THE route; eval ZC2 covers it.
- Default sessions ship no Grep/Glob tool → `default code search tool` renders
  as `Bash rg`; eval ZC1 covers the channel.
- Subagent injection: rides `PreToolUse(Agent|Task)` additionalContext
  (`scripts/subagent-context.sh`). **Forwarding into the subagent's own context
  is UNVERIFIED in a live install** (Claude Code documents this exact channel
  for PreToolUse(Task); ZCode's runner accepts the payload — the bundle pushes
  PreToolUse `additionalContext` — but whether the spawned subagent sees it
  needs MANUAL-TEST.md check 6 after the UI install). The eval measures the
  block's steering effect when delivered, plus the script's output on the
  dispatch payload.
- Workspace config (`.zcode/config.json`) hooks did NOT hot-load into a running
  session (probe PreToolUse(Bash) logger never fired mid-session); config is
  read at session start. The MCP server connection lands the same way.

## Changes

| File                                      | Change                                                                                                                                                                                                               |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/gen-harness-zcode.ts`            | new generator: ZCode dialect (qualified `tea-rags:<s>` mentions, `Bash rg` search channel + folded literals, `Read tool`, `$PWD`, no-SubagentStart rewrites), 3 packages + `marketplace.json` + README + MANUAL-TEST |
| `harness/zcode/**`                        | generated (117 files, byte-stable)                                                                                                                                                                                   |
| `package.json`, `scripts/gen-plugins.ts`  | `gen:harness-zcode` wired                                                                                                                                                                                            |
| `tests/scripts/gen-harness-zcode.test.ts` | 17 tests: dialect, manifest fields, 7-events-only, hook→script wiring, verbatim scripts, core/block/routing artifacts, marketplace, dino- wrappers                                                                   |
| `.zcode/config.json`                      | workspace `mcp.servers.tea-rags` (mirror of `.mcp.json`: same node + env) — auto-connects at session start                                                                                                           |

Dialect deltas verified in artifacts: core.md renders `Bash rg` + folded
`Bash rg "<phrase>" <dir>`, "Alias: digest, the subagent dispatch hook or …",
resource fallback intact; turn-routing.txt ≤ 400 bytes (pinned by
`tests/hooks/turn-routing.test.sh`); subagent-block.txt route table complete vs
the Claude source (dialect-normalized identical).

## Method

optimize-skill Phase 2 paper-style tool selection, run INSIDE ZCode: six
independent Agent-tool subagents (3 suites × with-injection/no-rule), each reads
the byte-exact rendered artifact the shipped hook injects
(`workspace/snapshot/`, sha256 recorded) and an expectation-free case file, then
states its first tool call per case. No tools executed; cases, prompts and
expected answers separated (`evals.json` vs `workspace/cases-*.md`); transcripts
in `workspace/answers-*.md`. Contamination: the host session has no tea-rags
plugin installed (nothing injected beyond the study materials); actors carry the
END-OF-EVAL marker rule.

Grading-rule calibration (recorded in `evals.json.grading_notes` before
verdicts): ZB2/ZB5 accept the shipped block's caller route (find_symbol →
get_callers) beside the iteration-4 hybrid_search-metaOnly preference — the
current block text pins "every caller → get_callers + it", and does NOT mandate
hybrid_search for listings; strict letter of the 2026-10-02 iteration would
score those two as route-misses (open note below, not silent retries).

## Fix iteration — the 10 open FAILs closed by artifact pins (2026-11-09, user-requested)

The 10 open full-corpus failures were fixed the optimize-skill way — wording
pins in the shared sources, then re-runs with controls, failed attempts
retained:

| Case          | Pin (file)                                                                                                                                                          | Rerun                                                |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| R4            | core.md: an alternation of exact known identifiers is the usages row, never the concept row                                                                         | PASS (+ZA3/ZA6 controls)                             |
| S8            | dino-brainstorming: an area named inside the request phrase IS identifiable; pure conceptual = no code at all                                                       | PASS (+BR13 control: pure-conceptual still skips)    |
| S9            | dino-writing-plans: user-named files ARE the file list — guard directly, no batch read first                                                                        | PASS (+WP1)                                          |
| S10           | dino-executing-plans: the guard is the Task's first tea-rags call                                                                                                   | PASS                                                 |
| S11           | dino-tdd: Step 2a is always tests-as-context; hybrid_search has no test-only parameter                                                                              | PASS (+TDD1)                                         |
| S13           | mr-review: MAP always precedes the first review_changes/naming call                                                                                                 | PASS (phase order 0→1→2)                             |
| ddg eval-14   | data-driven-generation: a NAMED new area IS the area context — degrade TEMPLATE/STYLE, never STOP for explore                                                       | PASS (+cold-start control: STOP→explore still fires) |
| ddg seeded ×3 | case framing: the committed prompts left the paper actor cold at a mid-Step-7 state; the re-run states the category ("at Step 7, the gate just returned <finding>") | PASS (repair-file recipe + RE-REVIEW + GATE)         |

Versions: tea-rags 0.55.8→0.55.9, dinopowers 0.25.1→0.25.2 (all four harness
packages regenerated; 1305 tests green). The core pin grew the Codex core hook
past its cap — the cap was raised 9,686→9,765 per the standing owner rule (a
needed rule raises the cap rather than trimming rules). **Full corpus after
fixes: 474/474 (100%); before: 464/474.**

## tea-rags-setup from ZCode (2026-11-09)

The setup plugin now installs tea-rags INTO ZCode: `detect.mjs` returns
`harness: "zcode"` under ZCode's injected env (live-verified), and the install
skill's Step 5.7 gained the ZCode row —
`zcode plugins marketplace add "$(npm root -g)/tea-rags/harness/zcode"` →
`zcode plugins install tea-rags@tea-rags` (plugin ships the MCP server; the
package directory is the release-pinned marketplace `tea-rags update` refreshes;
bundled CLI path named for PATH-less desktops), with `.zcode/config.json` added
to the project-level-MCP-duplicate rule. tea-rags-setup 0.8.3→0.8.4.

Eval: 15 zcode-framed cases re-authored from the `tea-rags-setup-install`
benchmark's changed-behaviour list (its `prompts.json`/`grading.json` workspace
is gitignored and not on disk; the suite's own ×3 Codex runs remain pending —
this is the ZCode arm) — **15/15 PASS** (plan-only actor on the rendered
install+tune skills; transcripts `workspace/full-corpus/answers-setup-zcode.md`,
one answer language note: the actor replied in Chinese, graded on content).

## Full-corpus run (2026-11-09, user-requested complete coverage)

Every committed case list whose artifact ships in `harness/zcode` ran through
the same paper-style actor protocol: **474 cases, 464 PASS (97.9%), 10 FAIL
(open)** — 26 suites, one ZCode Agent-tool subagent each (GLM, one run per case,
with-injection). Not applicable, disclosed: wave1 cases 1–8 (`project:*`
commands — not shipped in any current plugin), and the seven benchmarks without
committed case lists plus coverage/facade (artifacts not shipped).

**The run caught a real adaptation defect.** The dinopowers package rendered
wrapper and superpowers mentions through the tea-rags prefix (`tea-rags:dino-X`,
`tea-rags:<superpowers-s>`) — nonexistent skill names (chaining attempt 1: all 8
answers in the wrong form). Fixed in `scripts/gen-harness-zcode.ts` — the
dinopowers package now ships BARE mentions (`dino-executing-plans`,
`writing-plans`), the codex semantics; regenerated (byte-stable, tests 17/17)
and re-verified: chaining 8/8, wave1 22/22, brainstorming 15/15 on the fixed
artifact. Attempt 1 retained in
`workspace/full-corpus/answers-dinopowers-chaining.md`.

**The 10 failures are actor-side route misses, not adaptation defects** (the
same texts are the Claude benchmarks' 100%-scored sources under opus): R4
(hybrid_search for an exact two-identifier alternation; the usages row
prescribes a literal sweep), S8/S9/S10 (wrapper first-step enrichment or
blastRadius guard skipped for a find_symbol read), S11 (fabricated
`hybrid_search` `testFile` param instead of the tests-as-context skill), S13
(mr-review MAP step skipped), ddg eval-14 + three step7-fix-seeded
(greenfield/unnamed-area framing — the actor applied the skill's own Step-1
explore rule where the case expected degradation or the Step-7 remedy). All
remain OPEN per the gate; transcripts in `workspace/full-corpus/answers-*.md`,
per-suite verdicts in `evals.json` (`suites[id=full-corpus]`).

Stale source expectations honored against the CURRENT artifact contract:
index-lag E13 (manual-read deny lifted by bd nxg76 — the current core's "руками
→ Read, no confirm" is what shipped and what the actor followed), E6/E3 wording
of the drift-ask. Suite-level notes (step-0-first in bug-hunt, MAP-first in
requesting/finishing, recipe-read before restructurePlan) recorded in the
transcripts.

## Update-system integration (2026-11-09)

`tea-rags update` — manual and the background auto-update alike — now also
brings the installed ZCode plugins to the client's release:
`src/cli/plugin-sync/zcode.ts` (`ZcodePluginSyncAdapter` + `zcodeCliRunner`)
wired into `syncHarnessPlugins` and `RunUpdateDeps` (4th harness, claude → codex
→ cursor → zcode).

- **Channel** — the real ZCode CLI (`zcode plugins …`, verified 0.17.0 inside
  the app bundle; also on PATH or `$TEA_RAGS_ZCODE_CLI`). No ref pinning exists
  on `marketplace add`, so the release guarantee is guard-based: refresh the
  marketplace, then update only when `installed < catalog ≤ client` — never past
  the client, never a downgrade; a failed refresh stops before trusting a stale
  catalog; a local marketplace that is not the package's own `harness/zcode`
  (realpath-compared, npm-link symlinks resolve) is a developer checkout and is
  skipped.
- **Live evidence** (this machine, restored after): no-op clean report when
  current; a real `0.55.8 → 0.56.0` update through the owned directory
  marketplace (plugin cache + install record verified, then downgraded back by
  hand — the adapter itself refuses downgrades); the /tmp marketplace correctly
  skipped as dev-marketplace. `zcode plugins update` re-reads a directory
  marketplace without an explicit refresh; the adapter refreshes anyway so
  github clones are current first.
- **Unit evidence** — `tests/cli/plugin-sync/zcode.test.ts` (13 tests: every
  guard above + runner candidate walk/cache/env override) and the updated wiring
  tests (order claude/codex/cursor/zcode; 604 cli tests green). Learning
  recorded: a real-spawn fallback in `syncHarnessPlugins` let tests hit the live
  app bundle (30 s hangs) — `runZcode` is a required dep now, like
  `runClaude`/`runCodex`.
- **Open (non-failing)** — github marketplaces track the default branch (no ref
  flag): a main-branch catalog ahead of the client yields a `failed` line per
  update run until the client catches up — honest and safe, but noisy; the
  documented install channel (the package's own directory) cannot overshoot.
  Restart prompt: ZCode applies an updated plugin after restart ("Restart zcode
  to apply").

## Verification observations

- **Package validation** — `plugin-creator`'s `validate-plugin.mjs` on
  `harness/zcode/tea-rags`: manifest, paths and name pattern clean; it flags 11
  "unresolved placeholders" — false positives: its regex
  (`<your[-_ ][^>]+>|TODO|FIXME`) hits the skills' deliberate prose
  metavariables (`path=<your working directory>`,
  `tea-rags://project/<alias>/…`) and TODO-scan routing prose, byte-identical to
  the evaluated Claude Code artifact.
- **MCP handshake** — the workspace `.zcode/config.json` command answered
  `initialize` correctly (serverInfo `tea-rags` 1.51.0, tools + resources
  capabilities, core-rules `instructions`) with the Qdrant host unreachable (LAN
  down at eval time): the server boots and serves stdio regardless; full tool
  function returns with the host. The same would hold for the Claude Code
  `.mcp.json` — the config mirrors it byte-for-byte in effect.
- **Injection-path probes** (ZCode-shaped stdin → schema-valid JSON):
  session-rules (9,555 B additionalContext), session-digest, turn-routing
  (UserPromptSubmit), subagent-context (PreToolUse, alias `tea-rags` resolved
  live from the repo cwd), search-drift deny (`permissionDecision: "deny"` on
  the 3rd alternation search, cooldown state file written under
  `--harness zcode`).

## Open (non-failing) limitations

- **Subagent-context forwarding UNVERIFIED live** — the PreToolUse(Agent)
  channel is designed and its output verified on a dispatch-shaped payload;
  whether the subagent's own context receives it needs the UI install
  (MANUAL-TEST.md check 6). Behavioral coverage measured the block's effect when
  delivered.
- **No live plugin install** — installation is a manual UI step (marketplace
  add + install); hook firing, MCP auto-connect and the deny UX are covered by
  MANUAL-TEST.md, not observed here. The workspace `.zcode/config.json` MCP
  connection takes effect next session start (verified against the documented
  config shape, not observed connecting).
- Listing-vs-impact route (ZB2/ZB5) is actor-dependent under the current block
  wording (both routes sanctioned); the opus-era hybrid_search-metaOnly
  preference is documented, not enforced — a shared-source wording pin would be
  a Claude-plugin change under its own benchmark.
- One run per case per arm (owner-respected run count); GLM actor, not opus —
  absolute rates are not comparable to the opus-scored rows in the root README
  table.
