import { describe, expect, it } from "vitest";

import { formatPrime } from "../../../src/cli/prime/format.js";
import type { PrimeData } from "../../../src/cli/prime/types.js";
import { RUST_ANALYZER_INSTALL_HINT } from "../../../src/core/adapters/rust-analyzer/index.js";

function data(overrides: Partial<PrimeData> = {}): PrimeData {
  return {
    path: "/repo",
    projectName: null,
    status: { isIndexed: true, status: "indexed", collectionName: "c", chunksCount: 100 },
    metrics: null,
    drift: null,
    update: null,
    ...overrides,
  };
}

describe("formatPrime — rust-analyzer install hint (s3i8m.6)", () => {
  it("renders the hint as one line when PrimeData carries it", () => {
    const out = formatPrime(data({ rustAnalyzerHint: RUST_ANALYZER_INSTALL_HINT }));
    const lines = out.split("\n").filter((l) => l.includes("rust-analyzer not found"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(RUST_ANALYZER_INSTALL_HINT);
  });

  it("renders nothing when the hint is null or absent", () => {
    expect(formatPrime(data({ rustAnalyzerHint: null }))).not.toContain("rust-analyzer");
    expect(formatPrime(data())).not.toContain("rust-analyzer");
  });
});
