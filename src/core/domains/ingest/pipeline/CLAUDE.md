# domains/ingest/pipeline — scan → chunk → embed → store, with poison-pill isolation and worker pools

## Mechanics

- **A token-overflow poison pill is isolated by re-embedding ONE item at a time,
  and the handler then returns SUCCESS on purpose.** `ChunkPipeline`
  (`ChunkPipeline#createBatchHandler`): `embedBatch` throws →
  `classifyEmbeddingQuarantinable` decides → non-quarantinable rethrows →
  quarantinable routes to `ChunkPipeline#isolateEmbeddingFailures`, which
  bisects the failed batch (`ChunkPipeline#embedOrBisect` sends each half as one
  batch, recursing only into a half that fails), calls `markFailed` per
  single-item culprit (one write each, so distinct error codes survive), drops
  them, and RETURNS the survivor subset (early `return` in `createBatchHandler`
  when the batch is fully quarantined). Do NOT add a character-length threshold:
  the model limit is in TOKENS and the char↔token ratio collapses exactly on the
  poison case (code ≈3–4 chars/token, base64/minified ≈1), so any char cap
  either misses the poison or quarantines healthy files. Never go back to
  re-embedding item by item: the path is not rare — a taxdome incremental spent
  417s and 432s in two such loops on a local GPU, one of them for a batch-level
  400 that no single item reproduced (bd tea-rags-mcp-nu05a). Why: "returns
  success after a failure" reads as swallowed error handling; it is the
  mechanism that stops one bad chunk from aborting a whole index — the pool
  would otherwise retry a deterministic overflow and the rejection would bubble
  as `IndexingFailedError`.
- **The embed batch size and concurrency have ONE owner per run:
  `EmbeddingThroughputTuner`, and it hears about size failures the caller never
  sees.** `ChunkPipeline#applyThroughputDecision` sets the accumulator to the
  SMALLER of the tuner's size and `AdaptiveBatchSizer` (Qdrant yellow) and sets
  `WorkerPool#setConcurrency`. A provider that halves a failing batch internally
  still returns success, so the failure reaches the tuner only through
  `EmbeddingProvider.observeServerBatchFailures`, attached in
  `ChunkPipeline#start` and detached on shutdown; a quarantinable batch
  rejection whose bisection quarantines nothing is fed as a failure too. While
  an observer is attached `OllamaEmbeddings` keeps no run-long ceiling of its
  own — the tuner owns stickiness and recovery. `EMBEDDING_TUNE_STATIC` builds
  no tuner (`BaseIndexingPipeline#createThroughputTuner`), which restores the
  adapter's own ceiling. Why: two independent "sticky" sizes on one batch never
  recover together — the adapter's run-long cap silently undid every upward
  probe of the tuner.
