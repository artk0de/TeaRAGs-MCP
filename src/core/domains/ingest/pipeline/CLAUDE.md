# domains/ingest/pipeline — scan → chunk → embed → store, with poison-pill isolation and worker pools

## Mechanics

- **A token-overflow poison pill is isolated by re-embedding ONE item at a time,
  and the handler then returns SUCCESS on purpose.** `ChunkPipeline`
  (chunk-pipeline.ts:348-361): `embedBatch` throws →
  `classifyEmbeddingQuarantinable` decides → non-quarantinable rethrows →
  quarantinable routes to `#isolateEmbeddingFailures` (:420-439), which
  re-embeds each item alone, calls `markFailed` per culprit (one write each, so
  distinct error codes survive), drops them, and RETURNS the survivor subset
  (early `return` at :359 when the batch is fully quarantined). Do NOT add a
  character-length threshold: the model limit is in TOKENS and the char↔token
  ratio collapses exactly on the poison case (code ≈3–4 chars/token,
  base64/minified ≈1), so any char cap either misses the poison or quarantines
  healthy files. Bisection (O(log n)) was considered and rejected as unneeded
  complexity on a rare path. Why: "returns success after a failure" reads as
  swallowed error handling; it is the mechanism that stops one bad chunk from
  aborting a whole index — the pool would otherwise retry a deterministic
  overflow and the rejection would bubble as `IndexingFailedError`.

## Gotchas

- **Chunker workers MUST be child processes — `worker_threads` corrupt
  `node-tree-sitter`.** `chunker/infra/pool.ts:71` hardcodes
  `new ProcessTransport(WORKER_PATH)`; the enrichment executor keeps
  `new ThreadTransport(...)` because it parses only residually. The addon is
  NAPI: its `.node` binary is dlopen'd once per PROCESS and its C++ file-scope
  statics are shared by every thread — separate `new Parser()` instances do NOT
  isolate it. Concurrent parses across threads yield a variable AST for the same
  file (non-deterministic Ruby call counts, jittering codegraph
  `resolveSuccessRate`) and crash the addon under load. WASM (`web-tree-sitter`)
  would isolate in-thread and was deferred, not dismissed. Why: raising
  `chunkerPoolSize` under a thread transport reintroduces silent
  non-deterministic chunking, and the suite cannot catch it —
  `tests/vitest.setup.ts` pins `CHUNKER_POOL_SIZE=1`, exactly the configuration
  that masks the corruption.
- **The graceful-shutdown message is a SHARED contract, load-bearing only for
  the thread transport.** Both `infra/thread-transport.ts:26-32` and
  `infra/process-transport.ts:32-45` implement the same two steps — `shutdown()`
  = unref + post `SHUTDOWN_MESSAGE`, `terminate()` = forceful fallback — and the
  ~2s grace-then-terminate lives ONCE in `WorkerDispatchPool#shutdown`
  (infra/worker-dispatch-pool.ts:225-232). The message matters for
  `ThreadTransport`: it lets the worker close its `parentPort` so tree-sitter's
  NAPI destructors run on the owning thread instead of crashing with libc++abi
  on a bare `terminate()`. `ProcessTransport` posts it for uniformity and would
  survive without it — process exit reclaims everything. Why: treating the two
  transports as deliberately divergent invites "restoring" an asymmetry that
  does not exist, and hides that the timeout lives in the pool, not the
  transport.
- **`BUILTIN_IGNORE_PATTERNS` works as blanket-ignore + negated allowlist, and
  directory patterns are matched against a trailing-slash probe.**
  ignore-defaults.ts:84-92 blanket-ignores `*.json` / `*.yaml` / `*.yml` and
  re-includes manifests (`!package.json`, `!tsconfig.json`, `!tsconfig.*.json`,
  `!*.config.json`, `!composer.json`, `!deno.json`); YAML has no allowlist by
  decision. Patterns load builtin → project ignore files → config patterns into
  ONE `ignore()` instance, last-match-wins, so `.contextignore` can go both
  directions (scanner.ts:42-71). `Scanner#walkDirectory` (scanner.ts:112-131)
  probes a directory as `<rel>/` before testing it, which is what lets a `!*/`
  re-include survive a `*` catch-all (kgjzq) — a keep-only whitelist works
  today. Why: any NEW pattern that can match a directory name must be checked
  against that probe. A pruned directory is skipped silently, with no error and
  no count, so the loss shows up only as missing files.

## See also

- `.claude/rules/chunker-hooks.md`, `.claude/rules/symbolid-convention.md`,
  `.claude/rules/deep-path-navigation.md`, `.claude/rules/typed-errors.md`
- `enrichment/CLAUDE.md`, `../CLAUDE.md`
