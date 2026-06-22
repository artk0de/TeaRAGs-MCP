import { describe, expect, it } from "vitest";

import { formatIndexStatus } from "../../../src/cli/index-progress/status-format.js";
import { createColorizer } from "../../../src/cli/infra/color.js";
import type { IndexStatus } from "../../../src/core/api/public/index.js";

const plain = createColorizer({ env: {}, isTTY: false });

const baseStatus: IndexStatus = {
  isIndexed: true,
  status: "indexed",
  collectionName: "code_abc",
  filesCount: 120,
  chunksCount: 3400,
  languages: ["typescript", "markdown"],
  embeddingModel: "jina-v2",
};

describe("formatIndexStatus", () => {
  it("renders core index fields", () => {
    const out = formatIndexStatus(baseStatus, plain);
    expect(out).toContain("indexed");
    expect(out).toContain("code_abc");
    expect(out).toContain("3400");
    expect(out).toContain("120");
    expect(out).toContain("jina-v2");
    expect(out).toContain("typescript");
  });

  it("emits no ANSI escape codes with the plain colorizer", () => {
    const out = formatIndexStatus(baseStatus, plain);
    expect(out).not.toContain("\x1b");
  });

  it("renders per-provider enrichment health", () => {
    const out = formatIndexStatus(
      {
        ...baseStatus,
        enrichment: {
          git: { file: { status: "healthy" }, chunk: { status: "healthy" } },
          "codegraph.symbols": {
            file: { status: "in_progress" },
            chunk: { status: "failed", message: "spill write failed" },
          },
        },
      },
      plain,
    );
    expect(out).toContain("git");
    expect(out).toContain("codegraph.symbols");
    expect(out).toContain("healthy");
    expect(out).toContain("in_progress");
    expect(out).toContain("failed");
    expect(out).toContain("spill write failed");
  });

  it("handles a not_indexed status without throwing", () => {
    const out = formatIndexStatus({ isIndexed: false, status: "not_indexed" }, plain);
    expect(out).toContain("not_indexed");
  });
});
