import { afterEach, describe, expect, it, vi } from "vitest";

import { PackageJsonVersionSource, type VersionSource } from "../../../src/cli/update-check/version-source.js";

vi.mock("node:fs", async () => {
  const actual = await import("node:fs");
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

describe("PackageJsonVersionSource", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it("throws when package.json has a non-semver version field (invariant violation)", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ version: "not-a-semver" }));
    const src = new PackageJsonVersionSource();
    expect(() => src.getCurrent()).toThrow(/invalid version/);
  });

  it("throws when package.json has no version field at all", async () => {
    const fs = await import("node:fs");
    vi.mocked(fs.readFileSync).mockReturnValueOnce(JSON.stringify({ name: "no-version" }));
    const src = new PackageJsonVersionSource();
    expect(() => src.getCurrent()).toThrow(/invalid version/);
  });
});
