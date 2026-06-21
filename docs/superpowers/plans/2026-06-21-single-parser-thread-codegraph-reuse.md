# Single Parser Thread + Codegraph Parse Reuse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking. When a step would invoke
> `superpowers:test-driven-development` / `superpowers:executing-plans`, invoke
> the `dinopowers:` wrapper instead.

**Goal:** Make the chunker worker the single tree-sitter parse site and reuse
its one parse to emit the codegraph `FileExtraction`, eliminating the
main-thread re-parse so codegraph extraction (and chunking) is deterministic.

**Architecture:** node-tree-sitter is process-globally thread-unsafe. Today the
chunker pool (default 4 workers) parses concurrently with the main-thread
codegraph `extractOneFile`; concurrent native parses corrupt the tree (±32%
callsAttempted jitter, proven). Fix: the chunker worker parses each file ONCE
and emits BOTH the Qdrant chunks AND a codegraph `FileExtraction`; the chunk
pass tees that extraction straight into the codegraph NDJSON spill (O(1) heap
preserved); codegraph enrichment consumes pre-spilled extractions instead of
re-parsing. Parsing serializes to a single flight (chunker pool size 1).
`extractOneFile` is retained only as the direct-mode (test) fallback.

**Tech Stack:** TypeScript (ESM), node worker_threads, tree-sitter native
bindings, DuckDB (codegraph), Vitest.

## Spec refinement (discovered during planning)

The spec's "main writes extraction to spill" is realized as a **cross-pass
channel** because the chunk pass (`file-processor.ts` → `ChunkerPool`) and
codegraph enrichment (`enrichment/file-phase.ts` → `streamFileBatch`) are
decoupled and run on different drivers. Memory-safe realization (forced by the
O(1)-heap constraint — do NOT buffer all extractions in a Map):

- The codegraph run **spill is opened at index start** (not lazily at first
  enrichment batch).
- The **chunk pass tees** each worker `FileExtraction` to that spill as files
  are chunked (streaming to disk).
- `streamFileBatch` in pool mode becomes a no-op for parsing — the spill is
  already populated; `finalizeSignals` reads it for pass-1/pass-2 unchanged.
- `collectSymbols` (codegraph symbol-range collection, currently private to the
  provider) moves to a **worker-callable shared helper** so the worker can
  produce a complete `FileExtraction` (walker.walk needs the symbol-range
  `chunks`).

## Global Constraints

- **Additive only** on `src/core/contracts/types/codegraph.ts` (fanIn 55 hub) —
  no renames, no field removals.
- **Domain boundaries:** `domains/ingest` MUST NOT statically import
  `domains/language` or `domains/trajectory` — the worker loads language
  capability via the injected `languageModulePath` dynamic import only.
  `FileExtraction` lives in `contracts/` (ingest→contracts allowed).
- **Typed errors only** (`.claude/rules/typed-errors.md`) — no `throw new Error`
  except invariant violations.
- **No eslint-disable, no coverage-threshold lowering** (functions 97%,
  statements 96.2%).
- **Business-logic tests immutable:** moving/adapting setup+imports OK;
  rewriting examples NOT. For the single-owner codegraph tests
  (`provider-spill*.test.ts`, `provider-defensive-paths.test.ts`,
  `provider-branch-paths.test.ts`) preserve all `it`/`describe` examples;
  validate count ≥ base.
- **Conventional commits**, scope from `.claude/rules/commit-rules.md`
  (`feat(codegraph)`, `refactor(ingest)`, `fix(codegraph)`).
- **Acceptance criterion:** index huginn 2× under pool>1-equivalent load →
  `callsAttempted` stable (was ±32%).

---

## File Structure

| File                                                                | Responsibility                                           | Change                                                                                                         |
| ------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `src/core/contracts/types/codegraph.ts`                             | `FileExtraction` (exists), `ExtractionSink` (exists)     | none (reuse)                                                                                                   |
| `src/core/domains/ingest/pipeline/chunker/infra/worker-protocol.ts` | worker IPC types                                         | additive: `WorkerRequest.emitExtraction?`, `WorkerResponse.extraction?`                                        |
| `src/core/domains/language/<shared>/collect-symbols.ts` (new)       | codegraph symbol-range collection (was provider-private) | new shared helper, worker-callable                                                                             |
| `src/core/domains/ingest/pipeline/chunker/infra/worker.ts`          | worker entry                                             | run walker + collectSymbols on the one parse when `emitExtraction`                                             |
| `src/core/domains/ingest/pipeline/chunker/infra/pool.ts`            | chunker pool                                             | propagate `extraction`; single-flight (size 1)                                                                 |
| `src/core/domains/ingest/pipeline/file-processor.ts`                | per-file chunk loop                                      | capture `extraction`, tee to codegraph spill channel                                                           |
| `src/core/domains/trajectory/codegraph/symbols/provider.ts`         | codegraph provider                                       | accept pre-spilled extractions; `extractOneFile` becomes direct-mode fallback; consume shared `collectSymbols` |
| `src/bootstrap/config/schemas.ts` + `parse.ts`                      | chunker pool size default                                | set parse single-flight default + flag                                                                         |

