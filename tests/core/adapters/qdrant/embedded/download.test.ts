import { describe, it, expect } from "vitest";
import { getPlatformAsset, getBinaryPath, QDRANT_VERSION } from "../../../../../src/core/adapters/qdrant/embedded/download.js";

describe("getPlatformAsset", () => {
  it("returns correct asset for darwin-arm64", () => {
    expect(getPlatformAsset("darwin", "arm64")).toBe("qdrant-aarch64-apple-darwin.tar.gz");
  });

  it("returns correct asset for darwin-x64", () => {
    expect(getPlatformAsset("darwin", "x64")).toBe("qdrant-x86_64-apple-darwin.tar.gz");
  });

  it("returns correct asset for linux-x64", () => {
    expect(getPlatformAsset("linux", "x64")).toBe("qdrant-x86_64-unknown-linux-gnu.tar.gz");
  });

  it("returns correct asset for linux-arm64", () => {
    expect(getPlatformAsset("linux", "arm64")).toBe("qdrant-aarch64-unknown-linux-musl.tar.gz");
  });

  it("throws for unsupported platform", () => {
    expect(() => getPlatformAsset("win32", "x64")).toThrow(/unsupported platform/i);
  });
});

describe("getBinaryPath", () => {
  it("returns path under node_modules/.cache/tea-rags", () => {
    const path = getBinaryPath();
    expect(path).toMatch(/\.cache[\\/]tea-rags[\\/]qdrant/);
  });
});

describe("QDRANT_VERSION", () => {
  it("is a valid semver string", () => {
    expect(QDRANT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