- **The tuner keys on embedding IDENTITY and holds its concurrency climb while
  the producer starves.** `ChunkPipeline#currentEmbeddingEndpoint` builds the
  key from `getProviderName`, the endpoint a fan-out provider reports through
  `EmbeddingProvider.getThroughputTuneEndpointUrl` (the whole endpoint set, so a
  failure on one member stays on the set's state), and the model; the stored
  optimum uses the same key (`embeddingThroughputOptimumKey`), so a changed
  provider, model or endpoint set starts fresh.
  `ChunkPipeline#judgeProducerStarvation` marks a batch the formation timeout
  flushed below target (`Batch.flushTrigger`) while the worker pool had a free
  slot and nothing queued; once `PRODUCER_STARVED_BATCH_SHARE` of the tuner's
  window is starved, `EmbeddingThroughputTuner` holds the concurrency climb (no
  probe, no settle, logged once as `producer-starved`). The run's verdict
  (`ChunkPipeline#embeddingProducerStarvation`, debug step
  `EMBED_PRODUCER_STARVATION`) lands in the registry entry and surfaces as
  `infraHealth.embedding.producerStarvation`. Why: a starved window's aggregate
  chars/s measures the producer's gaps, not the server — judged on it the climb
  wanders or settles low and the stored optimum carries that to the next run (bd
  tea-rags-mcp-y1ynz).
- **The persisted optimum is the run's best AGGREGATE window, and a stored
  aggregate optimum is trusted outright.** `EmbeddingThroughputTuner` records
  every complete concurrency window not tainted by a starved batch or a server
  failure as a measured point; `EmbeddingThroughputTuner#settledOptima` returns
  the fastest one, reconciled with the stored record by
  `EmbeddingThroughputTuner#optimumToPersist` — and returns NOTHING for an
  endpoint the run measured nothing new on, so `BaseIndexingPipeline` writes no
  key and the record (and its `settledAt`) stays. The record is NOT the
  project's: `BaseIndexingPipeline#recordThroughputOptima` writes it, with the
  seed record the tuner judged it against, into the registry-level section every
  project shares, apart from the entry `record()` writes; the registry re-checks
  it against what another process may have landed meanwhile
  (`../../maintenance/registry/CLAUDE.md`, bd tea-rags-mcp-auoxk). A stored
  record with `measurement: "aggregate"` starts the run settled, with no probes;
  drift is handled only by the slowdown guard
  (`SETTLED_THROUGHPUT_SLOWDOWN_SHARE`) and the upward-only periodic re-probe.
  The rules are owned by the tuner's docblock. Why: persisting the first settle
  point stored concurrency 1 while the run had measured 4 at 160.8k chars/s, and
  every later run re-climbed from 1 (bd tea-rags-mcp-cyw2r); and the size
  climb's per-batch rate is not comparable with an aggregate one, so mixing them
  in the merge would let a per-call reading at concurrency 1 block an aggregate
  measurement.

## Gotchas

- **Chunker workers MUST be child processes — `worker_threads` corrupt
  `node-tree-sitter`.** `ChunkerPool#constructor` (`chunker/infra/pool.ts`)
  hardcodes `new ProcessTransport(WORKER_PATH)`; the enrichment executor keeps
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
  the thread transport.** Both `ThreadTransport#spawn` and
  `ProcessTransport#spawn` implement the same two steps — `shutdown()` = unref +
  post `SHUTDOWN_MESSAGE`, `terminate()` = forceful fallback — and the ~2s
  grace-then-terminate lives ONCE in `WorkerDispatchPool#shutdown`. The message
  matters for `ThreadTransport`: it lets the worker close its `parentPort` so
  tree-sitter's NAPI destructors run on the owning thread instead of crashing
  with libc++abi on a bare `terminate()`. `ProcessTransport` posts it for
  uniformity and would survive without it — process exit reclaims everything.
  Why: treating the two transports as deliberately divergent invites "restoring"
  an asymmetry that does not exist, and hides that the timeout lives in the
  pool, not the transport.
- **`BUILTIN_IGNORE_PATTERNS` works as blanket-ignore + negated allowlist, and
  directory patterns are matched against a trailing-slash probe.**
  `BUILTIN_IGNORE_PATTERNS` (`ignore-defaults.ts`) blanket-ignores `*.json` /
  `*.yaml` / `*.yml` and re-includes manifests (`!package.json`,
  `!tsconfig.json`, `!tsconfig.*.json`, `!*.config.json`, `!composer.json`,
  `!deno.json`); YAML has no allowlist by decision. Patterns load builtin →
  project ignore files → config patterns into ONE `ignore()` instance,
  last-match-wins, so `.contextignore` can go both directions
  (`FileScanner#loadIgnorePatterns`). `FileScanner#walkDirectory` probes a
  directory as `<rel>/` before testing it, which is what lets a `!*/` re-include
  survive a `*` catch-all (kgjzq) — a keep-only whitelist works today. Why: any
  NEW pattern that can match a directory name must be checked against that
  probe. A pruned directory is skipped silently, with no error and no count, so
  the loss shows up only as missing files.
- **A wire seam is ONE contract split across a process boundary — its halves
  co-change with NO import edge, and `get_architecture_report` silentCoupling
  pairs across the seam are by design.** The chunker worker protocol
  (`chunker/infra/worker-protocol.ts`: `WorkerRequest` / `WorkerResponse`) is
  the exemplar: the pool loads the worker by path (`ChunkerPool#constructor`'s
  `ProcessTransport(WORKER_PATH)`), the messages cross as structural clones, and
  no file in `src/` imports the protocol module at all — so the report sees its
  co-change with the language facade (`WorkerRequest.language` and the
  `emitExtraction` cross-pass extraction reuse reference the factory surface),
  with the codegraph provider that consumes `WorkerResponse.extraction`, and
  with the bootstrap wiring that injects `languageModulePath`. Membership
  contract, judge any reported pair by it: a pair belongs to the seam when one
  side reaches the other only by PATH (forked entry script, injected module
  path) or by structured-clone messages across a process boundary, or when one
  op surface is realized twice — an in-process client beside a daemon transport
  dispatching op-name strings to handlers. The codegraph DuckDB daemon
  (`adapters/duckdb/daemon/`) and the CLI index worker (`cli/index-progress/`)
  carry the same seam shape. Why: the graph cannot cross a process boundary and
  must not be "fixed" into crossing it — adding the missing import re-couples
  two transports the seam exists to keep apart, and the duplicated op surface is
  the price of process isolation for `node-tree-sitter`, not an oversight.

## See also

- `.claude/rules/chunker-hooks.md`, `.claude/rules/symbolid-convention.md`,
  `.claude/rules/deep-path-navigation.md`, `.claude/rules/typed-errors.md`
- `enrichment/CLAUDE.md`, `../CLAUDE.md`
