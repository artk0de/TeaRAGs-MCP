# Benchmark — `tea-rags-setup:tune` (re-tune)

Behavioural eval for the re-tune skill rewritten in tea-rags-setup 0.8.0 (bd
tea-rags-mcp-hjbow.11). Section A re-benches the managed llama-server pool
(instance count, `-np` slots), restarts it and writes the new endpoints to the
registry; section B runs `tea-rags tune` only for a provider the user chose
themselves (Ollama / ONNX). No suite existed for this skill before.

## Files

- `prompts.json` — what the actor sees (9 cases).
- `grading.json` — expected output, `not_expected`, assertions. Grader only.

Cases: 5 findings · 3 edges · 1 control (no install → routes to `install`).
Covered: bench → restart → `set-env EMBEDDING_BASE_URL`, the slot sweep stop
rule, no batch / concurrency pins (runtime tuner owns them), section B through
the registry, no Ollama switch, `tea-rags tune` rejects `llama-server`, dead
instance recovery, no hand-edited `-c` / `-b`.

## Protocol

Same as `../tea-rags-setup-install/benchmark.md`: independent actor on the
shipped plugin, plan-only, ×3 per harness, executed by Codex; failed cases stay
open and are re-run after a correction with the failed attempt kept.

## Results

| Run | Plugin | Harness / model | Pass | Notes   |
| --- | ------ | --------------- | ---- | ------- |
| —   | 0.8.0  | —               | —    | not run |

Status: **not run** — suite written 2026-11-02; Codex ×3 pending.
