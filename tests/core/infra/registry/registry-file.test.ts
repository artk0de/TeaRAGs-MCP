import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RegistryFileCorruptedError, RegistryWriteError } from "../../../../src/core/infra/registry/errors.js";
import { loadRegistryFile, saveRegistryFile } from "../../../../src/core/infra/registry/registry-file.js";
import type { RegistryFileV1 } from "../../../../src/core/infra/registry/types.js";

describe("registry-file", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tea-rags-registry-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("loadRegistryFile returns null when file is missing", () => {
    expect(loadRegistryFile(dir)).toBeNull();
  });

  it("loadRegistryFile parses a valid v1 file", () => {
    const file: RegistryFileV1 = { version: 1, collections: {} };
    writeFileSync(join(dir, "registry.json"), JSON.stringify(file), "utf-8");
    const loaded = loadRegistryFile(dir);
    expect(loaded).toEqual(file);
  });

  it("loadRegistryFile throws RegistryFileCorruptedError on invalid JSON", () => {
    writeFileSync(join(dir, "registry.json"), "{not json", "utf-8");
    expect(() => loadRegistryFile(dir)).toThrow(RegistryFileCorruptedError);
  });

  it("loadRegistryFile throws on unknown version", () => {
    writeFileSync(join(dir, "registry.json"), JSON.stringify({ version: 99, collections: {} }), "utf-8");
    expect(() => loadRegistryFile(dir)).toThrow(RegistryFileCorruptedError);
  });

  it("saveRegistryFile writes atomically (tmp + rename)", () => {
    const file: RegistryFileV1 = { version: 1, collections: {} };
    saveRegistryFile(dir, file);
    expect(existsSync(join(dir, "registry.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "registry.json"), "utf-8"))).toEqual(file);
    expect(existsSync(join(dir, `registry.json.tmp.${process.pid}`))).toBe(false);
  });

  it("saveRegistryFile creates dataDir if missing", () => {
    const nested = join(dir, "deeper");
    saveRegistryFile(nested, { version: 1, collections: {} });
    expect(existsSync(join(nested, "registry.json"))).toBe(true);
  });

  it("loadRegistryFile rejects when JSON root is a primitive (string)", () => {
    // typeof "hi" === "string" -> root-not-object branch
    writeFileSync(join(dir, "registry.json"), JSON.stringify("hi"), "utf-8");
    expect(() => loadRegistryFile(dir)).toThrow(/root is not an object/);
  });

  it("loadRegistryFile rejects when collections is not an object", () => {
    writeFileSync(join(dir, "registry.json"), JSON.stringify({ version: 1, collections: "oops" }), "utf-8");
    expect(() => loadRegistryFile(dir)).toThrow(/collections is not an object/);
  });

  it("loadRegistryFile rejects when JSON root is `null` literal", () => {
    writeFileSync(join(dir, "registry.json"), "null", "utf-8");
    expect(() => loadRegistryFile(dir)).toThrow(/root is not an object/);
  });

  it("saveRegistryFile wraps fs errors in RegistryWriteError when target is unwritable", () => {
    // Make registry.json an existing *directory* — rename(tmp, registry.json) fails.
    mkdirSync(join(dir, "registry.json"), { recursive: true });
    expect(() => {
      saveRegistryFile(dir, { version: 1, collections: {} });
    }).toThrow(RegistryWriteError);
  });
});
