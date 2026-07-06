# Codegraph node-upsert overlap (cross-pass finalize) — design

**Date:** 2026-07-06 **Status:** approved (brainstorm) — pending plan **Area:**
`src/core/domains/trajectory/codegraph/symbols/provider.ts`,
`src/core/adapters/duckdb/client.ts` + `daemon/` (bulk node-upsert on
`GraphDbClient`), CLI progress channel `src/cli/index-progress/`

**Scope note:** overlap (hoist node-write behind embedding) and bulk-append
(batch the node-write) are delivered **together** — they share one code seam
(the eager flush in `acceptExtraction`); splitting would build a throwaway
per-file intermediate. The earlier "Phase 1 / Phase 2" split is superseded.

## Problem

On the full `--force` / `crossPass` indexing path, codegraph writes are entirely
deferred to a **post-embedding serial finalize**. Measured on taxdome: embedding
finishes at ~875s, git enrichment tail settles ~1002s, and the run does not end
until ~1878s — i.e. a **~876s post-git finalize** (half the run). That finalize
does, in order: node upsert (`drainInputSpill` → per-file
`graphDb.upsertSymbols` plus run-global merges), edge resolve
(`streamingResolveAndUpsert`), then SCC and PageRank
(`recomputeGraphMetricsStreaming`).

The **node-upsert** portion rides in that tail for no structural reason — it is
file-keyed and idempotent, so it could run **during embedding** (GPU-bound, CPU
idle) instead of after it. Edge resolve and SCC/PageRank genuinely cannot move
(they need the complete symbol table / whole graph) and remain the by-design
serial tail.

Today that tail is also **invisible** in the CLI: the progress UI shows the
embedding bar and the git-enrichment bars, then the codegraph node/edge/metric
work happens with no bar — a "dark" tail. Overlapping it must also surface it.

## Constraints (established, non-negotiable)

1. **DuckDB is single-writer, by architecture — parallel write connections are
   not a lever.** Writes serialize at three layers above row-MVCC:
   `DuckDbGraphClient.upsertFile`/`upsertSymbols` wrap every write in an
   in-process `serialize()` gate; the **default daemon path** proxies all writes
   over one socket to the daemon's single RW connection; DuckDB itself holds a
   process-exclusive file write-lock, a single WAL with serialized COMMIT, and a
   stop-the-world CHECKPOINT. The only intra-DuckDB parallelism is **morsel /
   intra-query** (`CODEGRAPH_DB_THREADS`) — reached by **bulkier single
   writes**, not by more connections. Therefore the addressable win is
   **temporal overlap** (hide the serial write behind embedding), and —
   separately — **bulk-append** (make each write cheaper). Not concurrency.

2. **Run-to-run reproducibility of run-global merges must be preserved.**
   `drainInputSpill` deliberately buffers all extractions and **sorts by
   `relPath`** before draining, so the order-dependent, last-write-wins
   run-global maps (`runAncestors` / `runReturnTypes` / `runDispatchTables` / …)
   and the resolve tally are deterministic regardless of file-completion order
   (bd `yl9tv`). The refactor must not perturb this.

## Row taxonomy (why only node-upsert can move)

Cross-file-ness is a property of **what the row is keyed by**:

| Group                               | Rows                                                                                                                                                                                                | Key                    | Order                                                                      |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | -------------------------------------------------------------------------- |
| **1 — file-keyed (disjoint)**       | `cg_symbols` (PK `rel_path,symbol_id`), `cg_symbols_files`, `cg_symbols_edges_*` (`source_*` in PK), `cg_symbols_inheritance` (incl. `source_rel_path`), `cg_ambiguous_fanout` (`source_symbol_id`) | source file            | **independent** — writing file A before/after file B yields the same table |
| **2 — project-global (aggregate)**  | `cg_run_stats` (`language,receiver_kind`), `cg_symbols_metrics` (`symbol_id`, fanIn/PageRank over whole graph), `cg_symbols_cycles` (SCC)                                                           | project-wide dimension | computed from all files / whole graph                                      |
| **3 — in-memory run-global merges** | `runAncestors` / `runReturnTypes` / `runDispatchTables` / `runInheritanceRows` / …                                                                                                                  | class FQ-name / symbol | **order-dependent** (last-write-wins)                                      |

Only **Group 1** is disjoint and order-independent — safe to write in
completion-order during embedding. Groups 2 and 3 must stay in the deterministic
finalize.

## The seam (verified in code)

`asExtractionSink().write(extraction)` (pass-1, `provider.ts` ~:752–884) already
runs Group-1 and Group-3 as **physically separate statements with no
entanglement**:

