import { describe, expect, it } from "vitest";

import {
  getBinaryPath,
  getPlatformAsset,
  isBinaryPresent,
  isBinaryUpToDate,
  QDRANT_VERSION,
} from "../../../../../src/core/adapters/qdrant/embedded/download.js";

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

  it("returns correct asset for win32-x64", () => {
    expect(getPlatformAsset("win32", "x64")).toBe("qdrant-x86_64-pc-windows-msvc.zip");
  });

  it("throws for unsupported platform", () => {
    expect(() => getPlatformAsset("freebsd", "x64")).toThrow(/unsupported platform/i);
  });

  it("throws for unsupported arch", () => {
    expect(() => getPlatformAsset("win32", "arm64")).toThrow(/unsupported platform/i);
  });
});

describe("getBinaryPath", () => {
  it("returns qdrant under qdrant/bin for unix platforms", () => {
    const path = getBinaryPath("darwin");
    expect(path).toMatch(/qdrant[\\/]bin[\\/]qdrant$/);
  });

  it("returns qdrant.exe under qdrant/bin for windows", () => {
    const path = getBinaryPath("win32");
    expect(path).toMatch(/qdrant[\\/]bin[\\/]qdrant\.exe$/);
  });
});

describe("QDRANT_VERSION", () => {
  it("is a valid semver string", () => {
    expect(QDRANT_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("isBinaryUpToDate", () => {
  it("returns false when binary does not exist (real path check)", () => {
    // getBinaryPath points to ~/.tea-rags/qdrant/bin/qdrant which doesn't exist in test env
    expect(isBinaryPresent()).toBe(false);
    expect(isBinaryUpToDate()).toBe(false);
  });
});
