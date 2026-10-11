import { describe, expect, it } from "vitest";

import { defaultIoBoundPoolSize } from "../../../../src/core/primitives/concurrency/default-io-bound-pool-size.js";

describe("defaultIoBoundPoolSize", () => {
  it("floors at 1 for a single cpu", () => {
    expect(defaultIoBoundPoolSize(1)).toBe(1);
  });

  it("floors at 1 for a degenerate zero-cpu reading", () => {
    expect(defaultIoBoundPoolSize(0)).toBe(1);
  });

  it("spares one core in the mid range", () => {
    expect(defaultIoBoundPoolSize(2)).toBe(1);
    expect(defaultIoBoundPoolSize(5)).toBe(4);
    expect(defaultIoBoundPoolSize(8)).toBe(7);
  });

  it("caps at 10 on many-core hosts", () => {
    expect(defaultIoBoundPoolSize(11)).toBe(10);
    expect(defaultIoBoundPoolSize(16)).toBe(10);
    expect(defaultIoBoundPoolSize(32)).toBe(10);
  });
});
