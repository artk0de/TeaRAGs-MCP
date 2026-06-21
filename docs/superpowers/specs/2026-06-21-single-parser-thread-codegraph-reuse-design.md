# Single Parser Thread + Codegraph Parse Reuse (yl9tv)

**Status:** Approved design — pending implementation plan. **Date:** 2026-06-21
**Beads:** yl9tv (root cause), svhqp (superseded symptom fixes), 93b0q / cnqrg
(unblocked by this).

## Problem

`node-tree-sitter` (the native NAPI addon) is **NOT thread-safe at process
scope**. The native library carries shared global state across ALL worker
threads — independent `new Parser()` instances do not isolate it. Concurrent
`parse()` calls from any two threads corrupt the parse tree.

Two production parse sites exist:

1. `chunker/tree-sitter.ts` — `TreeSitterChunker`, runs inside the **chunker
   pool worker threads** (default `chunkerPoolSize = 4`).
2. `codegraph/symbols/provider.ts:1511` — `extractOneFile`, runs in the **main
   thread** during enrichment.

Streaming enrichment overlaps the chunk pass (worker parses) with the enrichment
pass (main-thread codegraph parse). The concurrent native parses corrupt each
other's trees, so the Ruby walker emits a **non-deterministic call count per
file**.

### Evidence (measured this session, huginn / `code_d2c81d68`)

- Single-threaded isolation: `extractFromRubyFile` on `agents_controller.rb` =
  **469 calls, stable across 6 runs**. Raw tree-sitter node count
  (`totalNodes=1915, call=191`) and node positions are byte-identical across
  runs. The walker and the parser are individually deterministic.
- Main-thread-concurrent (3 worker parsers + main extract): **451–469**, plus a
  `Napi::Error` crash under load.
- **Worker-worker-concurrent (3 workers parse, main idle): each worker sees a
  wildly variable set (e.g. 213, 271, 333, 400, 465, 469)** — proves corruption
  is process-global, not main-vs-worker.
- Full reindex jitter: `callsAttempted` swung ±32% run-to-run (11886 → 15677),
  while `callsExternalSkipped` stayed exactly 861 (external calls resolve to
  null regardless of corruption, so only the internal-call count visibly jumps),
  `spillLines` / `dupLines=0` confirmed the dedup + spill are NOT the cause.

### Consequences

- The prior svhqp fixes (serialize batches, dedup extraction, reset runStats at
  run start) treated downstream symptoms — the jitter is born in the concurrent
  native parse, upstream of all of them. **svhqp is not actually closed.**
- The **chunker pool itself** (default 4 workers) is already producing
  non-deterministic parses in production. Chunk boundaries are robust enough
  that it has gone unnoticed; codegraph call extraction is the sensitive
  detector. Tests run `CHUNKER_POOL_SIZE=1`, masking it in CI.
- Blocks reliable before/after resolve-quality measurement (93b0q) and
  destabilizes the cnqrg per-language min-share breakdown (a language flickers
  in and out of the breakdown as the call-share denominator jitters).

## Goal

Establish a process-wide invariant: **tree-sitter `parse()` is invoked from at
most one thread at any instant.** Achieve it by (a) making the chunker worker
the single parse site and (b) reusing that one parse for both consumers — the
chunker already parses every file once; codegraph should consume a
`FileExtraction` derived from THAT parse instead of re-parsing in the main
thread.