---

## Task 1: Additive worker protocol — `emitExtraction` / `extraction`

**Files:**

- Modify: `src/core/domains/ingest/pipeline/chunker/infra/worker-protocol.ts`
- Test:
  `tests/core/domains/ingest/pipeline/chunker/infra/worker-protocol.test.ts`
  (create)

**Interfaces:**

- Produces:
  `WorkerRequest { filePath, code, language, emitExtraction?: boolean }`;
  `WorkerResponse { filePath, chunks, extraction?: FileExtraction, error? }`.

- [ ] **Step 1: Write the failing test** — assert the types accept the new
      optional fields (compile-time + a structural runtime round-trip through
      `structuredClone`).

```ts
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../../src/core/contracts/types/codegraph.js";
import type {
  WorkerRequest,
  WorkerResponse,
} from "../../../../../../../src/core/domains/ingest/pipeline/chunker/infra/worker-protocol.js";

describe("worker-protocol additive codegraph fields (yl9tv)", () => {
  it("WorkerRequest carries emitExtraction and round-trips via structuredClone", () => {
    const req: WorkerRequest = {
      filePath: "a.rb",
      code: "x",
      language: "ruby",
      emitExtraction: true,
    };
    expect(structuredClone(req).emitExtraction).toBe(true);
  });
  it("WorkerResponse carries an optional FileExtraction", () => {
    const ex: FileExtraction = {
      relPath: "a.rb",
      language: "ruby",
      imports: [],
      chunks: [],
      fileScope: [],
    };
    const res: WorkerResponse = {
      filePath: "a.rb",
      chunks: [],
      extraction: ex,
    };
    expect(structuredClone(res).extraction?.relPath).toBe("a.rb");
  });
});
```

- [ ] **Step 2: Run test to verify it fails** —
      `npx vitest run tests/core/domains/ingest/pipeline/chunker/infra/worker-protocol.test.ts`
      → FAIL (tsc: `emitExtraction`/`extraction` not on type).
- [ ] **Step 3: Add the fields** to `worker-protocol.ts`:

```ts
import type { FileExtraction } from "../../../../../contracts/types/codegraph.js";

export interface WorkerRequest {
  filePath: string;
  code: string;
  language: string;
  /** yl9tv — when true, the worker also runs the codegraph walker on the same
   *  parse and returns `extraction`. Off by default (chunk-only requests). */
  emitExtraction?: boolean;
}

export interface WorkerResponse {
  filePath: string;
  chunks: CodeChunk[];
  /** yl9tv — codegraph FileExtraction from the SAME parse, present iff the
   *  request set emitExtraction and the language has a walker. */
  extraction?: FileExtraction;
  error?: string;
}
```

- [ ] **Step 4: Run test to verify it passes** —
      `npx vitest run .../worker-protocol.test.ts` → PASS.
- [ ] **Step 5: Commit** —
      `git add ... && git commit -m "feat(chunker): additive worker-protocol codegraph extraction fields (yl9tv)"`

---

## Task 2: Extract `collectSymbols` into a worker-callable shared helper

**Why:** the worker must produce a full `FileExtraction`, which needs the
codegraph symbol-range `chunks` currently built by the provider-private
`CodegraphEnrichmentProvider#collectSymbols` (uses `SymbolIdComposer` + walker
`nameOf`). The worker already has a `SymbolIdComposer`
(`DefaultSymbolIdComposer`) and the `walker`. Move the pure logic to
`domains/language` (leaf domain, worker-importable via the injected path).

**Files:**

- Create: `src/core/domains/language/kernel/collect-symbols.ts`
- Modify: `src/core/domains/language/index.ts` (export it)
- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` (delegate
  `collectSymbols` to the shared fn — relocation, behavior identical)
- Test: `tests/core/domains/language/kernel/collect-symbols.test.ts` (create)

**Interfaces:**

- Produces:
  `collectSymbols(tree: Parser.Tree, nameOf, separator: string, disambiguateOverloads: boolean, composer: SymbolIdComposer): { symbolId: string; startLine: number; endLine: number; scope: string[] }[]`.
- Consumes: existing `joinSymbol`/`SymbolIdComposer` from
  `domains/language/kernel`.

> **Relocation rule:** this is a refactor-migration (move, not rewrite). Step 1
> relocates the function and points the provider at it; provider behavior is
> unchanged. Existing provider tests must stay green BEFORE adding the new unit
> test.

- [ ] **Step 1: Relocate** the body of
      `CodegraphEnrichmentProvider#collectSymbols` (provider.ts ~1597–1670,
      including the `joinSymbol`/`syntheticConstructorIfMissing` logic) into
      `collectSymbols.ts` as a pure exported function taking `composer` as a
      param. Replace the provider method body with a one-line delegation:
      `return collectSymbols(tree, nameOf, separator, disambiguateOverloads, this.deps.composer);`
