/**
 * The driver crate and the TypeScript side name ONE toolchain (research/rustc-driver/SPEC.md
 * §8.1): the crate's rust-toolchain.toml channel is what `cargo build` uses, the TS pin is
 * what discovery probes and the runner forces. A drift between them builds a driver the
 * runner then rejects on its `-V` banner.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RUSTC_DRIVER_TOOLCHAIN_PIN } from "../../../../src/core/adapters/rustc-driver/pin.js";

const ROOT = join(import.meta.dirname, "../../../../");

function crateToolchainChannel(): string | undefined {
  const toml = readFileSync(join(ROOT, "native/rust-callsites/rust-toolchain.toml"), "utf-8");
  return /^channel\s*=\s*"([^"]+)"/m.exec(toml)?.[1];
}

describe("RUSTC_DRIVER_TOOLCHAIN_PIN", () => {
  it("equals the channel native/rust-callsites/rust-toolchain.toml pins", () => {
    expect(RUSTC_DRIVER_TOOLCHAIN_PIN).toBe(crateToolchainChannel());
  });

  it("is a dated nightly channel (the rustc_plugin pin shape)", () => {
    expect(RUSTC_DRIVER_TOOLCHAIN_PIN).toMatch(/^nightly-\d{4}-\d{2}-\d{2}$/);
  });
});
