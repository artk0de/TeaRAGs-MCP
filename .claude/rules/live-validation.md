---
paths:
  - "src/**"
  - "tests/**"
  - "scripts/**"
---

# Live Validation from a Worktree (MANDATORY)

Several sessions work on this repo at once, each in its own worktree. The
machine-wide resources they share are the global `npm link`, the registered
corpora (their Qdrant collections and codegraph DuckDB files), and the CPU.
Validate against YOUR build without touching what the other sessions use.
`epic-completion-gate.md` owns WHAT to validate. This rule owns HOW to do it in
parallel.

## Run your own build, not the global binary

- **Tool calls.** Use `node build/cli/index.js call <tool> '<json params>'` from
  your worktree. It runs the real MCP server in-process against the current
  build: zod validation, defaults, error middleware and formatters. No
  `npm link`, no `/mcp reconnect`. `call --list` shows the registered tools. Use
  `mcp__tea-rags__*` only when the user has linked and reconnected for you,
  because it runs whatever build the global link points at.
- **Indexing.** Use `DEBUG=1 node build/cli/index.js index-codebase ...` from
  your worktree, never the bare `tea-rags`, which is the global link. Always
  pass `--json`, and pass `--languages <lang>` for a language-scoped change.
- **Build.** A bare `npm run build` is always safe. Relink (`npm link`) only
  when the user asks for MCP-side testing.
- **Background runs.** Read the `EXIT=` marker or the `--json` `outcome`, not
  the notification's exit code, which belongs to the trailing command.

## One heavy run per corpus at a time

- **Locking.** Before a reindex, `--force-enrichments` or an offline harness on
  a registered corpus, take the lock: `mkdir ~/.claude/heavy-measure.lock.d`,
  then write an `owner` file saying who holds it, what runs, and since when.
  Release it with `rm -rf` when done.
- **When the lock is held.** If `mkdir` fails, another session is measuring.
  Wait, or coordinate. Never run beside it: two runs on one corpus rewrite the
  same payload and DuckDB file, and both measurements become garbage.
- **Coordination.** `ListAgents` shows the live sessions. Agree the order with
  `SendMessage`: state the corpus, the command, its duration, and the language
  scope. Message the peer when you release the lock.
- **Scoping.** Scope by language (`--languages`) so your run does not replace
  another session's `cg_run_stats` rows. A scoped run also avoids code paths
  another session is diagnosing, for example a TS-only OOM when you run a
  Ruby-only recompute.
- **Auto-update.** Check
  `node build/cli/index.js auto-update status --project <alias>` before
  measuring. If it is enabled, the watcher can run inside your window (see
  `epic-completion-gate.md`).
- **Self-index experiments.** Prefer a worktree clone alias
  (`tea-rags-worktree-<name>`) over the shared `tea-rags` alias.

## Read-only checks may overlap; measurements may not

A `call` of a search or report tool only reads, so it may run while another
session holds the lock. It still reads whatever that run has written so far, so
do not compare numbers across a peer's write window.

## CPU load invalidates timing, and pre-commit too

With parallel agents, load average can exceed 100 on 12 cores. Then:

- A pre-commit or vitest run fails with `Hook timed out` / `Test timed out` /
  `Failed to start forks worker`. These are not test failures. Check `uptime`,
  wait until load drops below about 2× `ncpu`, and retry. Never raise timeouts
  or skip hooks.
- Wall-clock numbers (phase durations, resolve timing) measured under that load
  are not comparable. Record the load next to the number, or re-measure.
