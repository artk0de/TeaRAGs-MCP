import { describe, expect, it } from "vitest";

import { MissedFileTracker } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/missed-file-tracker.js";

describe("MissedFileTracker", () => {
  it("accumulates missed-file paths and chunk IDs up to sample limit", () => {
    const tracker = new MissedFileTracker({ sampleLimit: 2 });
    tracker.track("a.ts", [{ chunkId: "c1", startLine: 1, endLine: 5 }]);
    tracker.track("b.ts", [{ chunkId: "c2", startLine: 1, endLine: 5 }]);
    tracker.track("c.ts", [{ chunkId: "c3", startLine: 1, endLine: 5 }]);
    expect(tracker.missedCount).toBe(3);
    expect(tracker.samples).toEqual(["a.ts", "b.ts"]);
    expect(tracker.chunksFor("a.ts")).toHaveLength(1);
  });

  it("clamps missedCount at zero when decrementMissed overshoots", () => {
    // Reproduces the get_index_status negative-counter bug: applier
    // tracks one missed file, backfiller reports 5 files were
    // re-enriched (because the provider's missed list and applier's
    // batch-derived missed list disagree). Without the clamp, missedCount
    // becomes -4 and get_index_status surfaces missedFiles: -4.
    const tracker = new MissedFileTracker({ sampleLimit: 10 });
    tracker.track("a.ts", [{ chunkId: "c1", startLine: 1, endLine: 5 }]);
    expect(tracker.missedCount).toBe(1);
    tracker.decrementMissed(5);
    expect(tracker.missedCount).toBe(0);
  });

  it("decrementMissed reduces but never below zero across repeated calls", () => {
    const tracker = new MissedFileTracker({ sampleLimit: 10 });
    tracker.track("a.ts", [{ chunkId: "c1", startLine: 1, endLine: 5 }]);
    tracker.track("b.ts", [{ chunkId: "c2", startLine: 1, endLine: 5 }]);
    tracker.track("c.ts", [{ chunkId: "c3", startLine: 1, endLine: 5 }]);
    tracker.decrementMissed(2);
    expect(tracker.missedCount).toBe(1);
    tracker.decrementMissed(10);
    expect(tracker.missedCount).toBe(0);
    tracker.decrementMissed(1);
    expect(tracker.missedCount).toBe(0);
  });
});
