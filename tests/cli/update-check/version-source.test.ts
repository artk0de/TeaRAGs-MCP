import { describe, expect, it } from "vitest";

import { PackageJsonVersionSource, type VersionSource } from "../../../src/cli/update-check/version-source.js";

describe("PackageJsonVersionSource", () => {
  it("reads the version field from the package's package.json", () => {
    const src = new PackageJsonVersionSource();
    const v = src.getCurrent();
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("satisfies the VersionSource interface", () => {
    const src: VersionSource = new PackageJsonVersionSource();
    expect(typeof src.getCurrent).toBe("function");
    expect(typeof src.getCurrent()).toBe("string");
  });
});
