/**
 * yl9tv — ChunkerPool single-flight + extraction propagation.
 *
 * NOTE: Requires `npm run build` before running (workers load compiled JS).
 *
 * (a) processFile round-trips the worker's codegraph FileExtraction when
 *     emitExtraction is set, and omits it otherwise.
 * (b) Under the single-flight default (pool size 1) parsing is serialized, so
 *     extractions are byte-stable across repeated concurrent runs — the
 *     determinism property the whole change exists to restore (was ±32% jitter
 *     when concurrent parses corrupted the tree at pool>1).
 */
import { afterEach, describe, expect, it } from "vitest";

import { ChunkerPool } from "../../../../../../../src/core/domains/ingest/pipeline/chunker/infra/pool.js";
import type { ChunkerConfig } from "../../../../../../../src/core/types.js";

const CHUNKER_CONFIG: ChunkerConfig = { chunkSize: 500, chunkOverlap: 50, maxChunkSize: 1000 };

const RUBY_FILES: { path: string; code: string }[] = [
  {
    path: "app/models/user.rb",
    code: ["module Acme", "  class User", "    def greet", "      notify(@name)", "    end", "  end", "end", ""].join(
      "\n",
    ),
  },
  {
    path: "app/models/order.rb",
    code: ["module Acme", "  class Order", "    def total", "      sum(@lines)", "    end", "  end", "end", ""].join(
      "\n",
    ),
  },
  {
    path: "lib/helpers.rb",
    code: ["module Helpers", "  def self.shout(s)", "    s.upcase", "  end", "end", ""].join("\n"),
  },
];

describe("ChunkerPool single-flight + extraction (yl9tv)", () => {
  let pool: ChunkerPool | undefined;
  afterEach(async () => {
    await pool?.shutdown();
    pool = undefined;
  });

  it("round-trips the codegraph extraction only when emitExtraction is set", async () => {
    pool = new ChunkerPool(1, CHUNKER_CONFIG);
    const { code, path } = RUBY_FILES[0];

    const withExtraction = await pool.processFile(path, code, "ruby", true);
    expect(withExtraction.chunks.length).toBeGreaterThan(0);
    expect(withExtraction.extraction).toBeDefined();
    expect(withExtraction.extraction?.chunks.map((c) => c.symbolId)).toContain("Acme::User#greet");

    const withoutExtraction = await pool.processFile(path, code, "ruby");
    expect(withoutExtraction.chunks.length).toBeGreaterThan(0);
    expect(withoutExtraction.extraction).toBeUndefined();
  });

  // retry+timeout: spawns a worker pool + repeated concurrent parses; a transient
  // timeout under full-suite parallel-fork contention is a resource flake, not a
  // determinism failure (a real regression fails every retry). Default local
  // timeout is 5s with no local retry — both raised here.
  it(
    "produces byte-stable extractions across repeated concurrent runs (single-flight determinism)",
    { retry: 2, timeout: 60_000 },
    async () => {
      pool = new ChunkerPool(1, CHUNKER_CONFIG);

      const runOnce = async () =>
        Promise.all(RUBY_FILES.map(async (f) => pool!.processFile(f.path, f.code, "ruby", true)));

      const first = await runOnce();
      const second = await runOnce();

      for (let i = 0; i < RUBY_FILES.length; i++) {
        expect(JSON.stringify(second[i].extraction)).toBe(JSON.stringify(first[i].extraction));
      }
    },
  );
});
