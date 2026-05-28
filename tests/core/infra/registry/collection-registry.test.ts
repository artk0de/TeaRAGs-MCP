import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CollectionRegistry } from "../../../../src/core/infra/registry/collection-registry.js";
import { saveRegistryFile } from "../../../../src/core/infra/registry/registry-file.js";
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

  describe("startWatching() — fs.watch cache invalidation (audit #2)", () => {
    it("returns a stop function", () => {
      const r = new CollectionRegistry(dir);
      const stop = r.startWatching();
      expect(typeof stop).toBe("function");
      stop();
    });

    it("invalidates the cache when registry.json changes on disk", async () => {
      const r = new CollectionRegistry(dir);
      r.record(makeEntry({ collectionName: "code_a", path: "/repo/a" }));
      const stop = r.startWatching();
      expect(r.get("code_a")?.path).toBe("/repo/a");
      // Yield so fs.watch finishes attaching to the file's inode
      // (kqueue/inotify subscription is set up asynchronously).
      await new Promise((resolve) => setTimeout(resolve, 50));

      // External writer (simulating a parallel CLI/pipeline process) mutates
      // registry.json behind r's back. Then r.get must re-read and see it.
      saveRegistryFile(dir, {
        version: 1,
        collections: {
          code_a: {
            collectionName: "code_a",
            path: "/repo/b-external",
            name: null,
            embeddingModel: "m",
            embeddingDimensions: 384,
            qdrantUrl: "http://localhost:6333",
            indexedAt: "2026-05-13T00:00:00.000Z",
            teaRagsVersion: "0.1.0",
            chunksCount: 10,
          },
        },
      });

      // Allow fs.watch event to dispatch.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(r.get("code_a")?.path).toBe("/repo/b-external");
      stop();
    });

    it("is idempotent — second call returns the same stop handle", () => {
      const r = new CollectionRegistry(dir);
      const stop1 = r.startWatching();
      const stop2 = r.startWatching();
      expect(stop1).toBe(stop2);
      stop1();
    });

    it("tolerates a missing file at construction time (does not throw)", () => {
      // dir is empty — no registry.json has been created yet. startWatching
      // must not throw; the watcher may or may not actually attach, but the
      // method returns a stop fn either way.
      const r = new CollectionRegistry(dir);
      const stop = r.startWatching();
      expect(typeof stop).toBe("function");
      stop();
    });
  });

  describe("startWatching survives multiple atomic renames (regression for fs.watch dangling inode)", () => {
    it("invalidates cache across N consecutive saveRegistryFile calls", async () => {
      // Polling waiter — fs.watch event delivery under concurrent vitest
      // load can exceed any fixed sleep. Loop until the cache reflects the
      // expected value or hit a generous overall timeout.
      // 8s budget per wait (was 2s): macOS FSEvents delivery under heavy
      // concurrent vitest load can lag several seconds — the 2s window flaked.
      // Events are delayed, not dropped (dir-level watch), so a larger budget
      // is reliable; normal delivery is <100ms so the happy path stays fast.
      const waitForPath = async (registry: CollectionRegistry, expected: string, timeoutMs = 8000): Promise<void> => {
        const deadline = Date.now() + timeoutMs;

        while (true) {
          if (registry.get("code_a")?.path === expected) return;
          if (Date.now() >= deadline) {
            // Final assertion to surface the actual value in the failure message.
            expect(registry.get("code_a")?.path).toBe(expected);
            return;
          }
          await new Promise((r) => setTimeout(r, 25));
        }
      };

      const r = new CollectionRegistry(dir);
      r.record(makeEntry({ collectionName: "code_a", path: "/repo/a" }));
      const stop = r.startWatching();
      try {
        // First external write — replaces inode #1 with inode #2.
        saveRegistryFile(dir, {
          version: 1,
          collections: {
            code_a: {
              collectionName: "code_a",
              path: "/repo/external-1",
              name: null,
              embeddingModel: "m",
              embeddingDimensions: 384,
              qdrantUrl: "http://localhost:6333",
              indexedAt: "",
              teaRagsVersion: "",
              chunksCount: 1,
            },
          },
        });
        await waitForPath(r, "/repo/external-1");

        // Second external write — replaces inode #2 with inode #3. With the
        // old file-level fs.watch on macOS, the watcher was bound to inode #1
        // (or whichever was current when startWatching ran) and silently
        // detached after the first rename. With directory-level watching,
        // the watcher sees this change too.
        saveRegistryFile(dir, {
          version: 1,
          collections: {
            code_a: {
              collectionName: "code_a",
              path: "/repo/external-2",
              name: null,
              embeddingModel: "m",
              embeddingDimensions: 384,
              qdrantUrl: "http://localhost:6333",
              indexedAt: "",
              teaRagsVersion: "",
              chunksCount: 2,
            },
          },
        });
        await waitForPath(r, "/repo/external-2");

        // Third — same story.
        saveRegistryFile(dir, {
          version: 1,
          collections: {
            code_a: {
              collectionName: "code_a",
              path: "/repo/external-3",
              name: null,
              embeddingModel: "m",
              embeddingDimensions: 384,
              qdrantUrl: "http://localhost:6333",
              indexedAt: "",
              teaRagsVersion: "",
              chunksCount: 3,
            },
          },
        });
        await waitForPath(r, "/repo/external-3");
      } finally {
        stop();
      }
      // it() timeout > 3 × waitForPath budget so a slow-but-eventual fs.watch
      // delivery doesn't trip the default 5s test timeout before the poll wins.
    }, 30000);
  });

  describe("findByPath() — alias-rename path lookup (2026-05-28)", () => {
    // resolveCollection({path: ...}) consults findByPath() to honor an
    // alias-rename across worktrees: the registry's preserved collectionName
    // wins over a fresh deterministic hash of the new path. These tests pin
    // every branch of the lookup so the rename path stays transparent.

    it("returns null when path is an empty string (recoverFromQdrant stubs)", () => {
      // Stub entries from recoverFromQdrant() store path="". An empty path
      // must short-circuit BEFORE iteration — otherwise two different stubs
      // would collide on path==="" and one would shadow the other.
      const r = new CollectionRegistry(dir);
      r.record(makeEntry({ collectionName: "code_stub_a", path: "" }));
      r.record(makeEntry({ collectionName: "code_stub_b", path: "" }));
      expect(r.findByPath("")).toBeNull();
    });

    it("returns the entry on exact path match", () => {
      const r = new CollectionRegistry(dir);
      r.record(makeEntry({ collectionName: "code_x", path: "/repo/x" }));
      r.record(makeEntry({ collectionName: "code_y", path: "/repo/y" }));
      const got = r.findByPath("/repo/x");
      expect(got).not.toBeNull();
      expect(got?.collectionName).toBe("code_x");
      expect(got?.path).toBe("/repo/x");
    });

    it("returns null when no entry has that path", () => {
      const r = new CollectionRegistry(dir);
      r.record(makeEntry({ collectionName: "code_x", path: "/repo/x" }));
      expect(r.findByPath("/repo/missing")).toBeNull();
    });

    it("returns null on an empty registry", () => {
      const r = new CollectionRegistry(dir);
      expect(r.findByPath("/repo/anything")).toBeNull();
    });

    it("path comparison is exact string equality (no normalization)", () => {
      // Callers must pass an already-resolved absolute path; findByPath is
      // intentionally strict (no realpath, no trailing-slash strip) so the
      // alias-rename contract stays predictable.
      const r = new CollectionRegistry(dir);
      r.record(makeEntry({ collectionName: "code_x", path: "/repo/x" }));
      expect(r.findByPath("/repo/x/")).toBeNull();
      expect(r.findByPath("/repo/X")).toBeNull();
    });
  });

  describe("updatePath() — persistence side of alias-rename (2026-05-28)", () => {
    // Path-only mutation: collectionName/name/chunksCount/indexedAt all
    // stay put; only the registry's `path` field moves to the new location.
    // This is the persistence half of ProjectRegistryOps.register()'s
    // rename branch.

    it("is a no-op when the entry is missing (does not throw, does not flush)", () => {
      // ProjectRegistryOps callers consult get() first if they want to fail
      // loud; updatePath itself silently no-ops on missing.
      const r = new CollectionRegistry(dir);
      expect(() => {
        r.updatePath("code_does_not_exist", "/repo/x");
      }).not.toThrow();
      expect(r.get("code_does_not_exist")).toBeNull();
    });

    it("is a no-op when the new path matches the existing path", () => {
      // Optimization: avoid a registry.json rewrite when nothing changed.
      // We verify the no-op behavior by checking that no entry mutation
      // occurs, plus that all other fields stay byte-identical.
      const r = new CollectionRegistry(dir);
      r.record(makeEntry({ collectionName: "code_same", path: "/repo/same" }));
      const before = r.get("code_same");
      r.updatePath("code_same", "/repo/same");
      const after = r.get("code_same");
      expect(after).toEqual(before);
    });

    it("updates the path and preserves every other field", () => {
      const r = new CollectionRegistry(dir);
      r.record(
        makeEntry({
          collectionName: "code_rn",
          path: "/repo/old",
          chunksCount: 999,
          indexedAt: "2026-05-01T00:00:00Z",
          embeddingModel: "all-MiniLM-L6-v2",
          embeddingDimensions: 384,
          qdrantUrl: "http://localhost:6333",
          teaRagsVersion: "1.0.0",
        }),
      );
      r.setName("code_rn", "shared");
      r.updatePath("code_rn", "/repo/new");
      const after = r.get("code_rn");
      // Path updated.
      expect(after?.path).toBe("/repo/new");
      // Everything else preserved.
      expect(after?.collectionName).toBe("code_rn");
      expect(after?.name).toBe("shared");
      expect(after?.chunksCount).toBe(999);
      expect(after?.indexedAt).toBe("2026-05-01T00:00:00Z");
      expect(after?.embeddingModel).toBe("all-MiniLM-L6-v2");
      expect(after?.embeddingDimensions).toBe(384);
      expect(after?.qdrantUrl).toBe("http://localhost:6333");
      expect(after?.teaRagsVersion).toBe("1.0.0");
    });

    it("the update is flushed to disk (visible to a fresh CollectionRegistry instance)", () => {
      const r1 = new CollectionRegistry(dir);
      r1.record(makeEntry({ collectionName: "code_p", path: "/repo/old" }));
      r1.updatePath("code_p", "/repo/new");
      // A separate CollectionRegistry that loads from disk sees the update.
      const r2 = new CollectionRegistry(dir);
      expect(r2.get("code_p")?.path).toBe("/repo/new");
    });

    it("findByPath() picks up the new path after updatePath (rename round-trip)", () => {
      // The whole point: after a rename, a path-based lookup for the new
      // path returns the original entry — preserved collectionName. Old
      // path no longer resolves.
      const r = new CollectionRegistry(dir);
      r.record(makeEntry({ collectionName: "code_rt", path: "/repo/old" }));
      r.updatePath("code_rt", "/repo/new");
      expect(r.findByPath("/repo/new")?.collectionName).toBe("code_rt");
      expect(r.findByPath("/repo/old")).toBeNull();
    });
  });
});
