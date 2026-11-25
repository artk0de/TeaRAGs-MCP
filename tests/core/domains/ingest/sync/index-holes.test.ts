/**
 * GitHub #10 — which snapshot paths are index holes: listed as indexed, still
 * on disk, holding no points, and neither a deliberate skip nor quarantined.
 */
import { describe, expect, it } from "vitest";

import { selectIndexHolePaths } from "../../../../../src/core/domains/ingest/sync/index-holes.js";

describe("selectIndexHolePaths", () => {
  const base = {
    snapshotPaths: ["a.md", "b.md", "c.md"],
    scannedPaths: ["a.md", "b.md", "c.md"],
    indexedPaths: new Set(["a.md"]),
    skippedPaths: new Set<string>(),
    quarantinedPaths: new Set<string>(),
  };

  it("selects snapshot files on disk that hold no points", () => {
    expect(selectIndexHolePaths(base)).toEqual(["b.md", "c.md"]);
  });

  it("leaves deliberate skips and quarantined files alone", () => {
    expect(
      selectIndexHolePaths({ ...base, skippedPaths: new Set(["b.md"]), quarantinedPaths: new Set(["c.md"]) }),
    ).toEqual([]);
  });

  it("leaves a file gone from disk to change detection", () => {
    expect(selectIndexHolePaths({ ...base, scannedPaths: ["a.md", "b.md"] })).toEqual(["b.md"]);
  });
});
