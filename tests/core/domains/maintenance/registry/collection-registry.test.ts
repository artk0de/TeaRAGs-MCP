import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CollectionEntry } from "../../../../../src/core/contracts/types/registry.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";
import { saveRegistryFile } from "../../../../../src/core/domains/maintenance/registry/registry-file.js";

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

  it("record() round-trips the tuning snapshot and persists it across instances", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry({ tuning: { TRAJECTORY_GIT_CHUNK_CONCURRENCY: "5", INGEST_TUNE_FILE_CONCURRENCY: "25" } }));
    expect(r.get("code_abc")?.tuning).toEqual({
      TRAJECTORY_GIT_CHUNK_CONCURRENCY: "5",
      INGEST_TUNE_FILE_CONCURRENCY: "25",
    });

    const reloaded = new CollectionRegistry(dir);
    expect(reloaded.get("code_abc")?.tuning).toEqual({
      TRAJECTORY_GIT_CHUNK_CONCURRENCY: "5",
      INGEST_TUNE_FILE_CONCURRENCY: "25",
    });
  });

  it("record() without tuning stores an entry with no tuning field (old behavior byte-identical)", () => {
    const r = new CollectionRegistry(dir);
    r.record(makeEntry());
    const got = r.get("code_abc");
    expect(got).not.toBeNull();
    expect(got?.tuning).toBeUndefined();
    expect(got !== null && "tuning" in got).toBe(false);
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
      // fs.watch DROPS events; it does not merely delay them. Measured on this
      // machine with the suite running: of 40 atomic renames, 1 delivered no
      // event at all inside a 15s window, while every event that DID arrive
      // arrived in ~12ms (median; 62ms worst). No waiting budget can recover an
      // event that will never come, which is why the earlier bump of this wait
      // from 2s to 8s did not stop the flake (bd tea-rags-mcp-lzks3).
      //
      // So don't wait on ONE event — keep producing them. Each retry redoes the
      // same atomic rename, handing the watcher another chance. That leaves the
      // regression this test guards fully discriminated: the old file-level
      // watcher bound itself to an inode and detached for good after the first
      // rename, so it fires for NO retry, however many follow.
      const writeAndAwait = async (
        registry: CollectionRegistry,
        path: string,
        chunksCount: number,
        timeoutMs = 15_000,
      ): Promise<void> => {
        const write = (): void => {
          saveRegistryFile(dir, {
            version: 1,
            collections: {
              code_a: {
                collectionName: "code_a",
                path,
                name: null,
                embeddingModel: "m",
                embeddingDimensions: 384,
                qdrantUrl: "http://localhost:6333",
                indexedAt: "",
                teaRagsVersion: "",
                chunksCount,
              },
            },
          });
        };

        const deadline = Date.now() + timeoutMs;
        let nextWriteAt = 0;
        while (registry.get("code_a")?.path !== path) {
          if (Date.now() >= deadline) {
            // Final assertion to surface the actual value in the failure message.
            expect(registry.get("code_a")?.path).toBe(path);
            return;
          }
          if (Date.now() >= nextWriteAt) {
            write();
            nextWriteAt = Date.now() + 500;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
      };

      const r = new CollectionRegistry(dir);
      r.record(makeEntry({ collectionName: "code_a", path: "/repo/a" }));
      const stop = r.startWatching();
      try {
        // Each write replaces the file's inode. With the old file-level
        // fs.watch on macOS the watcher was bound to the inode current at
        // startWatching and silently detached after the first rename; a
        // directory watcher sees every one of them.
        await writeAndAwait(r, "/repo/external-1", 1);
        await writeAndAwait(r, "/repo/external-2", 2);
        await writeAndAwait(r, "/repo/external-3", 3);
      } finally {
        stop();
      }
    });
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

  describe("autoUpdate stickiness", () => {
    it("record() preserves existing autoUpdate block", () => {
      const r = new CollectionRegistry(dir);
      r.record(makeEntry());
      r.setAutoUpdate("code_abc", { enabled: true, targetBranch: "master" });
      r.record(makeEntry({ chunksCount: 99 }));
      expect(r.get("code_abc")?.autoUpdate).toEqual({ enabled: true, targetBranch: "master" });
      expect(r.get("code_abc")?.chunksCount).toBe(99);
    });

    it("setAutoUpdate(null) removes the block", () => {
      const r = new CollectionRegistry(dir);
      r.record(makeEntry());
      r.setAutoUpdate("code_abc", { enabled: true, targetBranch: "master" });
      r.setAutoUpdate("code_abc", null);
      const got = r.get("code_abc");
      expect(got?.autoUpdate).toBeUndefined();
      expect(got !== null && "autoUpdate" in got).toBe(false);
    });

    it("setAutoUpdate throws on unknown collection", () => {
      const r = new CollectionRegistry(dir);
      expect(() => {
        r.setAutoUpdate("nope", { enabled: true, targetBranch: "m" });
      }).toThrow("not in registry");
    });

    it("recordAutoUpdateRun merges lastRun and persists across instances", () => {
      const r = new CollectionRegistry(dir);
      r.record(makeEntry());
      r.setAutoUpdate("code_abc", { enabled: true, targetBranch: "master" });
      r.recordAutoUpdateRun("code_abc", {
        at: "2026-08-06T12:00:00Z",
        outcome: "ok",
        durationMs: 1200,
        filesChanged: 3,
      });
      const fresh = new CollectionRegistry(dir);
      const auto = fresh.get("code_abc")?.autoUpdate;
      expect(auto?.lastRun?.outcome).toBe("ok");
      expect(auto?.enabled).toBe(true);
      expect(auto?.targetBranch).toBe("master");
    });

    it("recordAutoUpdateRun is a no-op when entry or block missing", () => {
      const r = new CollectionRegistry(dir);
      const run = { at: "2026-08-06T12:00:00Z", outcome: "failed" as const, durationMs: 1, filesChanged: 0 };
      expect(() => {
        r.recordAutoUpdateRun("nope", run);
      }).not.toThrow();
      r.record(makeEntry({ collectionName: "code_nb" }));
      expect(() => {
        r.recordAutoUpdateRun("code_nb", run);
      }).not.toThrow();
      expect(r.get("code_nb")?.autoUpdate).toBeUndefined();
    });

    it("record() round-trips the git block", () => {
      const r = new CollectionRegistry(dir);
      r.record(
        makeEntry({
          git: { indexedBranch: "master", indexedCommit: "abc123", indexedDirty: false },
        }),
      );
      const fresh = new CollectionRegistry(dir);
      expect(fresh.get("code_abc")?.git).toEqual({
        indexedBranch: "master",
        indexedCommit: "abc123",
        indexedDirty: false,
      });
    });
  });
});
