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

describe("formatPrime — rustc driver line (s3i8m T9)", () => {
  it("renders one driver line when PrimeData carries a status, after the rust-analyzer hint", () => {
    const out = formatPrime(
      data({
        rustAnalyzerHint: RUST_ANALYZER_INSTALL_HINT,
        rustcDriver: {
          outcome: "indexed",
          cacheHit: false,
          units: 412,
          failedCrates: ["servo-capi-tests"],
          wallMs: 648_000,
        },
      }),
    );
    const lines = out.split("\n").filter((l) => l.startsWith("rustc driver:"));
    expect(lines).toEqual([
      "rustc driver: indexed (cargo check ran build scripts and proc macros) · units 412 · failed 1 (servo-capi-tests) · 648 s",
    ]);
    expect(out.indexOf("rustc driver:")).toBeGreaterThan(out.indexOf("rust-analyzer not found"));
  });

  it("renders the unavailable and off variants", () => {
    expect(formatPrime(data({ rustcDriver: { outcome: "unavailable", hint: "get a toolchain" } }))).toContain(
      "rustc driver: unavailable — get a toolchain",
    );
    expect(formatPrime(data({ rustcDriver: { outcome: "off" } }))).toContain(
      "rustc driver: off (CODEGRAPH_RUST_DRIVER=off)",
    );
  });

  it("renders nothing when the status is null or absent", () => {
    expect(formatPrime(data({ rustcDriver: null }))).not.toContain("rustc driver");
    expect(formatPrime(data())).not.toContain("rustc driver");
  });
});
