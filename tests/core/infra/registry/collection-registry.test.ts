import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CollectionRegistry } from "../../../../src/core/infra/registry/collection-registry.js";
import type { CollectionEntry } from "../../../../src/core/infra/registry/types.js";

function makeEntry(over: Partial<CollectionEntry> = {}): Omit<CollectionEntry, "name"> {
  return {
    collectionName: "code_abc",
    path: "/repo/a",
    embeddingModel: "m",
    embeddingDimensions: 384,
    qdrantUrl: "http://localhost:6333",
    indexedAt: "2026-05-12T00:00:00.000Z",
    teaRagsVersion: "0.1.0",
    chunksCount: 10,
    ...over,
  };
}

describe("CollectionRegistry", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creg-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when registry is empty", () => {
    const r = new CollectionRegistry(dir);
    expect(r.get("code_abc")).toBeNull();
    expect(r.findByName("anything")).toBeNull();
    expect(r.list()).toEqual([]);
  });

  it("record() upserts an entry", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    const got = r.get("code_abc");
    expect(got?.path).toBe("/repo/a");
    expect(got?.name).toBeNull();
  });

  it("record() preserves sticky name on second record() call", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    r.setName("code_abc", "alpha");
    r.record(makeEntry({ path: "/repo/a2", chunksCount: 20 }));
    const got = r.get("code_abc");
    expect(got?.name).toBe("alpha");
    expect(got?.path).toBe("/repo/a2");
    expect(got?.chunksCount).toBe(20);
  });

  it("setName() enforces uniqueness across entries", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry({ collectionName: "code_a" }));
    r.record(makeEntry({ collectionName: "code_b", path: "/repo/b" }));
    r.setName("code_a", "shared");
    expect(() => {
      r.setName("code_b", "shared");
    }).toThrow(/not unique/i);
  });

  it("findByName() returns the entry or null", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    r.setName("code_abc", "alpha");
    expect(r.findByName("alpha")?.collectionName).toBe("code_abc");
    expect(r.findByName("missing")).toBeNull();
  });

  it("remove() returns true on existing, false on missing", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    expect(r.remove("code_abc")).toBe(true);
    expect(r.remove("code_abc")).toBe(false);
  });

  it("persists across instances (atomic save)", () => {
    const r1 = new CollectionRegistry(dir);
    r1.record(makeEntry());
    r1.setName("code_abc", "alpha");
    const r2 = new CollectionRegistry(dir);
    expect(r2.findByName("alpha")?.collectionName).toBe("code_abc");
  });

  it("setName(name=null) clears the name", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    r.setName("code_abc", "alpha");
    r.setName("code_abc", null);
    expect(r.get("code_abc")?.name).toBeNull();
  });
});
