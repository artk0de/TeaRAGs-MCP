import { describe, expect, it } from "vitest";

import type { CollectionEntry } from "../../../../src/core/api/public/index.js";
import { formatProjectMetrics } from "../../../../src/mcp/resources/project/metrics.js";
import type { ProjectDigestData } from "../../../../src/mcp/resources/project/types.js";

const baseStatus = {
  status: "indexed" as const,
  isIndexed: true,
  collectionName: "code_abc",
  filesCount: 1,
  chunksCount: 1,
  embeddingModel: "test-model",
};

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
    status: baseStatus,
    metrics: null,
    drift: null,
    ...overrides,
  };
}

function render(d: ProjectDigestData): string {
  return formatProjectMetrics(d, { section: ["registry"] });
}

/** Extract the single `registry:` line from the rendered metrics. */
function registryLine(out: string): string | undefined {
  return out.split("\n").find((l) => l.startsWith("registry:"));
}

describe("formatProjectMetrics — registry params line", () => {
  it("renders one compact line with all effective params when the entry carries every field", () => {
    const out = render(
      data({
        registry: entry({
          embeddingBaseUrl: "http://192.168.1.71:11434",
          embeddingFallbackUrl: "http://localhost:11434",
          qdrantUrl: "http://127.0.0.1:51269",
          qdrantEmbedded: true,
          codegraphEnabled: true,
          teaRagsVersion: "1.33.0",
        }),
      }),
    );
    expect(registryLine(out)).toBe(
      "registry: embedding http://192.168.1.71:11434 (fallback http://localhost:11434) · " +
        "qdrant http://127.0.0.1:51269 (embedded) · codegraph on · v1.33.0",
    );
  });

  it("omits absent fields for a minimal legacy entry (line stays single)", () => {
    const out = render(data({ registry: entry() }));
    expect(registryLine(out)).toBe("registry: qdrant http://qdrant:6333 · v1.0.0");
  });

  it("renders 'codegraph off' when codegraphEnabled is explicitly false", () => {
    const out = render(data({ registry: entry({ codegraphEnabled: false }) }));
    expect(registryLine(out)).toBe("registry: qdrant http://qdrant:6333 · codegraph off · v1.0.0");
  });

  it("appends tuning map entries as key=value pairs, sorted for stability", () => {
    const out = render(
      data({
        registry: entry({ tuning: { EMBEDDING_BATCH_SIZE: "32", CHUNK_SIZE: "1200" } }),
      }),
    );
    expect(registryLine(out)).toBe(
      "registry: qdrant http://qdrant:6333 · v1.0.0 · CHUNK_SIZE=1200 EMBEDDING_BATCH_SIZE=32",
    );
  });

  it("omits an empty tuning map without a trailing separator", () => {
    const out = render(data({ registry: entry({ tuning: {} }) }));
    expect(registryLine(out)).toBe("registry: qdrant http://qdrant:6333 · v1.0.0");
  });

  it("emits no registry line when ProjectDigestData has no registry entry", () => {
    const out = render(data());
    expect(registryLine(out)).toBeUndefined();
  });

  it("renders the registry line when projectName is null but an entry exists", () => {
    const out = render(data({ projectName: null, registry: entry({ name: null }) }));
    expect(registryLine(out)).toBe("registry: qdrant http://qdrant:6333 · v1.0.0");
    expect(out).not.toContain("name: `");
    expect(out).not.toContain("[hint] Use");
  });
});
