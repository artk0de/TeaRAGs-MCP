import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runPrune } from "../../../src/cli/commands/projects.js";
import { ProjectRegistryOps } from "../../../src/core/api/internal/ops/project-registry-ops.js";
import { CollectionRegistry } from "../../../src/core/domains/maintenance/registry/collection-registry.js";

/**
 * `tea-rags projects prune` — the sweep for registry entries whose project
 * directory is gone (bd tea-rags-mcp-qwhmy). Default is a DRY RUN; `--purge`
 * tears down the footprint first and removes the entry only when that worked.
 */
describe("CLI 'projects prune'", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cli-prune-"));
    process.env.TEA_RAGS_DATA_DIR = dir;
  });

  afterEach(() => {
    delete process.env.TEA_RAGS_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Seed one registry entry; `path` defaults to a directory that does not exist. */
  function record(
    collectionName: string,
    options: {
      name?: string;
      path?: string;
      chunksCount?: number;
      worktreeOf?: string;
      worktreeName?: string;
    } = {},
  ): void {
    const reg = new CollectionRegistry(dir);
    reg.record({
      collectionName,
      path: options.path ?? join(dir, "gone", collectionName),
      embeddingModel: "m",
      embeddingDimensions: 1,
      qdrantUrl: "http://q",
      indexedAt: "",
      teaRagsVersion: "",
      chunksCount: options.chunksCount ?? 99,
      ...(options.worktreeOf !== undefined ? { worktreeOf: options.worktreeOf } : {}),
      ...(options.worktreeName !== undefined ? { worktreeName: options.worktreeName } : {}),
    });
    if (options.name !== undefined) reg.setName(collectionName, options.name);
  }

  /** The Qdrant surface the footprint purge enumerates (mirrors the unregister --purge fake). */
  function purgeQdrant(collections: string[], aliases: { aliasName: string; collectionName: string }[] = []) {
    const live = new Set(collections);
    const aliasList = [...aliases];
    return {
      live,
      listCollections: vi.fn(async () => [...live]),
      deleteCollection: vi.fn(async (name: string) => {
        live.delete(name);
      }),
      countPoints: vi.fn(async () => 99),
      aliases: {
        listAliases: vi.fn(async () => [...aliasList]),
        deleteAlias: vi.fn(async (name: string) => {
          const i = aliasList.findIndex((a) => a.aliasName === name);
          if (i >= 0) aliasList.splice(i, 1);
        }),
      },
    };
  }

  function registered(): string[] {
    return new CollectionRegistry(dir).list().map((e) => e.collectionName);
  }

  async function capture(run: () => Promise<void>): Promise<string> {
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await run();
      return stdout.mock.calls.map((c) => String(c[0])).join("");
    } finally {
      stdout.mockRestore();
    }
  }

  describe("dry run (default)", () => {
    it("prints '(no stale registry entries)' when every directory is on disk", async () => {
      record("code_live", { name: "live", path: dir });

      const out = await capture(async () => runPrune({}));

      expect(out).toContain("(no stale registry entries)");
      expect(registered()).toEqual(["code_live"]);
    });

    it("lists a nameless stale entry as 'would remove' and removes nothing", async () => {
      record("code_ghost", { chunksCount: 1234 });

      const out = await capture(async () => runPrune({}));

      expect(out).toContain("code_ghost");
      expect(out).toContain("(no alias)");
      expect(out).toContain(join(dir, "gone", "code_ghost"));
      expect(out).toContain("1234");
      expect(out).toContain("would remove");
      expect(registered()).toEqual(["code_ghost"]);
    });

    it("says a named stale entry is kept and how to recover it", async () => {
      record("code_moved", { name: "moved" });

      const out = await capture(async () => runPrune({}));

      expect(out).toContain("moved");
      expect(out).toContain("kept");
      expect(out).toContain("re-register");
      expect(out).toContain("projects unregister --name moved --purge");
      expect(out).not.toContain("would remove");
    });

    it("points at --purge as the way to act", async () => {
      record("code_ghost");

      const out = await capture(async () => runPrune({}));

      expect(out).toContain("--purge");
    });

    it("--json emits the stale list with nothing removed and nothing kept", async () => {
      record("code_ghost", { chunksCount: 7 });
      record("code_moved", { name: "moved" });
      record("code_live", { name: "live", path: dir });

      const out = await capture(async () => runPrune({ json: true }));
      const parsed = JSON.parse(out) as {
        stale: { collectionName: string; name: string | null; chunksCount: number }[];
        removed: unknown[];
        kept: unknown[];
      };

      expect(parsed.stale.map((e) => e.collectionName).sort()).toEqual(["code_ghost", "code_moved"]);
      expect(parsed.stale.find((e) => e.collectionName === "code_ghost")).toMatchObject({ name: null, chunksCount: 7 });
      expect(parsed.removed).toEqual([]);
      expect(parsed.kept).toEqual([]);
      expect(registered()).toHaveLength(3);
    });
  });

  describe("--purge", () => {
    it("purges the footprint BEFORE the registry entry goes", async () => {
      record("code_ghost");
      const fakeQdrant = purgeQdrant(["code_ghost"]);
      let entryStillRegisteredAtPurge: boolean | null = null;
      fakeQdrant.deleteCollection.mockImplementation(async (name: string) => {
        const onDisk = JSON.parse(readFileSync(join(dir, "registry.json"), "utf8")) as {
          collections: Record<string, unknown>;
        };
        entryStillRegisteredAtPurge = "code_ghost" in onDisk.collections;
        fakeQdrant.live.delete(name);
      });

      const out = await capture(async () => runPrune({ purge: true }, fakeQdrant as never));

      expect(fakeQdrant.deleteCollection).toHaveBeenCalledWith("code_ghost");
      expect(entryStillRegisteredAtPurge).toBe(true);
      expect(registered()).toEqual([]);
      expect(out).toContain("code_ghost");
      expect(out).toContain("removed");
    });

    it("deletes every _vN generation behind the alias, not just the alias name", async () => {
      record("code_gen");
      const fakeQdrant = purgeQdrant(
        ["code_gen_v1", "code_gen_v2", "code_other_v1"],
        [{ aliasName: "code_gen", collectionName: "code_gen_v2" }],
      );

      await capture(async () => runPrune({ purge: true }, fakeQdrant as never));

      const deleted = fakeQdrant.deleteCollection.mock.calls.map((c) => c[0]);
      expect(deleted).toContain("code_gen_v1");
      expect(deleted).toContain("code_gen_v2");
      expect(deleted).not.toContain("code_other_v1");
    });

    it("leaves a named stale entry alone — no purge, no removal", async () => {
      record("code_moved", { name: "moved" });
      const fakeQdrant = purgeQdrant(["code_moved"]);

      const out = await capture(async () => runPrune({ purge: true }, fakeQdrant as never));

      expect(fakeQdrant.deleteCollection).not.toHaveBeenCalled();
      expect(registered()).toEqual(["code_moved"]);
      expect(out).toContain("kept");
    });

    it("never touches an entry whose directory is still on disk", async () => {
      record("code_live", { path: dir });
      const fakeQdrant = purgeQdrant(["code_live"]);

      const out = await capture(async () => runPrune({ purge: true }, fakeQdrant as never));

      expect(fakeQdrant.deleteCollection).not.toHaveBeenCalled();
      expect(registered()).toEqual(["code_live"]);
      expect(out).toContain("(no stale registry entries)");
    });

    it("keeps the entry when its purge fails, and still purges the rest", async () => {
      record("code_bad");
      record("code_ok");
      const fakeQdrant = purgeQdrant(["code_bad", "code_ok"]);
      fakeQdrant.deleteCollection.mockImplementation(async (name: string) => {
        if (name === "code_bad") throw new Error("network down");
        fakeQdrant.live.delete(name);
      });

      const out = await capture(async () => runPrune({ purge: true }, fakeQdrant as never));

      expect(registered()).toEqual(["code_bad"]);
      expect(out).toContain("network down");
      expect(out).toMatch(/code_ok.*removed/);
    });

    it("prints each entry's line as it is decided, not after the whole sweep", async () => {
      record("code_first");
      record("code_second");
      const fakeQdrant = purgeQdrant(["code_first", "code_second"]);
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        let bufferAtSecondPurge = "";
        fakeQdrant.deleteCollection.mockImplementation(async (name: string) => {
          if (name === "code_second") {
            bufferAtSecondPurge = stdout.mock.calls.map((c) => String(c[0])).join("");
          }
          fakeQdrant.live.delete(name);
        });

        await runPrune({ purge: true }, fakeQdrant as never);

        expect(bufferAtSecondPurge).toMatch(/code_first.*removed/);
        expect(bufferAtSecondPurge).not.toContain("code_second");
      } finally {
        stdout.mockRestore();
      }
    });

    it("closes with a summary of what went and what stayed", async () => {
      record("code_ghost");
      record("code_moved", { name: "moved" });
      const fakeQdrant = purgeQdrant(["code_ghost"]);

      const out = await capture(async () => runPrune({ purge: true }, fakeQdrant as never));

      expect(out).toContain("Removed 1 · kept 1");
    });

    it("says so in the summary when every purge failed", async () => {
      record("code_a");
      record("code_b");
      const fakeQdrant = purgeQdrant(["code_a", "code_b"]);
      fakeQdrant.listCollections.mockRejectedValue(new Error("ECONNREFUSED"));
      fakeQdrant.deleteCollection.mockRejectedValue(new Error("ECONNREFUSED"));

      const out = await capture(async () => runPrune({ purge: true }, fakeQdrant as never));

      expect(out).toContain("Removed 0 · kept 2 (2 purge failed)");
      expect(out).toMatch(/every purge failed.*Qdrant/i);
      expect(registered()).toEqual(["code_a", "code_b"]);
    });

    it("--json reports what went and what stayed", async () => {
      record("code_ghost", { chunksCount: 5 });
      record("code_moved", { name: "moved" });
      const fakeQdrant = purgeQdrant(["code_ghost"]);

      const out = await capture(async () => runPrune({ purge: true, json: true }, fakeQdrant as never));
      const parsed = JSON.parse(out) as {
        stale: { collectionName: string }[];
        removed: { collectionName: string; chunksCount: number }[];
        kept: { collectionName: string; name: string | null }[];
      };

      expect(parsed.stale.map((e) => e.collectionName).sort()).toEqual(["code_ghost", "code_moved"]);
      expect(parsed.removed).toEqual([expect.objectContaining({ collectionName: "code_ghost", chunksCount: 5 })]);
      expect(parsed.kept).toEqual([expect.objectContaining({ collectionName: "code_moved", name: "moved" })]);
      expect(registered()).toEqual(["code_moved"]);
    });
  });

  /**
   * Which entries the sweep may take is the op's rule. The CLI reads the
   * verdict off the entry — it never re-derives "nameless only", or the two
   * drift apart in the worst direction: purging a collection the op keeps, or
   * removing an entry whose footprint was never purged.
   */
  describe("the prunable verdict comes from the op", () => {
    function stubListStale(entries: Record<string, unknown>[]): { mockRestore: () => void } {
      return vi.spyOn(ProjectRegistryOps.prototype, "listStale").mockReturnValue(entries as never);
    }

    it("never purges a nameless entry the op marked non-prunable", async () => {
      record("code_ghost");
      const fakeQdrant = purgeQdrant(["code_ghost"]);
      const listStale = stubListStale([
        {
          collectionName: "code_ghost",
          name: null,
          path: "/gone/fixture",
          chunksCount: 99,
          indexedAt: "",
          prunable: false,
        },
      ]);
      try {
        await capture(async () => runPrune({ purge: true }, fakeQdrant as never));

        expect(fakeQdrant.deleteCollection).not.toHaveBeenCalled();
        expect(registered()).toEqual(["code_ghost"]);
      } finally {
        listStale.mockRestore();
      }
    });

    it("purges a named entry the op marked prunable", async () => {
      record("code_moved", { name: "moved" });
      const fakeQdrant = purgeQdrant(["code_moved"]);
      const listStale = stubListStale([
        {
          collectionName: "code_moved",
          name: "moved",
          path: "/gone/worktree",
          chunksCount: 99,
          indexedAt: "",
          prunable: true,
        },
      ]);
      try {
        await capture(async () => runPrune({ purge: true }, fakeQdrant as never));

        expect(fakeQdrant.deleteCollection).toHaveBeenCalledWith("code_moved");
        expect(registered()).toEqual([]);
      } finally {
        listStale.mockRestore();
      }
    });

    it("dry-run --json carries the verdict so no consumer re-derives it", async () => {
      record("code_ghost");
      record("code_moved", { name: "moved" });

      const out = await capture(async () => runPrune({ json: true }));
      const parsed = JSON.parse(out) as { stale: { collectionName: string; prunable: boolean }[] };

      expect(parsed.stale).toEqual([
        expect.objectContaining({ collectionName: "code_ghost", prunable: true }),
        expect.objectContaining({ collectionName: "code_moved", prunable: false }),
      ]);
    });
  });

  /**
   * The footprint purger collects its failures today, but that is an implicit
   * contract on a class in another domain. One unguarded line there — or a
   * composition that fails outright — must not turn entry 2 of 3 into a stack
   * trace with nothing printed and entries 1–2 purged but still registered.
   */
  describe("a purge that throws", () => {
    it("keeps that entry, reports it, and finishes the sweep", async () => {
      record("code_a");
      record("code_b");
      record("code_c");
      vi.doMock("../../../src/bootstrap/footprint-purge.js", () => ({
        createCollectionFootprintPurger: () => ({
          purge: async ({ logicalName }: { logicalName: string }) => {
            if (logicalName === "code_b") throw new Error("purger exploded");
            return {
              collectionName: logicalName,
              qdrantAlias: null,
              qdrantCollections: [logicalName],
              codegraphDatabases: [],
              clearedStores: [],
              kept: [],
              failures: [],
            };
          },
        }),
      }));
      const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      try {
        vi.resetModules();
        const { runPrune: freshRunPrune } = await import("../../../src/cli/commands/projects.js");

        await freshRunPrune({ purge: true }, purgeQdrant([]) as never);

        const out = stdout.mock.calls.map((c) => String(c[0])).join("");
        expect(out).toMatch(/code_a.*removed/);
        expect(out).toMatch(/code_b.*purge failed: purger exploded/);
        expect(out).toMatch(/code_c.*removed/);
        expect(registered()).toEqual(["code_b"]);
      } finally {
        stdout.mockRestore();
        vi.doUnmock("../../../src/bootstrap/footprint-purge.js");
        vi.resetModules();
      }
    });
  });

  /**
   * Every `worktree create` clone is a NAMED entry, so a removed worktree is
   * the most likely named-stale case in a real registry — and `worktree
   * remove` is its only sanctioned teardown (it also drops the git worktree
   * admin entry that `unregister --purge` would leave dangling).
   */
  describe("the kept hint", () => {
    it("sends a stale worktree clone to 'worktree remove'", async () => {
      record("code_clone", {
        name: "proj-worktree-feature",
        worktreeOf: "code_source",
        worktreeName: "feature",
      });

      const out = await capture(async () => runPrune({}));

      expect(out).toContain("worktree clone");
      expect(out).toContain("tea-rags worktree remove feature --force");
      expect(out).not.toContain("re-register");
    });

    it("sends a plain named entry to re-register / unregister, not to worktree remove", async () => {
      record("code_moved", { name: "moved" });

      const out = await capture(async () => runPrune({}));

      expect(out).toContain("re-register");
      expect(out).toContain("projects unregister --name moved --purge");
      expect(out).not.toContain("worktree remove");
    });
  });

  it("survives a legacy registry entry that has no path at all", async () => {
    writeFileSync(
      join(dir, "registry.json"),
      JSON.stringify({
        version: 1,
        collections: {
          code_legacy: { collectionName: "code_legacy", name: null, chunksCount: 0 },
          code_ghost: {
            collectionName: "code_ghost",
            path: join(dir, "gone", "code_ghost"),
            name: null,
            chunksCount: 4,
            indexedAt: "",
          },
        },
      }),
    );

    const out = await capture(async () => runPrune({}));

    expect(out).toContain("code_ghost");
    expect(out).not.toContain("code_legacy");
  });
});
