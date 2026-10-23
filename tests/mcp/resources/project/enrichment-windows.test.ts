import { describe, expect, it } from "vitest";

import type { CollectionEntry } from "../../../../src/core/api/public/index.js";
import { formatSlimDigest } from "../../../../src/mcp/resources/project/digest.js";
import type { ProjectDigestData } from "../../../../src/mcp/resources/project/types.js";

const NOW = new Date("2026-05-13T00:00:00Z");

function entry(overrides: Partial<CollectionEntry> = {}): CollectionEntry {
  return {
    collectionName: "code_abc",
    path: "/repo",
    name: "myrepo",
    embeddingModel: "jina",
    embeddingDimensions: 768,
    qdrantUrl: "http://qdrant:6333",
    indexedAt: "2026-05-01T00:00:00Z",
    teaRagsVersion: "1.0.0",
    chunksCount: 5,
    ...overrides,
  };
}

function data(overrides: Partial<ProjectDigestData> = {}): ProjectDigestData {
  return {
    path: "/repo",
    projectName: "myrepo",
    status: {
      isIndexed: true,
      status: "indexed",
      collectionName: "code_abc",
      chunksCount: 100,
      enrichment: {
        git: { file: { status: "healthy" }, chunk: { status: "healthy" } },
      },
    },
    metrics: null,
    drift: null,
    ...overrides,
  };
}

/** Extract the `git:` row from the rendered `## Enrichment` section. */
function gitRow(out: string): string | undefined {
  return out.split("\n").find((l) => l.startsWith("git: "));
}

const WINDOW_ENV = {
  TRAJECTORY_GIT_LOG_MAX_AGE_MONTHS: "12",
  TRAJECTORY_GIT_CHUNK_MAX_AGE_MONTHS: "6",
};

describe("formatSlimDigest — git walk windows on the enrichment row", () => {
  it("keeps the in-progress marker ahead of the window suffix", () => {
    const out = formatSlimDigest(
      data({
        registry: entry({ env: WINDOW_ENV }),
        status: {
          isIndexed: true,
          status: "indexed",
          collectionName: "code_abc",
          chunksCount: 100,
          enrichment: {
            git: { file: { status: "healthy" }, chunk: { status: "in_progress" } },
          },
        },
      }),
      NOW,
    );
    expect(gitRow(out)).toBe("git: file healthy, chunk in_progress (in progress) · window file 12mo / chunk 6mo");
  });
});
