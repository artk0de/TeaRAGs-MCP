import { describe, expect, it } from "vitest";

import type { IndexStatus } from "../../../../src/core/api/public/dto/ingest.js";
import { formatFullDigest } from "../../../../src/mcp/resources/project/digest.js";
import type { ProjectDigestData } from "../../../../src/mcp/resources/project/types.js";

const NOW = new Date("2026-10-27T12:00:00Z");

function data(indexHoles?: IndexStatus["indexHoles"]): ProjectDigestData {
  return {
    path: "/repo",
    projectName: "repo",
    status: {
      isIndexed: true,
      status: "indexed",
      collectionName: "c",
      chunksCount: 100,
      lastUpdated: NOW,
      ...(indexHoles ? { indexHoles } : {}),
    },
    metrics: null,
    drift: null,
  };
}

describe("formatFullDigest — index holes (bd tea-rags-mcp-muj77)", () => {
  it("renders one drift-class warning line under the Drift section", () => {
    const lines = formatFullDigest(data({ count: 63 }), NOW).split("\n");

    const driftAt = lines.indexOf("## Drift");
    expect(lines.slice(driftAt, driftAt + 3)).toEqual([
      "## Drift",
      "none",
      "⚠ index holes: 63 files in snapshot without points — re-index them: index_codebase forceReindex=true",
    ]);
  });

  it("renders nothing when the status reports no holes", () => {
    expect(formatFullDigest(data(), NOW)).not.toContain("index holes");
  });
});