- **Half-A (Group 1, movable):** `symbolTable.upsertFile` (in-memory) →
  `graphDb.upsertSymbols(relPath, defs)` (**DuckDB node-write**) →
  `indexChunkSymbolsByLine` (in-memory line map). Idempotent, order-independent.
  Within Half-A the **only expensive part is `graphDb.upsertSymbols`** (daemon
  socket + `INSERT OR REPLACE` + PK-index maintenance); the two in-memory ops
  are microseconds.
- **Half-B (Group 3 + buffering, stays):** the `runAncestors`/`runReturnTypes`/
  `runDispatchTables`/… merges + append raw `FileExtraction` to the NDJSON
  spill.

On the cross-pass path today, `acceptExtraction` (during embedding) only appends
to the **input spill**; the whole of pass-1 (including Half-A) is deferred to
the worker-side `drainInputSpill` at finalize. Half-A rides the tail as a
free-rider.

**Thread-context caveat (drives the precise cut).** `acceptExtraction` runs on
the main instance during embedding; `drainInputSpill` is worker-side at
finalize. The in-memory `symbolTable` that pass-2 `resolveExtraction` reads must
exist **in the drain/resolve context**. Therefore the safe cut hoists **only the
durable `graphDb.upsertSymbols`** — it is daemon-routed and context-independent
(both contexts reach the same daemon connection) _and_ it is the expensive part.
The two in-memory Half-A ops (`symbolTable.upsertFile`,
`indexChunkSymbolsByLine`) **stay in the drain**, so the resolver's in-memory
table is still built in its own context exactly as today. Whether `accept` and
drain actually share one instance is a plan-time verification; hoisting only the
daemon write is correct either way.

## Design — overlap + bulk-append (one seam, delivered together)

Split pass-1 at the existing Half-A / Half-B seam, hoisting the **durable DuckDB
node-write only**, and issue that hoisted write in **batches** (bulk) rather
than per file:

- **Batched eager node-write, during-embedding (overlap + bulk in one).** As
  `FileExtraction`s arrive from the chunker (`acceptExtraction`, cross-pass),
  accumulate their symbol defs in a **bounded buffer** and flush a **bulk
  node-upsert** (`graphDb.upsertSymbolsBulk`, new) every N files / M symbols,
  plus a final flush when the embed window closes. Still append each raw
  extraction to the input spill for Half-B + pass-2. The node write thus runs
  while the GPU embeds (CPU-idle window) **and** pays one commit per batch
  (DB_THREADS parallelizes the multi-row insert) instead of N per-file
  `BEGIN…COMMIT` transactions. The bounded buffer keeps peak memory disciplined,
  mirroring the spill's memory contract.
