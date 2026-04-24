import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compareSemver, isSemver, QDRANT_VERSION } from "../../../src/core/infra/qdrant-version.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const VERSION_FILE = join(REPO_ROOT, ".qdrant-required-version");

describe("QDRANT_VERSION", () => {
  it("equals the content of .qdrant-required-version trimmed", () => {
    const onDisk = readFileSync(VERSION_FILE, "utf-8").trim();
    expect(QDRANT_VERSION).toBe(onDisk);
  });

  it("is a valid semver X.Y.Z", () => {
    expect(QDRANT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("compareSemver", () => {
  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.17.0", "1.17.0")).toBe(0);
  });

  it("returns negative when a < b (major)", () => {
    expect(compareSemver("1.17.0", "2.0.0")).toBeLessThan(0);
  });

  it("returns positive when a > b (major)", () => {
    expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  it("compares minor when major equal", () => {
    expect(compareSemver("1.13.0", "1.17.0")).toBeLessThan(0);
    expect(compareSemver("1.17.0", "1.13.0")).toBeGreaterThan(0);
  });

  it("compares patch when major and minor equal", () => {
    expect(compareSemver("1.17.0", "1.17.5")).toBeLessThan(0);
    expect(compareSemver("1.17.5", "1.17.0")).toBeGreaterThan(0);
  });

  it("throws on non-semver inputs", () => {
    expect(() => compareSemver("not-a-version", "1.17.0")).toThrow();
    expect(() => compareSemver("1.17.0", "v1.17.0")).toThrow();
  });
});

describe("isSemver", () => {
  it("accepts X.Y.Z", () => {
    expect(isSemver("1.17.0")).toBe(true);
    expect(isSemver("0.0.1")).toBe(true);
    expect(isSemver("10.20.30")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isSemver("v1.17.0")).toBe(false);
    expect(isSemver("1.17")).toBe(false);
    expect(isSemver("1.17.0-alpha")).toBe(false);
    expect(isSemver("")).toBe(false);
    expect(isSemver("not-a-version")).toBe(false);
  });
});
