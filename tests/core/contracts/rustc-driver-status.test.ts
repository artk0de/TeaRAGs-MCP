import { describe, expect, it } from "vitest";

import { formatRustcDriverLine } from "../../../src/core/contracts/rustc-driver-status.js";

const INSTALL_HINT =
  "rustc call-site driver unavailable — install with 'rustup toolchain install nightly-2026-05-01 -c rustc-dev,rust-src' (≈1.5 GB), or set CODEGRAPH_RUST_DRIVER_PATH";

describe("formatRustcDriverLine", () => {
  it("says cargo check ran build scripts and proc macros, with units, failed crates and wall time", () => {
    expect(
      formatRustcDriverLine({
        outcome: "indexed",
        cacheHit: false,
        units: 412,
        failedCrates: ["servo-capi-tests"],
        wallMs: 648_000,
      }),
    ).toBe(
      "rustc driver: indexed (cargo check ran build scripts and proc macros) · units 412 · failed 1 (servo-capi-tests) · 648 s",
    );
  });

  it("renders what exists: no units, no failures, no wall time", () => {
    expect(formatRustcDriverLine({ outcome: "indexed", cacheHit: false })).toBe(
      "rustc driver: indexed (cargo check ran build scripts and proc macros)",
    );
  });

  it("does not claim cargo check ran on a cache hit", () => {
    expect(formatRustcDriverLine({ outcome: "indexed", cacheHit: true, wallMs: 1200 })).toBe(
      "rustc driver: indexed (cache hit, cargo check not re-run) · 1 s",
    );
  });

  it("lists at most three failed crate names and counts the rest", () => {
    const line = formatRustcDriverLine({
      outcome: "indexed",
      cacheHit: false,
      failedCrates: ["a", "b", "c", "d", "e"],
    });
    expect(line).toContain("failed 5 (a, b, c, +2 more)");
  });

  it("shows the install hint when no toolchain was found, without repeating the subject", () => {
    expect(formatRustcDriverLine({ outcome: "unavailable", hint: INSTALL_HINT })).toBe(
      "rustc driver: unavailable — install with 'rustup toolchain install nightly-2026-05-01 -c rustc-dev,rust-src' (≈1.5 GB), or set CODEGRAPH_RUST_DRIVER_PATH",
    );
  });

  it("keeps a hint of another shape whole", () => {
    expect(formatRustcDriverLine({ outcome: "unavailable", hint: "get a toolchain" })).toBe(
      "rustc driver: unavailable — get a toolchain",
    );
  });

  it("says the driver is off with its switch", () => {
    expect(formatRustcDriverLine({ outcome: "off" })).toBe("rustc driver: off (CODEGRAPH_RUST_DRIVER=off)");
  });

  it("says latched with reason and detail, and the hint when there is one", () => {
    expect(formatRustcDriverLine({ outcome: "latched", reason: "driverBuild", detail: "cargo build failed" })).toBe(
      "rustc driver: latched — driverBuild (cargo build failed)",
    );
    expect(
      formatRustcDriverLine({
        outcome: "latched",
        reason: "allUnitsFailed",
        detail: "0 of 12 units",
        hint: "run cargo fetch",
      }),
    ).toBe("rustc driver: latched — allUnitsFailed (0 of 12 units) — run cargo fetch");
  });

  it("says skipped with the reason", () => {
    expect(formatRustcDriverLine({ outcome: "skipped", reason: "reuseOnly" })).toBe(
      "rustc driver: skipped — reuseOnly",
    );
  });
});