This is the slice explicitly deferred at `provider.ts:1161` ("chunker pool
integration deferred until worker IPC supports passing FileExtraction back
across the boundary").

## Design

### Invariant

All tree-sitter parsing funnels through the chunker worker as a **single-flight
parser thread**. Everything else (embedding, git enrichment, codegraph resolve /
Tarjan SCC / PageRank, DuckDB upserts) stays parallel — the parser thread is a
producer feeding parallel consumers through the existing pipeline.

### One parse, two consumers

The worker parses each file once and, from that single `Tree`, produces BOTH:

- `chunks: CodeChunk[]` — the Qdrant payload (unchanged).
- `extraction: FileExtraction` — the codegraph extraction, via
  `languageFactory.create(lang).walker.walk({ tree, ... })`. The worker already
  holds the `LanguageFactory` (built in-thread from the injected
  `languageModulePath`), so the walker is already reachable.

To share one `Tree` between `chunk()` and `walk()` without re-walking, the parse
is hoisted to the worker level (or `TreeSitterChunker` exposes the parsed tree)
so both the chunk pass and the walker receive the same tree.

### Data flow

```
ChunkerPool (single-flight parse)
  WorkerRequest{ filePath, code, language, emitExtraction }
    └─ worker: parse ONCE
                 ├─ chunker.chunk(tree)    → chunks
                 └─ walker.walk(tree)      → FileExtraction   (emitExtraction only)
  WorkerResponse{ filePath, chunks, extraction? }
    └─ main: chunks     → Qdrant upsert (unchanged)
             extraction → appended to the codegraph NDJSON spill (O(1) heap)
codegraph finalize: reads spill → pass-1 symbol table → pass-2 resolve  (NO parse)
```

### Component changes (all additive on the 55-fanIn contract hub)

| Component                          | Change                                                                                                                                                                                                                      |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chunker/infra/worker-protocol.ts` | Add `WorkerRequest.emitExtraction?: boolean` and `WorkerResponse.extraction?: FileExtraction`. Additive only.                                                                                                               |
| `chunker/infra/worker.ts`          | Hoist parse; after `chunk()`, when `emitExtraction`, run `walker.walk` on the same tree and attach `extraction`. Correct the stale "tree-sitter native bindings are per-thread" comment (the corruption is process-global). |
| `chunker/infra/pool.ts`            | Enforce single-flight parsing. Update `chunkerPoolSize` default/semantics — see Open Decision.                                                                                                                              |
| Codegraph bridge (main)            | Route worker-returned `FileExtraction` into the codegraph spill instead of main-thread `extractOneFile`. In pool mode, `streamFileBatch` no longer parses.                                                                  |
| `codegraph/symbols/provider.ts`    | `extractOneFile` stays as the **direct-mode fallback** (tests, `buildFileSignals` standalone walk) — single-threaded, safe. Pool mode consumes the worker feed.                                                             |
| Exclusion gating                   | `SUPPORTED_EXTS` + `codegraphExclusionFilter` stay in the main thread — they decide whether to set `emitExtraction` on the request. Gating does NOT move into the worker.                                                   |

### Constraint resolutions

1. **Two-pass barrier / spill** — preserved. Worker `FileExtraction` is written
   to the same NDJSON spill; finalize reads it for pass-1 (symbol table) and
   pass-2 (resolve). O(1) heap is not regressed.
2. **Exclusion** — stays in main (flag on the request).
3. **Direct mode** — `extractOneFile` retained as a safe single-thread fallback;
   unit tests and the standalone `buildFileSignals` walk keep working unchanged.
4. **One parse, two consumers** — the worker shares one `Tree` between `chunk()`
   and `walk()`.
5. **Memory / throughput** — spill untouched. Parse serializes (see tradeoff).
6. **Contract hub** — additive fields only; no renames on `codegraph.ts`.

### Latent chunker bug

The same change closes the long-standing latent defect: at
`chunkerPoolSize > 1`, chunking parses concurrently and has been producing
non-deterministic chunk boundaries in production (masked by `pool=1` in CI). The
single-parser-thread invariant fixes both codegraph and chunking.

## Tradeoff (accepted)

Parsing serializes to one thread. At huginn scale this is imperceptible. At
taxdome scale (117k chunks) the parse phase may slow, but parse is CPU-cheap and
embedding (ollama) is the real throughput bottleneck; the single parser thread
pipelines with the parallel embedding / git / resolve consumers, so end-to-end
indexing throughput is expected to be largely unaffected. Accepted by the user.

## Open Decision (resolve in the plan)

**Single-flight mechanism:** either (a) reduce the chunker pool to one worker
(simplest — the worker only parses + chunks, so a 1-worker pool IS the dedicated
parser thread), or (b) keep a multi-worker pool for non-parse chunk
post-processing but gate the `parse()` critical section through a single-flight
lock / dedicated parse worker. Default to (a) unless the plan finds meaningful
non-parse work in the chunk worker worth parallelizing.

## Testing

- **Determinism regression:** index huginn 2× under multi-worker-equivalent
  load; `callsAttempted` must be stable (was ±32%).
- **Worker-emit equivalence:** the worker's `extraction` for a file equals the
  direct-mode `extractOneFile` output for the same file (single-thread
  baseline).
- **Concurrency invariant:** assert no two `parse()` calls overlap
  (single-flight counter / gate test).
- **Direct-mode fallback:** existing single-owner codegraph tests
  (`provider-spill*.test.ts`, `provider-defensive-paths.test.ts`,
  `provider-branch-paths.test.ts`) keep their examples; adapt only setup/imports
  per the refactor-migration test rule (preserve corner cases, validate
  `it`/`describe` counts ≥ base).

## Non-goals

- Replacing `node-tree-sitter` with `web-tree-sitter` (WASM, single-threaded) —
  larger migration, separate decision.
- Changing the resolver, walker call-extraction logic, or signal descriptors.
- cnqrg min-share denominator change — separate follow-up (downstream symptom).
