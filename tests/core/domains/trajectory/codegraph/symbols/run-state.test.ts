/**
 * CodegraphRunState (bd tea-rags-mcp-6vfrj / G2) — per-run state extracted
 * from `CodegraphEnrichmentProvider` so one object owns the lifecycle of the
 * run-global aggregation maps + resolve tally.
 */

import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

describe("CodegraphRunState.absorb", () => {
  it("merges classPrependedAncestors and ivarTypes from a file extraction into the run-global maps", () => {
    const runState = new CodegraphRunState();
    const extraction: FileExtraction = {
      relPath: "app/models/post.rb",
      language: "ruby",
      imports: [],
      chunks: [],
      fileScope: [],
      classPrependedAncestors: { Post: ["Taggable"] },
      ivarTypes: { Post: { "@author": "User" } },
    };

    runState.absorb(extraction, []);

    expect(runState.prependedAncestors).toEqual({ Post: ["Taggable"] });
    expect(runState.ivarTypes).toEqual({ Post: { "@author": "User" } });
  });

  it("leaves the run-global maps untouched when a file extraction carries no prepended-ancestor or ivar data", () => {
    const runState = new CodegraphRunState();
    const extraction: FileExtraction = {
      relPath: "app/models/comment.rb",
      language: "ruby",
      imports: [],
      chunks: [],
      fileScope: [],
    };

    runState.absorb(extraction, []);

    expect(runState.prependedAncestors).toEqual({});
    expect(runState.ivarTypes).toEqual({});
  });
});

describe("CodegraphRunState.drainMetrics", () => {
  it("reports zero resolveSuccessRate and inProjectEdgeRecall for a run that extracted files/edges but attempted no calls", () => {
    const runState = new CodegraphRunState();
    // A file with only file-edges (bare imports, no method calls) keeps
    // fileEdgeCount > 0 so drainMetrics takes the real-run branch rather
    // than the wide empty-run reset (which reports undefined instead).
    runState.stats.extractedFiles = 1;
    runState.stats.fileEdgeCount = 1;

    const metrics = runState.drainMetrics();

    expect(metrics).toBeDefined();
    expect(metrics?.resolveSuccessRate).toBe(0);
    expect(metrics?.inProjectEdgeRecall).toBe(0);
    expect(metrics?.fileEdgeCount).toBe(1);
  });

  it("resets the tally to empty stats after draining, so a second drain of an untouched run reports undefined", () => {
    const runState = new CodegraphRunState();
    runState.stats.extractedFiles = 1;
    runState.stats.fileEdgeCount = 1;

    runState.drainMetrics();

    expect(runState.drainMetrics()).toBeUndefined();
  });
});
