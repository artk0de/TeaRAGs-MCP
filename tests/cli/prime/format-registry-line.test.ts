import { describe, expect, it } from "vitest";

import { formatPrime } from "../../../src/cli/prime/format.js";
import type { PrimeData, PrimeRegistryEntry } from "../../../src/cli/prime/types.js";

const baseStatus = {
  status: "indexed" as const,
  collectionName: "code_abc",
  filesCount: 1,
  chunksCount: 1,
  embeddingModel: "test-model",
};

const NOW = new Date("2026-05-13T00:00:00Z");

function entry(overrides: Partial<PrimeRegistryEntry> = {}): PrimeRegistryEntry {
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

function data(overrides: Partial<PrimeData> = {}): PrimeData {
  return {
    path: "/repo",
    projectName: "myrepo",
    status: baseStatus,
    metrics: null,
    drift: null,
    update: null,
    ...overrides,
  };
}

/** Extract the single `registry:` line from the rendered digest. */
function registryLine(out: string): string | undefined {
  return out.split("\n").find((l) => l.startsWith("registry:"));
}

describe("formatPrime — registry params line", () => {
  it("renders one compact line with all effective params when the entry carries every field", () => {
    const out = formatPrime(
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
      NOW,
    );
    expect(registryLine(out)).toBe(
      "registry: embedding http://192.168.1.71:11434 (fallback http://localhost:11434) · " +
        "qdrant http://127.0.0.1:51269 (embedded) · codegraph on · v1.33.0",
    );
  });

  it("omits absent fields for a minimal legacy entry (line stays single)", () => {
    const out = formatPrime(data({ registry: entry() }), NOW);
    expect(registryLine(out)).toBe("registry: qdrant http://qdrant:6333 · v1.0.0");
  });

  it("renders 'codegraph off' when codegraphEnabled is explicitly false", () => {
    const out = formatPrime(data({ registry: entry({ codegraphEnabled: false }) }), NOW);
    expect(registryLine(out)).toBe("registry: qdrant http://qdrant:6333 · codegraph off · v1.0.0");
  });

  it("appends tuning map entries as key=value pairs, sorted for stability", () => {
    const out = formatPrime(
      data({
        registry: entry({ tuning: { EMBEDDING_BATCH_SIZE: "32", CHUNK_SIZE: "1200" } }),
      }),
      NOW,
    );
    expect(registryLine(out)).toBe(
      "registry: qdrant http://qdrant:6333 · v1.0.0 · CHUNK_SIZE=1200 EMBEDDING_BATCH_SIZE=32",
    );
  });

  it("omits an empty tuning map without a trailing separator", () => {
    const out = formatPrime(data({ registry: entry({ tuning: {} }) }), NOW);
    expect(registryLine(out)).toBe("registry: qdrant http://qdrant:6333 · v1.0.0");
  });

  it("emits no registry line when PrimeData has no registry entry", () => {
    const out = formatPrime(data(), NOW);
    expect(registryLine(out)).toBeUndefined();
    expect(out).toContain("## Project");
  });

  it("renders the Project section with only the registry line when projectName is null but an entry exists", () => {
    const out = formatPrime(data({ projectName: null, registry: entry({ name: null }) }), NOW);
    expect(out).toContain("## Project");
    expect(registryLine(out)).toBe("registry: qdrant http://qdrant:6333 · v1.0.0");
    expect(out).not.toContain("name: `");
    expect(out).not.toContain("[hint] Use");
  });
});
