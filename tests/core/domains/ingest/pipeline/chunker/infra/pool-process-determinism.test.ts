import { describe, expect, it } from "vitest";

import { ChunkerPool } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js";
import type { ChunkerConfig } from "../../../../../../../src/core/types.js";

// A non-trivial Ruby source with many classes/methods so the AST is large
// enough that a corrupt parse would diverge in chunk count or extraction.
const RUBY = Array.from(
  { length: 40 },
  (_, i) => `
class Widget${i} < Base
  def process_${i}(input, opts = {})
    input.map { |x| x.to_s.strip }.reject(&:empty?)
  end
end`,
).join("\n");

describe("ChunkerPool process determinism (size 4)", () => {
  // retry+long timeout: this spawns 4 child processes and runs 24 concurrent
  // parses; under full-suite parallel-fork CPU contention a single run can blow
  // the timeout (a transient resource flake, NOT a determinism failure — a real
  // determinism regression fails every retry deterministically). Mirrors the
  // CI-only retry locally so the pre-commit gate stops flaking on contention.
  it("produces byte-stable chunks+extraction across many concurrent runs", { retry: 2, timeout: 60_000 }, async () => {
    const pool = new ChunkerPool(4, {
      chunkSize: 1500,
      chunkOverlap: 0,
      maxChunkSize: 3000,
    } as ChunkerConfig);
    try {
      const runs = await Promise.all(
        Array.from({ length: 24 }, async () => pool.processFile("w.rb", RUBY, "ruby", true)),
      );
      const baseline = JSON.stringify({
        chunks: runs[0].chunks.map((c) => c.symbolId),
        ext: runs[0].extraction?.chunks.map((c) => c.symbolId),
      });
      for (const r of runs) {
        const sig = JSON.stringify({
          chunks: r.chunks.map((c) => c.symbolId),
          ext: r.extraction?.chunks.map((c) => c.symbolId),
        });
        expect(sig).toBe(baseline);
      }
    } finally {
      await pool.shutdown();
    }
    // Spawns 4 child processes and runs 24 concurrent parses — legitimately
    // heavy. ~1.5s in isolation but exceeds the 5s default under full-suite
    // parallel-fork CPU contention (flaky-timeout, not a determinism failure).
  });
});
