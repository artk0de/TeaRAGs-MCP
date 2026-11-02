---
name: tune
description: >-
  Re-tune an existing TeaRAGs install: re-bench the llama-server pool (instance
  count, -np slots) and restart it, or run the pipeline/Qdrant benchmark for a
  user-chosen Ollama/ONNX provider; writes results into the project registry.
  Triggers on "indexing is slow", "tune performance", "benchmark my hardware",
  "tune llama-server slots", "поднастрой производительность". NOT for first-time
  install — use install.
argument-hint: "[project alias] [--slots]"
---

# TeaRAGs re-tune

Existing install only. Install flow never calls this skill. Registry = env
source of truth: results go through `tea-rags projects set-env`, never into an
MCP config `env` block.

## 0. Inputs

- `<alias>` = argument, else `tea-rags projects list` row whose path = cwd.
- `tea-rags projects info --name <alias>` → `EMBEDDING_PROVIDER`,
  `EMBEDDING_MODEL`, `EMBEDDING_BASE_URL`.
- `tea-rags llama-server status` → managed pools, instance liveness.

Provider `llama-server` → section A. `ollama` / `onnx` (user switched
themselves) → section B. Every command foreground, waited on (timeout ≥ 10 min).

## A. llama-server pool

Client batch size + concurrency = runtime tuner (hill-climb, persisted per
endpoint). Never write `EMBEDDING_BATCH_SIZE` / `EMBEDDING_CONCURRENCY` /
`EMBEDDING_TUNE_MIN_BATCH_SIZE` — a pin caps the climb.

1. Instance count, default slots: `tea-rags llama-server bench --model <model>`
   → texts/s per count + the count `--instances auto` picks.
2. Slots (`-np`), only on "tune slots" / `--slots`: repeat bench with
   `--slots 2`, `4`, `8`; stop when gain < 5% vs previous or launch fails / OOM;
   keep previous value. Typical optimum = 4 (default).
3. Restart pool with winners: `tea-rags llama-server stop --model <model>` →
   `tea-rags llama-server start --model <model> --instances <best count> [--slots <best>]`
   → `{ model, endpoints, instances, bench }`.
4. Ports are random each start → always
   `tea-rags projects set-env --name <alias> "EMBEDDING_BASE_URL=<endpoints joined with ,>"`.

Context invariant: `-c = slots × window`, `-b = -ub = window`, window from model
catalog. CLI derives them; never hand-edit. Window change = chunk size change =
`--force` reindex.

Summary, slots filled:

```text
Pool re-tuned — <alias>
Bench:     <count>: <texts/s>, … → <best count> instances
Slots:     <best> (-np)
Endpoints: <endpoints>
Registry:  EMBEDDING_BASE_URL updated
```

## B. Ollama / ONNX (user-chosen provider)

`tea-rags tune --project <alias> --provider <ollama|onnx> [--full]` — quick ~2–3
min, full ~10–15 min. Omit `--qdrant-url`: tune probes `http://localhost:6333`,
else spawns the embedded daemon on its own port.

Reads `tuned_environment_variables.env` (project root or cwd) → write every
`KEY=VALUE` with `tea-rags projects set-env --name <alias> KEY=VALUE …` → delete
the file. Report embedding / storage / deletion rates from its comment lines.

## Errors

- `tea-rags` missing → run the install skill.
- Pool instance dead in `status` → `stop` + `start` (step A3), then set-env.
- Qdrant unreachable with `--qdrant-url` passed → re-run without it.
- Tune timeout (> 10 min quick, > 20 min full) → stop it, keep current values.

## Do NOT

- Offer switching to Ollama; section B only serves a provider already chosen.
- Pass `llama-server` to `tea-rags tune` (accepts only `ollama|onnx`).
- Write an `env` block into any MCP config.
