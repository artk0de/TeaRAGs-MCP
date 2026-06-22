import { describe, expect, it } from "vitest";

import { formatIndexStatus, formatIndexStatusJson } from "../../../src/cli/index-progress/status-format.js";
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

  it("renders project name, qdrant health, counts, size and enrichment metrics", () => {
    const status: IndexStatus = {
      ...baseStatus,
      indexSizeBytes: 1048576,
      infraHealth: {
        qdrant: { available: true, url: "http://localhost:6333", status: "green" },
        embedding: { available: true, provider: "jina" },
      },
      enrichmentMetrics: {
        prefetchDurationMs: 100,
        streamingApplies: 5,
        flushApplies: 2,
        chunkChurnDurationMs: 50,
        totalDurationMs: 300,
        matchedFiles: 80,
        missedFiles: 10,
        missedPathSamples: [],
      },
    };
    const out = formatIndexStatus(status, plain, { projectName: "tea-rags", path: "/x" });
    expect(out).toContain("project:    tea-rags");
    expect(out).toMatch(/qdrant:\s+(green|yellow|red)/);
    expect(out).toContain("chunks:");
    expect(out).toContain("size:");
    expect(out).toMatch(/matched\s+80/);
  });

  it("falls back to path when no projectName", () => {
    const out = formatIndexStatus(baseStatus, plain, { path: "/my/project" });
    expect(out).toContain("path:       /my/project");
  });

  it("omits size line when indexSizeBytes is absent", () => {
    const out = formatIndexStatus(baseStatus, plain, { projectName: "p" });
    expect(out).not.toContain("size:");
  });

  it("renders yellow qdrant status with warn color word", () => {
    const status: IndexStatus = {
      ...baseStatus,
      infraHealth: {
        qdrant: { available: true, url: "http://localhost:6333", status: "yellow" },
        embedding: { available: true, provider: "jina" },
      },
    };
    const out = formatIndexStatus(status, plain);
    expect(out).toContain("yellow");
  });

  it("renders red qdrant status with alert color word", () => {
    const status: IndexStatus = {
      ...baseStatus,
      infraHealth: {
        qdrant: { available: true, url: "http://localhost:6333", status: "red" },
        embedding: { available: true, provider: "jina" },
      },
    };
    const out = formatIndexStatus(status, plain);
    expect(out).toContain("red");
  });

  it("renders size in KB for small sizes", () => {
    const out = formatIndexStatus({ ...baseStatus, indexSizeBytes: 2048 }, plain);
    expect(out).toContain("KB");
  });

  it("renders size in GB for very large sizes", () => {
    const out = formatIndexStatus({ ...baseStatus, indexSizeBytes: 2 * 1024 * 1024 * 1024 }, plain);
    expect(out).toContain("GB");
  });
});

describe("formatIndexStatusJson", () => {
  it("returns a stable machine object with expected shape", () => {
    const status: IndexStatus = {
      ...baseStatus,
      indexSizeBytes: 2097152,
      enrichmentMetrics: {
        prefetchDurationMs: 200,
        streamingApplies: 3,
        flushApplies: 1,
        chunkChurnDurationMs: 60,
        totalDurationMs: 500,
        matchedFiles: 100,
        missedFiles: 5,
        missedPathSamples: ["a/b.ts"],
      },
    };
    const o = formatIndexStatusJson(status, { path: "/x", projectName: "tea-rags", overallMs: 4200 });
    expect(o).toMatchObject({ projectName: "tea-rags", status: status.status, overallMs: 4200 });
  });

  it("contains no ANSI escape codes", () => {
    const o = formatIndexStatusJson(baseStatus, { path: "/x", projectName: "p", overallMs: 100 });
    const s = JSON.stringify(o);
    expect(s).not.toContain("\x1b");
  });

  it("includes indexSizeBytes and enrichmentMetrics when present", () => {
    const status: IndexStatus = {
      ...baseStatus,
      indexSizeBytes: 512,
      enrichmentMetrics: {
        prefetchDurationMs: 10,
        streamingApplies: 1,
        flushApplies: 0,
        chunkChurnDurationMs: 5,
        totalDurationMs: 50,
        matchedFiles: 20,
        missedFiles: 2,
        missedPathSamples: [],
      },
    };
    const o = formatIndexStatusJson(status, { path: "/p" }) as Record<string, unknown>;
    expect(o.indexSizeBytes).toBe(512);
    expect(o.enrichmentMetrics).toBeDefined();
  });

  it("omits indexSizeBytes when absent", () => {
    const o = formatIndexStatusJson(baseStatus, { path: "/p" }) as Record<string, unknown>;
    expect(o.indexSizeBytes).toBeUndefined();
  });

  it("includes infraHealth when present", () => {
    const status: IndexStatus = {
      ...baseStatus,
      infraHealth: {
        qdrant: { available: true, url: "http://localhost:6333", status: "green" },
        embedding: { available: true, provider: "jina" },
      },
    };
    const o = formatIndexStatusJson(status, { path: "/p" }) as Record<string, unknown>;
    expect(o.infraHealth).toBeDefined();
  });

  it("includes enrichmentHealth when enrichment is present", () => {
    const status: IndexStatus = {
      ...baseStatus,
      enrichment: { git: { file: { status: "healthy" }, chunk: { status: "healthy" } } },
    };
    const o = formatIndexStatusJson(status, { path: "/p" }) as Record<string, unknown>;
    expect(o.enrichmentHealth).toBeDefined();
  });
});