- **Everything else stays in the sorted finalize drain.** `drainInputSpill`
  keeps buffering + sort-by-`relPath` and still runs the two **in-memory**
  Half-A ops (`symbolTable.upsertFile`, `indexChunkSymbolsByLine` — so the
  resolver's table is built in its own context) **plus** all of Half-B
  (run-global merges). It **skips the now-already-done durable node-write**
  (guarded so the durable write is not issued twice; any file the eager path did
  not cover is bulk-upserted at drain). Determinism of the run-global merges is
  untouched (the hoisted write is order-independent; Half-B still runs sorted).

**`GraphDbClient` bulk method.** Add `upsertSymbolsBulk(rows)` (multi-row
`INSERT OR REPLACE INTO cg_symbols`, reusing the existing
`insertOrIgnoreBatched` batching pattern) on both `DuckDbGraphClient` (direct)
and `DaemonGraphDbClient` (socket-proxied). `cg_symbols` PK is
`(rel_path, symbol_id)`, so cross-file rows never collide — a batch is pure
disjoint upsert. Per-file `upsertSymbols` stays for the incremental path
(unchanged).

**Mechanism choice — α-batched (eager inline, buffered) over β (background
drainer).** The eager flush lives inline in `acceptExtraction`, which becomes
`async` (currently sync `=> void`) — its single chunker-bridge caller awaits it.
β (keep `accept` cheap, run a concurrent Half-A drainer) buys nothing: `accept`
already does spill I/O, and batching already caps the added cost to one
daemon-socket bulk call per N files — no new concurrency primitive is warranted.

### CLI progress (required)

The eager node-upsert must **report progress into the CLI indexing UI** so the
overlap is observable instead of a dark tail. Reuse the existing enrichment
progress channel end-to-end — no new transport:

`EnrichmentProgressCallback` (coordinator) → worker `{type:"enrichment"}` IPC
(`providerKey`, `level`, `applied`, `total`, `totalFinal`) → supervisor
`eta.record` → renderer per-provider bar.

- Emit under `providerKey: "codegraph.symbols"` with a **new `level`** (e.g.
  `"symbols"` / `"nodes"`) distinct from the existing `file` / `chunk` levels.
- `applied` = cumulative count of files whose nodes have been bulk-upserted this
  run (advanced per flush batch); `total` = grand file count (same denominator
  the coordinator already tracks).
- The renderer shows a `codegraph.symbols` node bar **advancing concurrently
  with the embedding bar**. Under `DEBUG=1`, additionally log a per-flush
  `CODEGRAPH_NODES_FLUSH` line (batch size + cumulative), so a post-hoc log
  shows node-write progressing during embedding, separate from the
  `CODEGRAPH_PASS2_*` edge-resolve lines.

The exact wiring from the provider up to the coordinator `progressCb` is a plan
detail; the channel and its shape already exist.

## Further follow-ups (genuinely out of scope here)

- **Pass-2 edge-write bulking.** `streamingResolveAndUpsert` still issues
  per-file `graphDb.upsertFile` (edges) at finalize. Those writes could likewise
  be batched (resolve → buffer edges → bulk insert), shrinking the pass-2
  portion of the tail. Deferred: pass-2 is post-embedding (no overlap window),
  resolve is per-file-sequential against the full symbol table, and edge bulking
  is a separate seam from node bulking. Revisit after this change is measured.
- **SCC / PageRank.** By-design irreducible whole-graph serial tail — not
  addressable.

## Blast radius

- **In scope:** `provider.ts` (`acceptExtraction` → async + batched eager bulk
  node-write; `asExtractionSink`/`drainInputSpill` → skip the already-done
  durable write, keep in-memory ops + Half-B); **`GraphDbClient` — new
  `upsertSymbolsBulk`** on the interface + `DuckDbGraphClient` +
  `DaemonGraphDbClient` (hub, fanIn 76 — the widened blast radius the fold
  accepts); one chunker-bridge caller (await the now-async accept); the
  codegraph provider's progress-emit + a new enrichment `level`; renderer/ipc
  handling of that level.
- **Not touched:** `upsertFileImpl` / the edge-write path (per-file `upsertFile`
  stays). Per-file `upsertSymbols` stays for the incremental path. Run-global
  merge logic and the sort-by-`relPath` determinism invariant.

## Error handling

- A failed `upsertSymbolsBulk` during embedding surfaces the same typed error
  path as the current drain-time write; the run aborts rather than landing a
  partial graph, unchanged. A bulk batch is one transaction — a mid-batch
  failure rolls the whole batch back (no half-written batch), same
  all-or-nothing contract as the current per-file `BEGIN…COMMIT`.
- If the eager upsert is skipped (e.g. non-cross-pass / direct path), behavior
  is exactly today's — the split is a no-op on the incremental path, which
  already streams the node write per batch.
- A per-run guard (files whose nodes were eager-upserted) makes a double durable
  write (eager + drain) impossible; the drain issues `graphDb.upsertSymbols`
  only for files the eager path did not cover (e.g. any that arrived after the
  embed window closed), and always runs the in-memory ops + Half-B.

## Testing

- **Determinism invariant (business-logic, must hold):** an existing/added test
  asserts that a cross-pass run produces byte-identical run-global merge output
  (and resolve tally) regardless of file-completion order — the guarantee this
  change must not regress. The `codegraph cross-pass input-spill bridge (yl9tv)`
  test is the anchor.
- **Graph equality:** cross-pass full-index yields the same final `cg_symbols` /
  edges / metrics as before, only produced with the node-write batched +
  performed during embedding.
- **Bulk node-write correctness (new hub method):** `upsertSymbolsBulk` writes
  the same `cg_symbols` rows as N per-file `upsertSymbols` for the same defs
  (batched == unbatched); a duplicate `(rel_path, symbol_id)` within/across a
  batch resolves to `INSERT OR REPLACE` semantics; a batch that throws mid-write
  rolls back whole (no partial batch); daemon and direct clients agree. Bounded
  buffer flushes at the N / M threshold and on final flush.
- **Progress:** the worker emits `enrichment` events for
  `codegraph.symbols:<newlevel>` with monotonically increasing `applied` (per
  flush batch) during the embedding phase; supervisor/renderer render a
  concurrent bar; JSON mode unaffected.
- **No-op on incremental path:** direct/non-cross-pass path behavior unchanged.

## Out of scope

- Pass-2 edge-write bulking (see Further follow-ups — separate seam, no overlap
  window, revisit after measuring this change).
- Any change to SCC/PageRank (by-design irreducible tail).
- Any change to the git-enrichment tail.
