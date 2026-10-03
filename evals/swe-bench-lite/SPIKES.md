# Spike findings (Task 1)

Date: 2026-10-03. Machine: Apple Silicon (arm64), 12 CPU, 18 GB RAM,
OrbStack Docker 29.4, Claude Code 2.1.287, tea-rags 1.45.1, swebench 5.0.2.

## S1 — auth isolation

- No `ANTHROPIC_API_KEY` on this machine, so `--bare` (API-key-only auth) is
  out. Isolation instead: an empty per-arm `CLAUDE_CONFIG_DIR` plus
  `--strict-mcp-config`.
- Verified: `claude -p` with an empty `CLAUDE_CONFIG_DIR` answers
  `"Not logged in · Please run /login"` — nothing from `~/.claude` leaks in.
- Subscription auth for the isolated dir: `claude setup-token` →
  `CLAUDE_CODE_OAUTH_TOKEN`, stored in `~/.config/swe-lite-ab/oauth-token`.
  Pending: the token run and the "no CLAUDE.md instructions" probe.
- The final `result` event carries `modelUsage` and `subagent_stats`.

## S2 — subagent usage in `result.usage`

Pending (needs the token). `USAGE_SOURCE = "sum"` stays the default: summing
`message.usage` per unique `message.id`, subagent events included, is correct
whichever way `result.usage` behaves.

## S3 — forward-seed index chain on standalone repositories

Corpus: `psf/requests`, standalone repos (`git init` + `git fetch <mirror>
<sha>`), A = v2.3.0 (3466 commits), B = v2.4.0 (3596 commits). In both,
`rev-list HEAD` equals `log --all`: no ref reaches a later commit.

| Run | Files | Chunks | Re-processed | Embedding | Total |
| --- | --- | --- | --- | --- | --- |
| A from scratch (first run, cold) | 74 | 762 | all | 46.3 s | 49.6 s |
| B2 from scratch (warm, control) | 75 | 803 | all | 29.9 s | 33.0 s |
| B seeded from A, then incremental | 75 | 812 | 40 files / 582 chunks | 8.3 s | 10.4 s |

- Seeded vs from-scratch on a warm embedder: 10.4 s vs 33.0 s (×3.2), on a
  hard diff (3.5 months, 130 commits, vendored urllib3/chardet bump).
- Cold-start variance is large (same work 35–50 % slower on the first run), so
  index time is reported descriptively, not as a compared metric.
- `worktree create <name> --from <src>` registers the clone as
  `<src>-worktree-<name>`, which grows along a chain past the 64-char registry
  cap. Workaround, verified: `projects unregister --name <that alias>` (keeps
  the collection), then `projects register --path <dir> --name <short>` — the
  collection name derives from the path, so the short alias binds the same
  clone (`swe-spike-b → code_67bdaeb0`). Re-registration drops sticky registry
  fields; harmless because every index run passes the embedding env.
- Muninn guard passed on the seeded clone; git + codegraph enrichment healthy.

Decision: `SEED_MODE = "worktree-create"` with re-registration (implemented in
`indexing.index_commands`).

## S4 — Docker evaluation

- swebench 5.x CLI: no `--namespace` / `--cache_level` / `--clean`; default
  dataset `SWE-bench/SWE-bench_Lite`; it does NOT pull images — a missing image
  fails the instance with `ImageNotFound`.
- Prebuilt images: `docker pull --platform linux/amd64
  swebench/sweb.eval.x86_64.<repo_with_1776>-<n>:latest` (2.7 GB for requests),
  run under Rosetta by OrbStack.
- Gold patch of `psf__requests-2317`: **resolved 1/1**, 0 errors. Wall time
  19 min for the one instance (patch applied 16:52:36, tests done 17:11:38) —
  requests' suite is network-bound and emulated. 100 pilot evaluations at
  `--max_workers 4` are hours, not minutes; `sb-cli` cloud evaluation stays the
  fallback if local throughput is too low.
- Report path: `<report_dir>/<model_name_or_path>.<run_id>.json` with a
  `resolved_ids` key.

Decision: `EVAL_BACKEND = "local"`; the harness must pre-pull each instance's
image before `run_evaluation`.
