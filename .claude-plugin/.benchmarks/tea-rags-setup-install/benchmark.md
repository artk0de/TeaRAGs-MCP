# Benchmark — `tea-rags-setup:install` (one-step install)

Behavioural eval for the one-step install skill that replaced the multi-step
wizard in tea-rags-setup 0.8.0 (bd tea-rags-mcp-hjbow.11). The skill now runs
detect → `.contextignore.local` → profile → `choose-model` → ONE plan → ONE
confirmation → apply → verify, always on a llama-server pool, and indexes in the
foreground.

## Files

- `prompts.json` — what the actor sees (21 cases; script outputs inlined as
  fixtures).
- `grading.json` — expected output, `not_expected`, assertions. Grader only;
  never shown to the actor.

Cases: 12 findings (changed behaviour) · 7 edges · 1 subagent · 1 control
(re-tune routes to `tune`). Changed behaviour covered: no question before the
plan, ignore before profile, model taken verbatim from `choose-model`, no
Ollama, no squash question, `Change model` pick is the confirmation, plugin
pinned `v<ver>` per harness, MCP without `env`, foreground indexing, `set-env`
for an existing alias, Node floor 22, rustc driver step, PowerShell 5.1 quoting,
project-level MCP duplicate, client upgrade + auto-update notice.

## Protocol

- Actor: an independent agent with the shipped plugin installed through its
  harness path (Claude Code marketplace pin, Codex `harness/codex`, Cursor
  `harness/cursor`), plan-only: describe the commands, do not execute them.
- Runs: ×3 per harness, executed by Codex (never by Claude). Record plugin
  version / commit, model, transcripts and per-case verdicts below.
- A failed case stays open; re-run it after a correction and keep the failed
  attempt.

## Results

| Run | Plugin | Harness / model | Pass | Notes   |
| --- | ------ | --------------- | ---- | ------- |
| —   | 0.8.0  | —               | —    | not run |

Status: **not run** — suite written 2026-11-02; Codex ×3 pending.

## Superseded

The previous 11-case suite (Step 9 register-before-index, "don't index during
setup", mcp-server-integrator) and the older `install/` suite (Ollama, ONNX,
Docker Qdrant, resume) graded the removed wizard and were deleted with this
rewrite. Their last recorded run: with-rule 11/11, without-rule 9/11 (+18 pp),
against the wizard's step files — not comparable with this suite.