- [ ] **Step 2: Run the existing provider tests** —
      `npx vitest run tests/core/domains/trajectory/codegraph/symbols/` → all
      PASS (relocation preserved behavior). If red, fix the move (do NOT change
      examples).
- [ ] **Step 3: Write the failing unit test** for the shared helper (TS file,
      fixture string, real tree-sitter parse) asserting symbol ranges for a
      nested `module M; class C; def m; end; end; end` produce `C#m` with the
      right scope — copy the assertion shape from the existing provider symbol
      test.
- [ ] **Step 4: Run** — PASS (function already moved). Commit.
- [ ] **Step 5: Commit** —
      `git commit -m "refactor(codegraph): relocate collectSymbols to language/kernel (worker-callable, yl9tv)"`

---

## Task 3: Worker emits `FileExtraction` from the single parse

**Files:**

- Modify: `src/core/domains/ingest/pipeline/chunker/infra/worker.ts`
- Modify: `src/core/domains/ingest/pipeline/chunker/tree-sitter.ts` (expose the
  parsed `Tree` so chunk + walk share one parse — add a method returning
  `{ chunks, tree, langConfig }` or accept a pre-parsed tree)
- Modify: `src/core/domains/language/index.ts` (ensure the dynamically-imported
  barrel exposes `collectSymbols` + per-language
  `scopeSeparator`/`disambiguateOverloads` lookup the worker needs)
- Test:
  `tests/core/domains/ingest/pipeline/chunker/infra/worker-emit-extraction.test.ts`
  (create) — drives the worker entry in-process (import the message handler) on
  a real ruby fixture, asserts the returned `extraction` deep-equals the
  codegraph provider's direct-mode `extractOneFile` output for the same file.

**Interfaces:**

- Consumes: `WorkerRequest.emitExtraction` (Task 1), shared `collectSymbols`
  (Task 2), `languageFactory.create(lang).walker` (already built in-thread).
- Produces: `WorkerResponse.extraction` populated when
  `emitExtraction && walker` present.

- [ ] **Step 1: Write the failing equivalence test** — parse `huginn`-style ruby
      fixture; compare worker `extraction` vs `extractOneFile`. Expected total
      `chunks[].calls.length` equal and `imports`/`fileScope` deep-equal.
