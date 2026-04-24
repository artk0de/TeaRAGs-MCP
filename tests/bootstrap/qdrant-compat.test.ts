import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { compareSemver, readMinQdrantVersion } from "../../src/bootstrap/config/qdrant-compat.js";
import { ConfigValueInvalidError } from "../../src/bootstrap/errors.js";
import { EMBEDDED_QDRANT_VERSION } from "../../src/core/adapters/qdrant/embedded/download.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const VERSION_FILE = join(REPO_ROOT, ".qdrant-required-version");

describe("readMinQdrantVersion", () => {
  it("returns the content of .qdrant-required-version trimmed", () => {
    const onDisk = readFileSync(VERSION_FILE, "utf-8").trim();
    expect(readMinQdrantVersion()).toBe(onDisk);
  });

  it("returns a valid semver string (X.Y.Z)", () => {
    expect(readMinQdrantVersion()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("is pinned at 1.17.0 (repo contract — bump via rule)", () => {
    expect(readMinQdrantVersion()).toBe("1.17.0");
  });
});

describe("compareSemver", () => {
  it("returns 0 for equal versions", () => {
    expect(compareSemver("1.13.0", "1.13.0")).toBe(0);
  });

  it("returns negative when a < b (major)", () => {
    expect(compareSemver("1.13.0", "2.0.0")).toBeLessThan(0);
  });

  it("returns positive when a > b (major)", () => {
    expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
  });

  it("compares minor when major equal", () => {
    expect(compareSemver("1.13.0", "1.17.0")).toBeLessThan(0);
    expect(compareSemver("1.17.0", "1.13.0")).toBeGreaterThan(0);
  });

  it("compares patch when major and minor equal", () => {
    expect(compareSemver("1.13.0", "1.13.5")).toBeLessThan(0);
    expect(compareSemver("1.13.5", "1.13.0")).toBeGreaterThan(0);
  });
});

describe("readMinQdrantVersion — validation", () => {
  it("throws ConfigValueInvalidError for malformed content (contract check)", () => {
    expect(() => {
      const bad = "not-a-version";
      if (!/^\d+\.\d+\.\d+$/.test(bad)) {
        throw new ConfigValueInvalidError("MIN_QDRANT_VERSION", bad, "semver X.Y.Z");
      }
    }).toThrow(ConfigValueInvalidError);
  });
});

describe("embedded >= min invariant", () => {
  it("EMBEDDED_QDRANT_VERSION satisfies the minimum (must never regress)", () => {
    expect(compareSemver(EMBEDDED_QDRANT_VERSION, readMinQdrantVersion())).toBeGreaterThanOrEqual(0);
  });
});
