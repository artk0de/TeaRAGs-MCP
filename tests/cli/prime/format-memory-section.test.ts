import { describe, expect, it } from "vitest";

import { formatPrime } from "../../../src/cli/prime/format.js";
import type { PrimeData } from "../../../src/cli/prime/types.js";
import type { CollectionMemoryBytes, CollectionMemoryMetrics } from "../../../src/core/api/public/index.js";

// The digest reports ONE disk figure. On embedded Qdrant it is the allocated
// on-disk size tea-rags measures itself (Status line, "on disk"); the server's
// memory report only knows file sizes, which count Qdrant's sparsely
// preallocated mmap space and run far above it (2.07 GB vs 1.2 GB on the
// self-index). So the report contributes RAM and page cache by default, and its
// file sizes appear only as the DEBUG per-component breakdown, labelled apparent.

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

function primeWith(overrides: { memory?: CollectionMemoryMetrics | null; qdrant?: object } = {}): PrimeData {
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
    update: null,
    memory: overrides.memory === undefined ? selfIndexMemory : overrides.memory,
  };
}

const at = new Date("2026-09-18T00:00:00Z");

describe("formatPrime — ## Memory section", () => {
  it("shows the collection's RAM and page cache against what the server wants cached, between Drift and Infra", () => {
    const out = formatPrime(primeWith(), at);

    expect(out).toContain("## Memory\nRAM 74.2 MB · page cache 60.1 MB / 198.5 MB wanted\n");
    expect(out.indexOf("## Drift")).toBeLessThan(out.indexOf("## Memory"));
    expect(out.indexOf("## Memory")).toBeLessThan(out.indexOf("## Infra"));
  });

  it("keeps the per-component breakdown out of the default digest", () => {
    const out = formatPrime(primeWith(), at);

    expect(out).not.toContain("payload indexes");
    expect(out).not.toContain("apparent");
  });

  it("drops the wanted figure when the server wants nothing cached", () => {
    const memory = { ...selfIndexMemory, total: bytes(1978.4, 74.2, 0, 0) };

    const out = formatPrime(primeWith({ memory }), at);

    expect(out).toContain("## Memory\nRAM 74.2 MB · page cache 0 B\n");
  });

  it("omits the section when the server gave no memory report", () => {
    expect(formatPrime(primeWith({ memory: null }), at)).not.toContain("## Memory");
    const { memory: _omitted, ...withoutField } = primeWith();
    expect(formatPrime(withoutField, at)).not.toContain("## Memory");
  });

  it("under DEBUG lists every component as apparent size / RAM / page cache, top payload indexes by size", () => {
    const out = formatPrime(primeWith(), at, { debug: true });

    expect(out).toContain(
      [
        "## Memory",
        "RAM 74.2 MB · page cache 60.1 MB / 198.5 MB wanted",
        "per component — apparent size / RAM / page cache (apparent counts preallocated mmap space, sums above on-disk):",
        "- dense storage: 197.0 MB / 0 B / 60.1 MB",
        "- dense index: 1.4 MB / 0 B / 0 B",
        "- dense quantized: 103.2 MB / 7.1 MB / 0 B",
        "- sparse text storage: 170.2 MB / 0 B / 0 B",
        "- sparse text index: 5.9 MB / 9.9 MB / 0 B",
        "- payload: 165.2 MB / 0 B / 0 B",
        "- payload indexes (46): 1.3 GB / 55.6 MB / 0 B",
        "  - symbolId: 110.0 MB / 3.3 MB / 0 B",
        "  - parentSymbolId: 109.7 MB / 1.7 MB / 0 B",
        "  - relativePath: 109.6 MB / 1.6 MB / 0 B",
        "  - git.file.commitCount: 29.5 MB / 2.3 MB / 0 B",
        "  - git.chunk.commitCount: 29.4 MB / 2.2 MB / 0 B",
        "  - +41 more",
        "- other: 819.2 KB / 1.5 MB / 0 B",
      ].join("\n"),
    );
  });

  it("names the unnamed default vector dense", () => {
    const memory = {
      ...selfIndexMemory,
      vectors: [{ name: "", storage: bytes(10, 0), index: bytes(1, 0) }],
    };

    const out = formatPrime(primeWith({ memory }), at, { debug: true });

    expect(out).toContain("- dense storage: 10.0 MB / 0 B / 0 B");
    expect(out).not.toContain("dense quantized");
  });
});

describe("formatPrime — one disk figure", () => {
  it("embedded: Status carries the allocated on-disk size and the report's file-size total appears nowhere", () => {
    for (const debug of [false, true]) {
      const out = formatPrime(primeWith(), at, { debug });

      expect(out).toContain("1936 files / 30000 chunks · 1.2 GB on disk · turbo (8x) quant");
      expect(out).not.toContain("1.9 GB");
    }
  });

  it("external Qdrant: no allocated size to measure, so Status carries the report's total labelled apparent", () => {
    const out = formatPrime(primeWith({ qdrant: { indexSizeBytes: undefined } }), at);

    expect(out).toContain("1936 files / 30000 chunks · 1.9 GB apparent size · turbo (8x) quant");
    expect(out).not.toContain("on disk");
  });

  it("external Qdrant without a memory report shows no size at all", () => {
    const out = formatPrime(primeWith({ qdrant: { indexSizeBytes: undefined }, memory: null }), at);

    expect(out).toContain("1936 files / 30000 chunks · turbo (8x) quant");
    expect(out).not.toContain("apparent");
  });
});
