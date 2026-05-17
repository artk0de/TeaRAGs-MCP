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
});
