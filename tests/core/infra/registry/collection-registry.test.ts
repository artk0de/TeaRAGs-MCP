import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  it("recovers as empty when registry.json is corrupt (writes warning, no throw)", () => {
    // Pre-write a corrupt file. CollectionRegistry must log to stderr and
    // start with an empty map — this is the safety net for users with a
    // damaged registry, exercised end-to-end via the first ensureLoaded() call.
    writeFileSync(join(dir, "registry.json"), "{not-json", "utf-8");
    const stderr: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((m: string) => {
      stderr.push(String(m));
      return true;
    }) as never);
    try {
      const r = new CollectionRegistry(dir);
      expect(r.list()).toEqual([]);
      expect(r.get("anything")).toBeNull();
      // After fallback, a record() must still work and persist.
      r.record(makeEntry());
      expect(r.get("code_abc")?.path).toBe("/repo/a");
      // The corrupt file must have been preserved as a .bak before fallback.
      const filesAfter = readdirSync(dir);
      expect(filesAfter.some((f: string) => f.startsWith("registry.json.corrupt-"))).toBe(true);
    } finally {
      spy.mockRestore();
    }
    expect(stderr.join("")).toMatch(/registry corrupt/);
  });

  it("setName() throws when collection is not in registry", () => {
    const r = new CollectionRegistry(dir);
    expect(() => {
      r.setName("code_missing", "alpha");
    }).toThrow(/not in registry/);
  });

  it("setName() rejects names that do not match the NAME_RE", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    expect(() => {
      r.setName("code_abc", "BAD NAME!");
    }).toThrow(/does not match/);
    expect(() => {
      r.setName("code_abc", "-leading-dash");
    }).toThrow(/does not match/);
    expect(() => {
      r.setName("code_abc", "");
    }).toThrow(/does not match/);
  });

  describe("record() input validation (audit #11)", () => {
    it("rejects empty collectionName", () => {
      const r = new CollectionRegistry(dir);
      expect(() => {
        r.record(makeEntry({ collectionName: "" }));
      }).toThrow(/collectionName/);
    });

    it("rejects whitespace-only collectionName", () => {
      const r = new CollectionRegistry(dir);
      expect(() => {
        r.record(makeEntry({ collectionName: "   " }));
      }).toThrow(/collectionName/);
    });

    it("rejects negative embeddingDimensions", () => {
      const r = new CollectionRegistry(dir);
      expect(() => {
        r.record(makeEntry({ embeddingDimensions: -1 }));
      }).toThrow(/embeddingDimensions/);
    });

    it("rejects negative chunksCount", () => {
      const r = new CollectionRegistry(dir);
      expect(() => {
        r.record(makeEntry({ chunksCount: -5 }));
      }).toThrow(/chunksCount/);
    });

    it("accepts entries with empty embeddingModel and qdrantUrl (stub from future recoverFromQdrant)", () => {
      // PR2 audit #5 will tighten this — for now ensure stubs still round-trip.
      const r = new CollectionRegistry(dir);
      expect(() => {
        r.record(makeEntry({ embeddingModel: "", qdrantUrl: "", indexedAt: "" }));
      }).not.toThrow();
    });

    it("accepts zero embeddingDimensions (stub entries from doctor recovery)", () => {
      const r = new CollectionRegistry(dir);
      expect(() => {
        r.record(makeEntry({ embeddingDimensions: 0 }));
      }).not.toThrow();
    });

    it("accepts zero chunksCount (just-created empty collection)", () => {
      const r = new CollectionRegistry(dir);
      expect(() => {
        r.record(makeEntry({ chunksCount: 0 }));
      }).not.toThrow();
    });
  });

  it("tombstone prevents resurrection when concurrent disk write reintroduces removed entry (audit #1)", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry({ collectionName: "code_a", path: "/repo/a" }));
    // Confirm baseline.
    expect(r.get("code_a")?.path).toBe("/repo/a");
    // Remove A — tombstone is set, file is written without A.
    expect(r.remove("code_a")).toBe(true);
    // Simulate a concurrent writer that reintroduces A on disk.
    const registryPath = join(dir, "registry.json");
    const onDisk = JSON.parse(readFileSync(registryPath, "utf-8")) as {
      collections: Record<string, unknown>;
    };
    onDisk.collections.code_a = {
      collectionName: "code_a",
      path: "/repo/zombie",
      name: null,
      embeddingModel: "m",
      embeddingDimensions: 384,
      qdrantUrl: "http://localhost:6333",
      indexedAt: "2026-05-12T00:00:00.000Z",
      teaRagsVersion: "0.1.0",
      chunksCount: 10,
    };
    writeFileSync(registryPath, JSON.stringify(onDisk, null, 2), "utf-8");
    // Now perform another flush via a record() of an unrelated collection.
    r.record(makeEntry({ collectionName: "code_b", path: "/repo/b" }));
    // The tombstone in our process must keep A out of the merged file.
    const finalDisk = JSON.parse(readFileSync(registryPath, "utf-8")) as {
      collections: Record<string, unknown>;
    };
    expect(finalDisk.collections.code_a).toBeUndefined();
    expect(finalDisk.collections.code_b).toBeDefined();
  });
});