- [ ] **Step 2: Run** → FAIL (worker returns no `extraction`).
- [ ] **Step 3: Implement** — in `worker.ts`, when `request.emitExtraction`:
      obtain the parsed tree once (via the new `tree-sitter.ts` seam), run
      `collectSymbols(...)` +
      `walker.walk({ tree, code, relPath, language, chunks })`, attach to the
      response. Correct the stale comment at worker.ts:20-21 ("native bindings
      are per-thread") — note the corruption is process-global, single-flight is
      enforced upstream.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** —
      `git commit -m "feat(chunker): worker emits codegraph FileExtraction from one parse (yl9tv)"`

---

## Task 4: Pool propagates `extraction`; enforce single-flight parse

**Files:**

- Modify: `src/core/domains/ingest/pipeline/chunker/infra/pool.ts` (return
  `extraction` on the result; force a single parse worker)
- Modify: `src/bootstrap/config/schemas.ts` + `src/core/types.ts` (chunker parse
  single-flight: either `chunkerPoolSize` parse-default 1 or a dedicated single
  parse worker — see spec Open Decision; default to size 1)
- Test:
  `tests/core/domains/ingest/pipeline/chunker/infra/pool-single-flight.test.ts`
  (create)

**Interfaces:**

- Produces: `ChunkerPool#processFile(...) → { filePath, chunks, extraction? }`;
  `processFile` request sets `emitExtraction` when codegraph is enabled.
- Concurrency invariant: at most one `parse()` in flight process-wide.

- [ ] **Step 1: Write the failing test** — (a) `processFile` round-trips
      `extraction`; (b) a concurrency-invariant test: dispatch N concurrent
      `processFile` calls under codegraph-enabled config and assert results are
      byte-stable across two runs (no parse overlap). Mock/instrument via a
      counter exposed by the pool.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** — unwrap `extraction` in `processFile`; set parse
      concurrency to 1 (single worker / single-flight gate). Document the
      throughput tradeoff in a comment (parse is cheap; embedding is the
      bottleneck).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** —
      `git commit -m "feat(chunker): propagate extraction + single-flight parse (yl9tv)"`

---

## Task 5: Cross-pass channel — chunk pass tees extraction into the codegraph spill

**Files:**

- Modify: `src/core/domains/trajectory/codegraph/symbols/provider.ts` — add
  `acceptExtraction(extraction: FileExtraction, options): Promise<void>` that
  writes to the run spill (reuse `asExtractionSink`); open the spill at index
  start (lift sink creation out of lazy first-batch); make pool-mode
  `streamFileBatch` a no-op for parsing (extraction already spilled); KEEP
  `extractOneFile` for direct mode.
- Modify: `src/core/domains/ingest/pipeline/file-processor.ts` — after
  `chunkerPool.processFile`, if `result.extraction`, forward via the codegraph
  hook.
- Modify: `src/core/domains/ingest/pipeline/base.ts` (`setupEnrichmentHooks`) —
  wire a `setOnExtraction`-style hook from the chunk pass to the codegraph
  provider (mirrors the existing `setOnBatchUpserted` git bridge; no
  domain-boundary violation — callback bridges via the coordinator).
- Test: `tests/core/domains/ingest/pipeline/codegraph-extraction-bridge.test.ts`
  (create) — feed two file extractions through the bridge; assert both land in
  the spill and `finalizeSignals` resolves them with NO call to `extractOneFile`
  (spy asserts zero parses in pool mode).

**Interfaces:**

- Consumes: `WorkerResponse.extraction` surfaced by `ChunkerPool` (Task 4).
- Produces:
  `CodegraphEnrichmentProvider#acceptExtraction(extraction, { collectionName })`;
  spill populated by the chunk pass; `finalizeSignals` unchanged downstream.

- [ ] **Step 1: Write the failing test** — bridge two extractions → spill →
      finalize; spy on `extractOneFile` expects 0 calls (pool mode).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the spill-at-index-start lifetime,
      `acceptExtraction`, the file-processor forward, and the base hook.
      Pool-mode `streamFileBatch` no longer parses; direct mode (no hook wired /
      tests) still uses `extractOneFile`.
- [ ] **Step 4: Run** → PASS; also run
      `npx vitest run tests/core/domains/trajectory/codegraph/symbols/`
      (single-owner tests stay green via direct-mode fallback).
- [ ] **Step 5: Commit** —
      `git commit -m "feat(codegraph): consume chunker-fed FileExtraction, drop main-thread re-parse in pool mode (yl9tv)"`

---

## Task 6: Live determinism validation + cleanup

**Files:**

- Modify: `src/core/domains/ingest/pipeline/chunker/infra/worker.ts` (final
  comment correctness)
- No new source; this task is build + link + live reindex per
  `.claude/CLAUDE.md` MCP workflow.

- [ ] **Step 1:** `npm run build` (tsc=0) + `npx vitest run` (all green,
      coverage ≥ threshold).
- [ ] **Step 2:** `npm link` worktree; reconnect MCP;
      `force_reindex project=tea-rags` (schema-stable, but rebuild graph) and
      `force_reindex project=huginn`.
- [ ] **Step 3:** Re-run the determinism probe equivalent: index huginn 2× (via
      the harness used in diagnosis or MCP `force_reindex` ×2) →
      `get_index_status` codegraph resolveSuccessRate / a cg_run_stats
      `callsAttempted` read must be **stable** across the two runs (was
      11886↔15677 = ±32%). Record both values.
- [ ] **Step 4:** Confirm chunk determinism at pool>1 is no longer a concern
      (single-flight) — spot check by indexing a multi-file ruby project twice
      and diffing cg_run_stats `callsAttempted`.
- [ ] **Step 5: Commit** any final doc/comment fixes —
      `git commit -m "docs(codegraph): correct per-thread parse comment; yl9tv determinism validated"`

---

## Self-Review notes

- **Spec coverage:** invariant (Tasks 3–5), one-parse-two-consumers (Task 3),
  spill/two-pass preserved (Task 5), exclusion gating stays main (Task 5 —
  emitExtraction flag set in file-processor/pool from codegraph-enabled config),
  direct-mode fallback (Task 5 keeps extractOneFile), additive contract (Task
  1), single-flight (Task 4), latent chunker bug (Task 4 single-flight), tests
  (each task). ✓
- **Open decision** resolved: single-flight via pool size 1 (Task 4), with a
  dedicated-gate note left in the comment if non-parse work later justifies it.
- **Risk:** Task 5 is the largest (cross-pass channel + spill lifetime) and
  touches the churn hotspot provider.ts — split further during execution if a
  reviewer could reject the spill-lifetime change independently of the bridge.
