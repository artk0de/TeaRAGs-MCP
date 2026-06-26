import { describe, expect, it } from "vitest";

import { ChunkerPool } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js";
import type { ChunkerConfig } from "../../../../../../../src/core/types.js";

/**
 * rdv7d repro — ruby codegraph callsAttempted jitters ~7% run-to-run on huginn
 * full-reindex while JS/TS are byte-stable. Static analysis localized the tally
 * (provider.ts:1768, `callsAttempted++` per chunk.call, PRE-resolution) to a
 * pure count over the deduped set of spilled extractions → jitter ⟺ that set
 * varies. This test stresses the ONE layer the process pool covers: drive N
 * DISTINCT ruby sources of varying size through a real ProcessTransport pool at
 * size 8 (the live env's INGEST_TUNE_CHUNKER_POOL_SIZE), M iterations, and
 * assert per-file extraction is (a) never dropped and (b) byte-stable in its
 * total call count. If RED here, the residual non-determinism lives in the
 * chunker process pool itself (response routing / parse under concurrent load).
 * If GREEN, the pool is exonerated and the jitter is in the spill/coordinator
 * layer downstream — escalate to instrumented pipeline.
 */

// Distinct ruby sources of varying size — different workers parse different
// grammars concurrently (the spike's "A+B sources" generalized to N at scale).
// Size varies with `i` so worker load is uneven, maximizing interleave.
function rubySource(i: number): string {
  const methods = 3 + (i % 7); // 3..9 methods
  const body = Array.from({ length: methods }, (_, m) => {
    const calls = 2 + ((i + m) % 5); // 2..6 call sites per method
    const lines = Array.from(
      { length: calls },
      (_, c) => `    acc = transform_${c}(acc).map { |x| x.to_s.strip }.reject(&:empty?)`,
    ).join("\n");
    return `  def process_${m}(input, opts = {})\n    acc = input\n${lines}\n    acc\n  end`;
  }).join("\n\n");
  return `module Domain${i}\n  class Service${i} < Base${i % 3}\n    include Mixin${i % 4}\n${body}\n  end\nend\n`;
}

interface FileSig {
  ext: string | undefined;
  totalCalls: number;
  chunkIds: string; // chunker output (parse-tree-derived) — drifts iff the PARSE drifts
}

function signatureOf(result: {
  chunks: { symbolId: string }[];
  extraction?: { chunks: { calls: unknown[] }[] };
}): FileSig {
  return {
    ext: result.extraction?.chunks.map((c) => (c as { symbolId: string }).symbolId).join(","),
    // mirrors provider.ts callsAttempted: sum of chunk.calls over the extraction
    totalCalls: result.extraction?.chunks.reduce((n, c) => n + c.calls.length, 0) ?? -1,
    chunkIds: result.chunks.map((c) => c.symbolId).join(","),
  };
}

// rdv7d regression sentinel: GREEN since the materialize boundary landed —
// per-file extraction is byte-stable across iterations (was flaky ~2x before).
describe("ChunkerPool ruby jitter repro (size 8, N distinct files)", () => {
  // retry+timeout: spawns a size-8 pool parsing N=50 files M times — heavy. A
  // transient timeout under full-suite parallel-fork contention is a resource
  // flake, not a determinism failure (a real regression fails every retry).
  // Default local timeout is 5s with no local retry — both raised here.
  it(
    "never drops extraction and keeps per-file call count byte-stable across iterations",
    { retry: 2, timeout: 60_000 },
    async () => {
      const N = 50;
      const M = 6;
      const files = Array.from({ length: N }, (_, i) => ({ path: `service_${i}.rb`, code: rubySource(i) }));

      const pool = new ChunkerPool(8, {
        chunkSize: 1500,
        chunkOverlap: 0,
        maxChunkSize: 3000,
      } as ChunkerConfig);

      try {
        // Baseline (iteration 0).
        const baseline = new Map<string, FileSig>();
        const first = await Promise.all(files.map(async (f) => pool.processFile(f.path, f.code, "ruby", true)));
        first.forEach((r, idx) => baseline.set(files[idx].path, signatureOf(r)));

        // Every baseline file MUST have produced an extraction (no silent drop).
        for (const [path, sig] of baseline) {
          expect(sig.ext, `baseline: ${path} produced no extraction`).toBeDefined();
          expect(sig.totalCalls, `baseline: ${path} had zero calls`).toBeGreaterThan(0);
        }

        // M further concurrent iterations — each must match the baseline exactly.
        for (let iter = 1; iter < M; iter++) {
          const runs = await Promise.all(files.map(async (f) => pool.processFile(f.path, f.code, "ruby", true)));
          runs.forEach((r, idx) => {
            const { path } = files[idx];
            const sig = signatureOf(r);
            const base = baseline.get(path)!;
            expect(sig.ext, `iter ${iter}: ${path} DROPPED extraction`).toBeDefined();
            // CHUNKS first: drift here ⇒ the PARSE TREE drifted (parser-level).
            // Stable chunks + drifting calls ⇒ WALKER-level carryover.
            expect(sig.chunkIds, `iter ${iter}: ${path} CHUNKS (parse tree) drifted`).toBe(base.chunkIds);
            expect(sig.totalCalls, `iter ${iter}: ${path} call count drifted (walker)`).toBe(base.totalCalls);
            expect(sig.ext, `iter ${iter}: ${path} extraction shape drifted`).toBe(base.ext);
          });
        }
      } finally {
        await pool.shutdown();
      }
    },
  );
});
