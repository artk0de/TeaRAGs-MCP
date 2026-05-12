import { describe, expect, it } from "vitest";

import { compareSemver, isValidSemver } from "../../../src/cli/update-check/semver.js";

describe("compareSemver", () => {
  it("returns 0 when versions are equal", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  it("returns -1 when a < b (patch)", () => {
    expect(compareSemver("1.2.3", "1.2.4")).toBe(-1);
  });

  it("returns 1 when a > b (patch)", () => {
    expect(compareSemver("1.2.4", "1.2.3")).toBe(1);
  });

  it("returns -1 when a < b (minor)", () => {
    expect(compareSemver("1.2.9", "1.3.0")).toBe(-1);
  });

  it("returns -1 when a < b (major)", () => {
    expect(compareSemver("1.99.99", "2.0.0")).toBe(-1);
  });

  it("normalises sign to -1 / 0 / 1 (never raw subtraction)", () => {
    expect(compareSemver("1.0.0", "5.0.0")).toBe(-1);
    expect(compareSemver("5.0.0", "1.0.0")).toBe(1);
  });

  it("throws on invalid semver in either argument", () => {
    expect(() => compareSemver("1.2", "1.2.3")).toThrow();
    expect(() => compareSemver("1.2.3", "v1.2.3")).toThrow();
    expect(() => compareSemver("not-semver", "1.2.3")).toThrow();
  });
});

describe("isValidSemver", () => {
  it.each(["0.0.0", "1.2.3", "1.23.456", "10.20.30"])("accepts X.Y.Z form: %s", (v) => {
    expect(isValidSemver(v)).toBe(true);
  });

  it.each(["1.2", "1.2.3.4", "v1.2.3", "1.2.3-rc.1", "", "abc"])("rejects non X.Y.Z form: %s", (v) => {
    expect(isValidSemver(v)).toBe(false);
  });
});
