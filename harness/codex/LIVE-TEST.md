# Codex live test — Task 14 (bd tea-rags-mcp-9lynw.14)

First live run of the generated package, 2026-11-10. Static regeneration state
at start: package 0.55.12 byte-identical to a fresh render
(`npm run gen:harness-codex`, zero git diff).

## Setup

- codex-cli **0.167.0** (README facts pinned 0.162.1 — flags used below all
  still exist), default model **gpt-6.1-sol** (recorded from the run JSON).
- Scratch `CODEX_HOME=/tmp/codex-home-tr`: copied
  `~/.codex/{auth.json, config.toml}`,
  `codex plugin marketplace add <repo root>` (manifest
  `.agents/plugins/marketplace.json`), `codex plugin add tea-rags@tea-rags`,
  installed `.mcp.json` switched to the dev build (`node <repo>/build/index.js`
  — no subcommand needed; it is the MCP entry), `AGENTS.tea-rags.md` →
  `$CODEX_HOME/AGENTS.md`.
- Build: `npm run build` on main (CLI 1.51.0, plugin 0.55.12).
- `codex exec --json --ephemeral --dangerously-bypass-hook-trust -C <repo>`
  (check 4 without `--ephemeral` so the rollout records hook context).
- Benign noise in every run: 2× "ignoring 5 unrecognized configuration settings"
  (user config.toml carries deprecated keys) and 2× the
  `--dangerously-bypass-hook-trust` notice.

## Scripted checks

1. **Resource read — PASS.** "Quote the first heading of
   tea-rags://guide/navigation" →
   `read_mcp_resource(server: "tea-rags", uri: "tea-rags://guide/navigation")`,
   answer quoted the heading text (blockquoted
   `> Navigation — result contracts and next steps`; resource's literal first
   line is `# Navigation — result contracts and next steps`). 56.5k input / 70
   output tokens.
2. **Addressing — PASS.** "Where is registerAllResources defined? Show its
   body." → `find_symbol {project, path, symbol}`; zero shell reads over `src/`;
   body from `src/mcp/resources/registry.ts:347`.
3. **Project metrics — PASS.** "ruby/typescript signal thresholds?" → two
   `read_mcp_resource` calls,
   `tea-rags://project/tea-rags/metrics?language= {ruby,typescript}&section=thresholds`;
   ruby correctly reported as "no per-language signal thresholds".
4. **SessionStart digest before the first model turn — PASS after one fix.**
   Rollout order: core hook → codex-rules hook → digest hook → user message →
   first model turn; UserPromptSubmit turn-routing fired on the turn.
   **Finding:** the first probe (package as shipped) showed
   `Warning: truncated output (original token count: 2508)` on the core hook —
   0.167.0 enforces the per-hook cap as ~2,500 **tokens** and elided ~50 tokens
   mid-core (research routing row fragment; full output parked in a temp file).
   The 9,765-char budget was char-measured on 0.162.1 and no longer holds. **Fix
   (same day):** `CODEX_READ_DISCIPLINE` moved from `core.txt` to the head of
   `codex-rules.txt` (per-hook cap; discipline stays at a truncation-safe head
   position), `CODEX_CORE_HOOK_BUDGET` 9,765 → 9,500. Sizes: core 10,032 B →
   9,619 B (≈2,400 tokens), codex-rules 6,241 B → 6,654 B. Re-run: all three
   payloads byte-identical to the package files, no elision markers.
5. **Skill trigger — PASS.** "Use the bug-hunt skill: why does prime print an
   empty digest when Qdrant is down?" → model opened `skills/bug-hunt/SKILL.md`
   (single-file `sed -n` reads, compliant with the one-file-read rule), then
   followed the skill: `git status`, incremental `index_codebase` (tree dirty
   with 2 local changes), `read_mcp_resource` metrics
   `section=thresholds,resolve`, three `semantic_search` variants (rerank
   bugHunt; uncommitted-files pathPattern; modifiedAfter window),
   `find_symbol(symbols:[…])` batches over `run-prime.ts`/`format.ts`/
   `runPrime`/`formatAgentDigest`, `guide/pagination` read, `find_similar`.
   Final answer traced `runPrime` → qdrant-cold → `formatAgentDigest` null
   status fallback: current checkout prints a minimal fallback digest, not a
   blank string.

## Carry-overs from Task 13

- `$PWD` in the SessionStart digest hook is the session directory: the digest
  titled `# tea-rags digest — tea-rags` (correct project for `-C <repo>`).
- `force-reindex` `run_in_background: true` (lines 52/57): reads as "dispatch a
  background subagent"; the flag name is Claude Code's, Codex spawning is
  freeform — acceptable, no live failure; a future dialect rule may reword it.
  Not exercised live (destructive; user-gated by design).

## Limitations

- One run per check, gpt-6.1-sol default; no A/B, no repetition (quota).
- Hooks exercised: 3× SessionStart, UserPromptSubmit turn-routing, one-file-read
  (compliant behavior observed; no deny path hit), search-drift (no deny hit —
  searches went through tea-rags MCP calls). reread-ledger: no indexed-source
  shell read happened to trigger a nudge.
- The Step 5 full eval run (~39 suites) is recorded separately in
  `.claude-plugin/.benchmarks/harness-context-economy/benchmark.md`.
