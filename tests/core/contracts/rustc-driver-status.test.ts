import { describe, expect, it } from "vitest";

import { formatRustcDriverLine, rustcDriverStatusOf } from "../../../src/core/contracts/rustc-driver-status.js";

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
      "rustc driver: unavailable — Rust call edges are static-only (lower bound); install with 'rustup toolchain install nightly-2026-05-01 -c rustc-dev,rust-src' (≈1.5 GB), or set CODEGRAPH_RUST_DRIVER_PATH",
    );
  });

  it("keeps a hint of another shape whole", () => {
    expect(formatRustcDriverLine({ outcome: "unavailable", hint: "get a toolchain" })).toBe(
      "rustc driver: unavailable — Rust call edges are static-only (lower bound); get a toolchain",
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

describe("rustcDriverStatusOf", () => {
  it("is absent when no Rust resolve pass reported a call-site acquisition", () => {
    expect(rustcDriverStatusOf({})).toBeUndefined();
    expect(rustcDriverStatusOf({ typescript: { program: "reused" } })).toBeUndefined();
    expect(rustcDriverStatusOf({ rust: { rustAnalyzerScip: { outcome: "indexed" } } })).toBeUndefined();
  });

  it("maps an indexed acquisition with its cache, units, failed crates and wall time", () => {
    expect(
      rustcDriverStatusOf({
        rust: {
          rustcCallSites: {
            outcome: "indexed",
            cacheHit: false,
            wallMs: 648_000,
            units: 412,
            failedCrates: ["servo-capi-tests"],
          },
        },
      }),
    ).toEqual({ outcome: "indexed", cacheHit: false, wallMs: 648_000, units: 412, failedCrates: ["servo-capi-tests"] });
  });

  it("maps a latch with its reason, detail and hint", () => {
    expect(
      rustcDriverStatusOf({
        rust: {
          rustcCallSites: { outcome: "latched", reason: "allUnitsFailed", detail: "E0463", hint: "cargo fetch" },
        },
      }),
    ).toEqual({ outcome: "latched", reason: "allUnitsFailed", detail: "E0463", hint: "cargo fetch" });
  });

  it("maps the switched-off skip to off, the toolchain-less skip to unavailable with its hint", () => {
    expect(rustcDriverStatusOf({ rust: { rustcCallSites: { outcome: "skipped", reason: "disabled" } } })).toEqual({
      outcome: "off",
    });
    expect(
      rustcDriverStatusOf({
        rust: { rustcCallSites: { outcome: "skipped", reason: "unavailable", hint: INSTALL_HINT } },
      }),
    ).toEqual({ outcome: "unavailable", hint: INSTALL_HINT });
  });

  it("keeps any other skip as skipped with its reason", () => {
    expect(rustcDriverStatusOf({ rust: { rustcCallSites: { outcome: "skipped", reason: "noBulkNoCache" } } })).toEqual({
      outcome: "skipped",
      reason: "noBulkNoCache",
    });
  });

  it("is absent for an outcome it does not know", () => {
    expect(rustcDriverStatusOf({ rust: { rustcCallSites: { outcome: "exploded" } } })).toBeUndefined();
  });
});
