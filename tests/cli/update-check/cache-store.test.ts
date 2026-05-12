import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { FileCacheStore } from "../../../src/cli/update-check/cache-store.js";
import type { CacheEntry } from "../../../src/cli/update-check/types.js";

let tmpRoot: string;
let cachePath: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "tea-rags-cache-test-"));
  cachePath = join(tmpRoot, "update-check.json");
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function sampleEntry(): CacheEntry {
  return {
    status: {
      kind: "available",
      current: "1.0.0",
      latest: "1.1.0",
      changelogUrl: "https://x",
    },
    fetchedAt: 1_700_000_000_000,
    ttlMs: 86_400_000,
  };
}

describe("FileCacheStore", () => {
  it("read() returns null when the file does not exist", () => {
    const store = new FileCacheStore(cachePath);
    expect(store.read()).toBeNull();
  });

  it("write() then read() round-trips an entry", () => {
    const store = new FileCacheStore(cachePath);
    const entry = sampleEntry();
    store.write(entry);
    expect(store.read()).toEqual(entry);
  });

  it("write() creates parent directory if missing", () => {
    const nested = join(tmpRoot, "deep", "nested", "update-check.json");
    const store = new FileCacheStore(nested);
    store.write(sampleEntry());
    expect(existsSync(nested)).toBe(true);
  });

  it("read() returns null AND deletes the file when JSON is corrupt", () => {
    writeFileSync(cachePath, "{ not valid json", "utf-8");
    const store = new FileCacheStore(cachePath);
    expect(store.read()).toBeNull();
    expect(existsSync(cachePath)).toBe(false);
  });

  it("read() returns null AND deletes the file when schema is wrong", () => {
    writeFileSync(cachePath, JSON.stringify({ foo: "bar" }), "utf-8");
    const store = new FileCacheStore(cachePath);
    expect(store.read()).toBeNull();
    expect(existsSync(cachePath)).toBe(false);
  });

  it("write() uses tmp+rename so file is never partially written", () => {
    const store = new FileCacheStore(cachePath);
    store.write(sampleEntry());
    const stray = readFileSync(cachePath, "utf-8");
    expect(stray).toContain(`"kind":"available"`);
  });
});
