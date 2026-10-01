/**
 * The `npm run build` asset step (bd tea-rags-mcp-bbo1h.3).
 *
 * `tsc` emits only what a module graph imports; a data file a module reads from
 * disk beside itself (`new URL("./x.json", import.meta.url)`) never reaches
 * `build/` on its own, and the compiled module then fails on first use — in the
 * chunker worker, far from the build. This step copies each such asset to the
 * same relative place under `build/`, and fails the build when one is missing.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { BUILD_ASSETS, copyBuildAssets } from "../../scripts/copy-build-assets.js";

describe("copyBuildAssets (bbo1h.3)", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), "copy-build-assets-"));
  });

  afterEach(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  function writeSource(asset: string, contents: string): void {
    const file = join(repoRoot, "src", asset);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }

  it("copies each asset to the same relative path under build/, creating its directory", () => {
    writeSource("core/data/vocab.json", '{"v":1}\n');

    copyBuildAssets(repoRoot, ["core/data/vocab.json"]);

    expect(readFileSync(join(repoRoot, "build/core/data/vocab.json"), "utf8")).toBe('{"v":1}\n');
  });

  it("overwrites a stale copy left by an earlier build", () => {
    writeSource("core/data/vocab.json", '{"v":2}\n');
    mkdirSync(join(repoRoot, "build/core/data"), { recursive: true });
    writeFileSync(join(repoRoot, "build/core/data/vocab.json"), '{"v":1}\n', "utf8");

    copyBuildAssets(repoRoot, ["core/data/vocab.json"]);

    expect(readFileSync(join(repoRoot, "build/core/data/vocab.json"), "utf8")).toBe('{"v":2}\n');
  });

  it("fails when a listed asset does not exist, rather than shipping a build without it", () => {
    expect(() => {
      copyBuildAssets(repoRoot, ["core/data/missing.json"]);
    }).toThrow(/missing\.json/);
    expect(existsSync(join(repoRoot, "build/core/data/missing.json"))).toBe(false);
  });

  it("lists only assets that exist in this repository's src/", () => {
    const realRoot = resolve(import.meta.dirname, "../..");
    expect(BUILD_ASSETS.length).toBeGreaterThan(0);
    for (const asset of BUILD_ASSETS) expect(existsSync(join(realRoot, "src", asset)), asset).toBe(true);
  });

  it("ships the Swift SDK vocabulary the Swift resolver reads beside its compiled reader", () => {
    expect(BUILD_ASSETS).toContain("core/domains/language/swift/vocabulary/sdk-vocabulary.generated.json");
  });
});
