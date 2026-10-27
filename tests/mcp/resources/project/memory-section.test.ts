import { describe, expect, it } from "vitest";

import type { CollectionMemoryBytes, CollectionMemoryMetrics } from "../../../../src/core/api/public/index.js";
import { formatFullDigest } from "../../../../src/mcp/resources/project/digest.js";
import type { ProjectDigestData } from "../../../../src/mcp/resources/project/types.js";

// The digest reports ONE disk figure. On embedded Qdrant it is the allocated
// on-disk size tea-rags measures itself (Status line, "on disk"); the server's
// memory report only knows file sizes, which count Qdrant's sparsely
// preallocated mmap space and run far above it (2.07 GB vs 1.2 GB on the
// self-index).

const MB = 1024 * 1024;

function bytes(apparentMb: number, ramMb: number, cachedMb = 0, expectedMb = 0): CollectionMemoryBytes {
  return {
    apparentDiskBytes: Math.round(apparentMb * MB),
    ramBytes: Math.round(ramMb * MB),
    cachedBytes: Math.round(cachedMb * MB),
    expectedCacheBytes: Math.round(expectedMb * MB),
  };
}

const field = (name: string, apparentMb: number, ramMb: number) => ({ field: name, bytes: bytes(apparentMb, ramMb) });

// Shaped on the live self-index report (code_8b243ffe, 2026-09-18).
const selfIndexMemory: CollectionMemoryMetrics = {
  collection: "code_8b243ffe",
  total: bytes(1978.4, 74.2, 60.1, 198.5),
  vectors: [
    { name: "dense", storage: bytes(197, 0, 60.1, 197), index: bytes(1.4, 0, 0, 1.4), quantized: bytes(103.2, 7.1) },
  ],
  sparseVectors: [{ name: "text", storage: bytes(170.2, 0), index: bytes(5.9, 9.9) }],
  payload: bytes(165.2, 0),
  payloadIndexes: {
    count: 46,
    total: bytes(1334.8, 55.6),
    byField: [
      field("symbolId", 110, 3.3),
      field("parentSymbolId", 109.7, 1.7),
      field("relativePath", 109.6, 1.6),
      field("git.file.commitCount", 29.5, 2.3),
      field("git.chunk.commitCount", 29.4, 2.2),
      field("git.chunk.blameContributorCount", 29.4, 2.2),
    ],
  },
  other: bytes(0.8, 1.5),
};

const embeddedQdrant = {
  available: true,
  url: "http://127.0.0.1:53178",
  status: "green" as const,
  optimizerStatus: "ok",
  indexSizeBytes: Math.round(1277.8 * MB),
  quantization: "turbo" as const,
};

function primeWith(overrides: { memory?: CollectionMemoryMetrics | null; qdrant?: object } = {}): ProjectDigestData {
  return {
    path: "/repo",
    projectName: null,
    status: {
      isIndexed: true,
      status: "indexed",
      collectionName: "code_8b243ffe",
      filesCount: 1936,
      chunksCount: 30000,
      infraHealth: {
        qdrant: { ...embeddedQdrant, ...overrides.qdrant },
        embedding: { available: true, provider: "ollama" },
      },
    },
    metrics: null,
    drift: null,
    memory: overrides.memory === undefined ? selfIndexMemory : overrides.memory,
  };
}

const at = new Date("2026-09-18T00:00:00Z");

describe("formatFullDigest — one disk figure", () => {
  it("embedded: Status carries the allocated on-disk size and the report's file-size total appears nowhere", () => {
    const out = formatFullDigest(primeWith(), at);

    expect(out).toContain("1936 files / 30000 chunks · 1.2 GB on disk · turbo (8x) quant");
    expect(out).not.toContain("1.9 GB");
  });

  it("external Qdrant: no allocated size to measure, so Status carries the report's total labelled apparent", () => {
    const out = formatFullDigest(primeWith({ qdrant: { indexSizeBytes: undefined } }), at);

    expect(out).toContain("1936 files / 30000 chunks · 1.9 GB apparent size · turbo (8x) quant");
    expect(out).not.toContain("on disk");
  });

  it("external Qdrant without a memory report shows no size at all", () => {
    const out = formatFullDigest(primeWith({ qdrant: { indexSizeBytes: undefined }, memory: null }), at);

    expect(out).toContain("1936 files / 30000 chunks · turbo (8x) quant");
    expect(out).not.toContain("apparent");
  });
});
