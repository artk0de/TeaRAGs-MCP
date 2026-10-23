/**
 * The Rust index source the in-thread `LanguageFactory` receives (bd s3i8m
 * T8): the rustc call-site source, built from its plain-data slot and absent
 * when the slot is off.
 */
import { describe, expect, it } from "vitest";

import { processRustcCallSiteSource } from "../../../../../src/core/adapters/rustc-driver/callsite-source.js";
import { rustIndexSourcesOf } from "../../../../../src/core/domains/trajectory/codegraph/factory.js";

const RUST_DRIVER = { enabled: true, timeoutSec: 3600, maxRssMb: 12_288, spawn: "allowed" as const };

describe("rustIndexSourcesOf", () => {
  it("hands the factory the process-scoped rustc call-site source of the slot", () => {
    const sources = rustIndexSourcesOf({ rustDriver: RUST_DRIVER });
    expect(sources.rustcCallSiteSource).toBe(processRustcCallSiteSource(RUST_DRIVER));
    expect(Object.keys(sources)).toEqual(["rustcCallSiteSource"]);
  });

  it("passes no source for an absent or disabled slot", () => {
    expect(rustIndexSourcesOf({})).toEqual({});
    expect(rustIndexSourcesOf({ rustDriver: { ...RUST_DRIVER, enabled: false } })).toEqual({});
  });
});
