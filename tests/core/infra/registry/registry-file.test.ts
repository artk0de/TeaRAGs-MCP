import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  RegistryConcurrencyError,
  RegistryFileCorruptedError,
  RegistryWriteError,
} from "../../../../src/core/adapters/registry/errors.js";
import {
  flushWithCAS,
  loadRegistryFile,
  mergeRegistryDelta,
  mergeRegistryEntries,
  saveRegistryFile,
} from "../../../../src/core/infra/registry/registry-file.js";
import type { CollectionEntry, RegistryFileV1 } from "../../../../src/core/infra/registry/types.js";

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

function entry(over: Partial<CollectionEntry> = {}): CollectionEntry {
  return {
    collectionName: "code_abc",
    path: "/repo/a",
    name: null,
    embeddingModel: "m",
    embeddingDimensions: 384,
    qdrantUrl: "http://localhost:6333",
    indexedAt: "2026-05-12T00:00:00.000Z",
    teaRagsVersion: "0.1.0",
    chunksCount: 10,
    ...over,
  };
}

describe("mergeRegistryEntries — per-collection LWW with sticky name directional bias", () => {
  it("in-memory wins for non-name fields", () => {
    const disk = entry({ chunksCount: 10 });
    const mem = entry({ chunksCount: 20 });
    expect(mergeRegistryEntries(disk, mem).chunksCount).toBe(20);
  });

  it("in-memory non-null name wins (explicit user action)", () => {
    const disk = entry({ name: "old" });
    const mem = entry({ name: "new" });
    expect(mergeRegistryEntries(disk, mem).name).toBe("new");
  });

  it("disk non-null name wins when in-memory is null (don't erase concurrent rename)", () => {
    const disk = entry({ name: "concurrent" });
    const mem = entry({ name: null });
    expect(mergeRegistryEntries(disk, mem).name).toBe("concurrent");
  });
});

describe("mergeRegistryDelta", () => {
  it("inserts new collections from delta", () => {
    const disk: RegistryFileV1 = {
      version: 1,
      collections: { code_a: entry({ collectionName: "code_a" }) },
    };
    const delta = new Map([["code_b", entry({ collectionName: "code_b", path: "/repo/b" })]]);
    const merged = mergeRegistryDelta(disk, delta);
    expect(Object.keys(merged.collections).sort()).toEqual(["code_a", "code_b"]);
  });

  it("preserves disk-only entries not in delta", () => {
    const disk: RegistryFileV1 = {
      version: 1,
      collections: { code_a: entry({ collectionName: "code_a" }) },
    };
    const merged = mergeRegistryDelta(disk, new Map<string, CollectionEntry>());
    expect(merged.collections.code_a).toBeDefined();
  });

  it("merges overlapping entries through mergeRegistryEntries", () => {
    const disk: RegistryFileV1 = {
      version: 1,
      collections: { code_a: entry({ collectionName: "code_a", name: "disk-name", chunksCount: 5 }) },
    };
    const delta = new Map([["code_a", entry({ collectionName: "code_a", name: null, chunksCount: 99 })]]);
    const merged = mergeRegistryDelta(disk, delta);
    expect(merged.collections.code_a.chunksCount).toBe(99);
    expect(merged.collections.code_a.name).toBe("disk-name");
  });

  it("treats null disk as empty (no prior file)", () => {
    const delta = new Map([["code_a", entry({ collectionName: "code_a" })]]);
    const merged = mergeRegistryDelta(null, delta);
    expect(merged.version).toBe(1);
    expect(merged.collections.code_a).toBeDefined();
  });
});

describe("flushWithCAS retry loop (audit #1)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "regcas-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("succeeds on the first attempt when stat is stable", () => {
    const delta = new Map([["code_a", entry({ collectionName: "code_a" })]]);
    flushWithCAS(dir, delta);
    const saved = loadRegistryFile(dir);
    expect(saved?.collections.code_a).toBeDefined();
  });

  it("retries when inode/mtime changes mid-flush and eventually succeeds", () => {
    saveRegistryFile(dir, { version: 1, collections: {} });
    let callCount = 0;
    const realStat = fs.statSync.bind(fs);
    const spy = vi.spyOn(fs, "statSync").mockImplementation((p: string) => {
      callCount++;
      const real = realStat(p);
      if (callCount === 2) {
        return { ...real, ino: Number(real.ino) + 1, mtimeMs: real.mtimeMs + 1 };
      }
      return real;
    });
    try {
      const delta = new Map([["code_a", entry({ collectionName: "code_a" })]]);
      flushWithCAS(dir, delta);
      const saved = loadRegistryFile(dir);
      expect(saved?.collections.code_a).toBeDefined();
    } finally {
      spy.mockRestore();
    }
  });

  it("throws RegistryConcurrencyError after 5 failed attempts", () => {
    saveRegistryFile(dir, { version: 1, collections: {} });
    const realStat = fs.statSync.bind(fs);
    let flipCount = 0;
    const spy = vi.spyOn(fs, "statSync").mockImplementation((p: string) => {
      flipCount++;
      const real = realStat(p);
      // every "after" call (even index) returns a different ino — never stable
      if (flipCount % 2 === 0) {
        return { ...real, ino: Number(real.ino) + flipCount, mtimeMs: real.mtimeMs + flipCount };
      }
      return real;
    });
    try {
      const delta = new Map([["code_a", entry({ collectionName: "code_a" })]]);
      expect(() => {
        flushWithCAS(dir, delta);
      }).toThrow(RegistryConcurrencyError);
    } finally {
      spy.mockRestore();
    }
  });
});
