import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../__helpers__/collection-identity.js";
import { CodegraphDbFiles } from "../../../../src/core/adapters/duckdb/codegraph-db-files.js";
import { CollectionIndexingLock } from "../../../../src/core/domains/ingest/infra/collection-indexing-lock.js";
import { CollectionFootprintFactory } from "../../../../src/core/domains/maintenance/footprint/factory.js";
import { CollectionFootprintPurger } from "../../../../src/core/domains/maintenance/footprint/purger.js";

/**
 * In-memory stand-ins for the four things a purge touches: Qdrant (collections +
 * aliases), the codegraph DB directory, the alias-keyed stores, and the shared
 * codegraph daemon. Fakes rather than mocks — the assertions are about what is
 * left behind afterwards, not about which method was called.
 */
function fakeQdrant(collections: string[], aliases: { aliasName: string; collectionName: string }[] = []) {
  const live = new Set(collections);
  const aliasList = [...aliases];
  return {
    live,
    listCollections: vi.fn(async () => [...live]),
    deleteCollection: vi.fn(async (name: string) => {
      live.delete(name);
    }),
    countPoints: vi.fn(async () => 0),
    aliases: {
      listAliases: vi.fn(async () => [...aliasList]),
      deleteAlias: vi.fn(async (name: string) => {
        const i = aliasList.findIndex((a) => a.aliasName === name);
        if (i >= 0) aliasList.splice(i, 1);
      }),
    },
  };
}

function fakeCodegraphStore(dbNames: string[]) {
  const files = new Set(dbNames);
  return {
    files,
    cloneDatabase: vi.fn(async () => undefined),
    removeCollection: vi.fn(async (name: string) => files.delete(name)),
    listCollectionDbNames: vi.fn(() => [...files]),
  };
}

function fakeStores(over: { statsInvalidateThrows?: string } = {}) {
  const snapshotDeleted: string[] = [];
  const quarantineCleared: string[] = [];
  const skippedCleared: string[] = [];
  const statsInvalidated: string[] = [];
  const lockTornDown: string[] = [];
  return {
    snapshotDeleted,
    quarantineCleared,
    skippedCleared,
    skippedFileStoreFactory: (_base: string, logical: string) => ({
      cloneTo: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => {
        skippedCleared.push(logical);
      }),
    }),
    statsInvalidated,
    lockTornDown,
    indexingLockStoreFactory: (_base: string, logical: string) => ({
      removeIfStale: vi.fn(async () => {
        lockTornDown.push(logical);
        return { status: "absent" as const };
      }),
    }),
    statsCache: {
      clone: vi.fn(),
      invalidate: vi.fn((name: string) => {
        if (over.statsInvalidateThrows) throw new Error(over.statsInvalidateThrows);
        statsInvalidated.push(name);
      }),
    },
    snapshotStoreFactory: (_base: string, logical: string) => ({
      cloneTo: vi.fn(async () => undefined),
      delete: vi.fn(async () => {
        snapshotDeleted.push(logical);
      }),
    }),
    quarantineStoreFactory: (_base: string, logical: string) => ({
      cloneTo: vi.fn(async () => undefined),
      clearAll: vi.fn(async () => {
        quarantineCleared.push(logical);
      }),
    }),
  };
}

interface PurgerHarnessOverrides {
  qdrant?: ReturnType<typeof fakeQdrant>;
  codegraph?: ReturnType<typeof fakeCodegraphStore>;
  registry?: { listWorktrees: () => unknown[] };
  daemon?: { pid: () => number | undefined; refs: () => number };
  statsInvalidateThrows?: string;
  indexingLockStoreFactory?: (baseDir: string, logicalName: string) => { removeIfStale: () => Promise<unknown> };
  residualVerdictFile?: (logicalName: string) => string;
}

function buildPurger(over: PurgerHarnessOverrides = {}) {
  const qdrant = over.qdrant ?? fakeQdrant([]);
  const codegraph = over.codegraph ?? fakeCodegraphStore([]);
  const stores = fakeStores(over.statsInvalidateThrows ? { statsInvalidateThrows: over.statsInvalidateThrows } : {});
  const footprintFactory = new CollectionFootprintFactory({
    qdrant: qdrant as never,
    pool: codegraph as never,
    statsCache: stores.statsCache as never,
    snapshotBaseDir: "/snap",
    snapshotStoreFactory: stores.snapshotStoreFactory,
    quarantineStoreFactory: stores.quarantineStoreFactory,
    skippedFileStoreFactory: stores.skippedFileStoreFactory,
    indexingLockStoreFactory: (over.indexingLockStoreFactory ?? stores.indexingLockStoreFactory) as never,
    ...(over.residualVerdictFile ? { residualVerdictFile: over.residualVerdictFile } : {}),
  });
  const purger = new CollectionFootprintPurger({
    qdrant: qdrant as never,
    footprintFactory,
    listCodegraphDbs: (base) => codegraph.listCollectionDbNames(base),
    ...(over.registry ? { registry: over.registry as never } : {}),
    ...(over.daemon ? { daemon: over.daemon } : {}),
  });
  return { purger, qdrant, codegraph, stores };
}

describe("CollectionFootprintPurger", () => {
  describe("residual verdicts", () => {
    it("purging the collection deletes its verdict store and WAL", async () => {
      const dir = mkdtempSync(join(tmpdir(), "purge-residual-"));
      const fileFor = (logical: string) => join(dir, `${logical}.duckdb`);
      writeFileSync(fileFor("code_a"), "db");
      writeFileSync(`${fileFor("code_a")}.wal`, "wal");
      writeFileSync(fileFor("code_b"), "db");
      const qdrant = fakeQdrant(["code_a_v1", "code_a_v2"], [{ aliasName: "code_a", collectionName: "code_a_v2" }]);
      const { purger } = buildPurger({ qdrant, residualVerdictFile: fileFor });

      const report = await purger.purge({ logicalName: "code_a" });

      expect(report.failures).toEqual([]);
      expect(existsSync(fileFor("code_a"))).toBe(false);
      expect(existsSync(`${fileFor("code_a")}.wal`)).toBe(false);
      expect(existsSync(fileFor("code_b"))).toBe(true);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("generation enumeration", () => {
    it("drops every _vN Qdrant generation of the collection, not just the alias target", async () => {
      const qdrant = fakeQdrant(
        ["code_a_v1", "code_a_v2", "code_a_v3", "code_other_v1"],
        [{ aliasName: "code_a", collectionName: "code_a_v3" }],
      );
      const { purger } = buildPurger({ qdrant });

      const report = await purger.purge({ logicalName: "code_a" });

      expect([...qdrant.live].sort()).toEqual(["code_other_v1"]);
      expect(report.qdrantCollections.sort()).toEqual(["code_a_v1", "code_a_v2", "code_a_v3"]);
      expect(report.failures).toEqual([]);
    });

    it("removes the alias itself and reports it", async () => {
      const qdrant = fakeQdrant(["code_a_v1"], [{ aliasName: "code_a", collectionName: "code_a_v1" }]);
      const { purger } = buildPurger({ qdrant });

      const report = await purger.purge({ logicalName: "code_a" });

      expect(report.qdrantAlias).toBe("code_a_v1");
      expect(await qdrant.aliases.listAliases()).toEqual([]);
    });

    it("drops the legacy unversioned real collection when there is no alias", async () => {
      const qdrant = fakeQdrant(["code_a"]);
      const { purger } = buildPurger({ qdrant });

      const report = await purger.purge({ logicalName: "code_a" });

      expect([...qdrant.live]).toEqual([]);
      expect(report.qdrantCollections).toEqual(["code_a"]);
      expect(report.qdrantAlias).toBeNull();
    });

    it("never touches a collection whose name merely shares the prefix", async () => {
      // `code_a_worktree_v1` starts with `code_a` but is a DIFFERENT project.
      const qdrant = fakeQdrant(["code_a_v1", "code_a_worktree_v1", "code_ab_v1"]);
      const { purger } = buildPurger({ qdrant });

      await purger.purge({ logicalName: "code_a" });

      expect([...qdrant.live].sort()).toEqual(["code_a_worktree_v1", "code_ab_v1"]);
    });

    it("reclaims a codegraph DuckDB generation whose Qdrant collection is already gone", async () => {
      // The 6goqa/snbzk leak class: the DuckDB file outlives its collection, so
      // enumerating from Qdrant alone can never see it.
      const qdrant = fakeQdrant(["code_a_v3"], [{ aliasName: "code_a", collectionName: "code_a_v3" }]);
      const codegraph = fakeCodegraphStore(["code_a", "code_a_v1", "code_a_v3"]);
      const { purger } = buildPurger({ qdrant, codegraph });

      const report = await purger.purge({ logicalName: "code_a" });

      expect([...codegraph.files]).toEqual([]);
      expect(report.codegraphDatabases.sort()).toEqual(["code_a", "code_a_v1", "code_a_v3"]);
    });

    it("reclaims a cross-pass input spill whose generation has no database and no collection", async () => {
      // A run that died before its drain leaves `.xpass/<generation>.ndjson`
      // behind with nothing else — invisible to a `*.duckdb` listing, so it
      // outlived every purge. Real files, wired the way `footprint-purge.ts` is.
      const appData = mkdtempSync(join(tmpdir(), "purge-xpass-"));
      try {
        const files = new CodegraphDbFiles(appData);
        mkdirSync(files.inputSpillDir, { recursive: true });
        writeFileSync(join(files.dir, "code_a_v3.duckdb"), "db");
        writeFileSync(files.inputSpillPathFor("code_a_v1"), "{}\n");
        writeFileSync(files.inputSpillPathFor("code_a_v3"), "{}\n");
        writeFileSync(files.inputSpillPathFor("code_other_v1"), "{}\n");
        const qdrant = fakeQdrant(["code_a_v3"], [{ aliasName: "code_a", collectionName: "code_a_v3" }]);
        const stores = fakeStores();
        const purger = new CollectionFootprintPurger({
          qdrant: qdrant as never,
          footprintFactory: new CollectionFootprintFactory({
            qdrant: qdrant as never,
            pool: files,
            statsCache: stores.statsCache as never,
            snapshotBaseDir: "/snap",
            snapshotStoreFactory: stores.snapshotStoreFactory,
            quarantineStoreFactory: stores.quarantineStoreFactory,
            skippedFileStoreFactory: stores.skippedFileStoreFactory,
            indexingLockStoreFactory: stores.indexingLockStoreFactory,
          }),
          listCodegraphDbs: (base) => files.listCollectionGenerationNames(base),
        });

        const report = await purger.purge({ logicalName: "code_a" });

        expect(existsSync(files.inputSpillPathFor("code_a_v1"))).toBe(false);
        expect(existsSync(files.inputSpillPathFor("code_a_v3"))).toBe(false);
        expect(existsSync(files.inputSpillPathFor("code_other_v1"))).toBe(true);
        expect(report.codegraphDatabases.sort()).toEqual(["code_a_v1", "code_a_v3"]);
        expect(report.failures).toEqual([]);
      } finally {
        rmSync(appData, { recursive: true, force: true });
      }
    });
  });

  describe("alias-keyed stores", () => {
    it("clears the snapshot, stats, quarantine and indexing lock exactly once, keyed on the LOGICAL name", async () => {
      const qdrant = fakeQdrant(["code_a_v1", "code_a_v2"], [{ aliasName: "code_a", collectionName: "code_a_v2" }]);
      const { purger, stores } = buildPurger({ qdrant });

      const report = await purger.purge({ logicalName: "code_a" });

      expect(stores.snapshotDeleted).toEqual(["code_a"]);
      expect(stores.quarantineCleared).toEqual(["code_a"]);
      expect(stores.skippedCleared).toEqual(["code_a"]);
      expect(stores.statsInvalidated).toEqual(["code_a"]);
      expect(stores.lockTornDown).toEqual(["code_a"]);
      expect(report.clearedStores.sort()).toEqual([
        "indexing-lock",
        "quarantine",
        "skipped-files",
        "snapshot",
        "stats",
      ]);
    });

    it("clears the alias-keyed stores even when the collection has no Qdrant generation left", async () => {
      const { purger, stores } = buildPurger();

      const report = await purger.purge({ logicalName: "code_gone" });

      expect(stores.statsInvalidated).toEqual(["code_gone"]);
      expect(report.qdrantCollections).toEqual([]);
      expect(report.failures).toEqual([]);
    });
  });

  describe("best-effort continuation", () => {
    it("keeps purging the remaining generations after one Qdrant delete fails", async () => {
      const qdrant = fakeQdrant(["code_a_v1", "code_a_v2", "code_a_v3"]);
      qdrant.deleteCollection.mockImplementation(async (name: string) => {
        if (name === "code_a_v2") throw new Error("collection locked");
        qdrant.live.delete(name);
      });
      const { purger } = buildPurger({ qdrant });

      const report = await purger.purge({ logicalName: "code_a" });

      expect([...qdrant.live]).toEqual(["code_a_v2"]);
      expect(report.qdrantCollections.sort()).toEqual(["code_a_v1", "code_a_v3"]);
      expect(report.failures).toHaveLength(1);
      expect(report.failures[0]).toMatchObject({ artifact: "qdrant", target: "code_a_v2" });
    });

    it("still clears the alias-keyed stores after a codegraph removal throws", async () => {
      const qdrant = fakeQdrant(["code_a_v1"]);
      const codegraph = fakeCodegraphStore(["code_a_v1"]);
      codegraph.removeCollection.mockRejectedValue(new Error("duckdb close failed"));
      const { purger, stores } = buildPurger({ qdrant, codegraph });

      const report = await purger.purge({ logicalName: "code_a" });

      expect(stores.statsInvalidated).toEqual(["code_a"]);
      expect([...qdrant.live]).toEqual([]);
      expect(report.failures.map((f) => f.artifact)).toContain("codegraph");
    });

    it("records a failure and keeps clearing the other stores when one teardown throws", async () => {
      const qdrant = fakeQdrant(["code_a_v1"]);
      const { purger, stores } = buildPurger({ qdrant, statsInvalidateThrows: "stats file busy" });

      const report = await purger.purge({ logicalName: "code_a" });

      expect(report.failures.map((f) => f.artifact)).toContain("stats");
      expect(report.failures.find((f) => f.artifact === "stats")?.reason).toContain("stats file busy");
      expect(report.clearedStores.sort()).toEqual(["indexing-lock", "quarantine", "skipped-files", "snapshot"]);
      expect(stores.snapshotDeleted).toEqual(["code_a"]);
      expect(stores.quarantineCleared).toEqual(["code_a"]);
    });

    it("reports a generation that survived the delete as a failure", async () => {
      const qdrant = fakeQdrant(["code_a_v1"]);
      // Delete silently no-ops — the collection is still there when we re-list.
      qdrant.deleteCollection.mockResolvedValue(undefined);
      const { purger } = buildPurger({ qdrant });

      const report = await purger.purge({ logicalName: "code_a" });

      expect(report.qdrantCollections).toEqual([]);
      expect(report.failures).toHaveLength(1);
      expect(report.failures[0]?.target).toBe("code_a_v1");
    });
  });

  describe("indexing lock", () => {
    const DEAD_PID = 4242;
    const LIVE_PID = 5151;

    /** A real `code_a.indexing.lock` in a temp dir, and a store that tears it down with the real rules. */
    function lockOnDisk(pid: number) {
      const dir = mkdtempSync(join(tmpdir(), "purge-lock-"));
      const file = join(dir, "code_a.indexing.lock");
      const now = new Date().toISOString();
      writeFileSync(
        file,
        JSON.stringify({ pid, hostname: hostname(), startedAt: now, heartbeatAt: now, operation: "index-codebase" }),
      );
      const indexingLockStoreFactory = (_base: string, logical: string) => ({
        removeIfStale: async () =>
          new CollectionIndexingLock({ lockDir: dir, isProcessAlive: (p) => p !== DEAD_PID }).removeIfStale(logical),
      });
      return { dir, file, indexingLockStoreFactory };
    }

    it("removes the indexing lock a dead run left behind", async () => {
      const lock = lockOnDisk(DEAD_PID);
      try {
        const { purger } = buildPurger({
          qdrant: fakeQdrant(["code_a_v1"]),
          indexingLockStoreFactory: lock.indexingLockStoreFactory,
        });

        const report = await purger.purge({ logicalName: "code_a" });

        expect(existsSync(lock.file)).toBe(false);
        expect(report.clearedStores).toContain("indexing-lock");
        expect(report.failures).toEqual([]);
      } finally {
        rmSync(lock.dir, { recursive: true, force: true });
      }
    });

    it("leaves a live run's indexing lock in place, reports who holds it, and clears everything else", async () => {
      const lock = lockOnDisk(LIVE_PID);
      try {
        const qdrant = fakeQdrant(["code_a_v1"]);
        const { purger, stores } = buildPurger({ qdrant, indexingLockStoreFactory: lock.indexingLockStoreFactory });

        const report = await purger.purge({ logicalName: "code_a" });

        expect(existsSync(lock.file)).toBe(true);
        expect(report.clearedStores).not.toContain("indexing-lock");
        expect(report.failures).toEqual([
          expect.objectContaining({
            artifact: "indexing-lock",
            target: "code_a",
            reason: expect.stringMatching(/pid 5151/) as unknown as string,
          }),
        ]);
        expect(stores.snapshotDeleted).toEqual(["code_a"]);
        expect([...qdrant.live]).toEqual([]);
      } finally {
        rmSync(lock.dir, { recursive: true, force: true });
      }
    });
  });

  describe("what the purge intentionally keeps", () => {
    it("names the project directory it never touches", async () => {
      const { purger } = buildPurger();

      const report = await purger.purge({ logicalName: "code_a", path: "/repos/thing" });

      expect(report.kept.join("\n")).toContain("/repos/thing");
    });

    it("names worktree clones derived from this project instead of removing them", async () => {
      const registry = {
        listWorktrees: () => [
          { collectionName: "code_wt", name: "thing-worktree-fix", worktreeOf: "code_a", worktreeName: "fix" },
          { collectionName: "code_zz", name: "other-worktree-x", worktreeOf: "code_b", worktreeName: "x" },
        ],
      };
      const qdrant = fakeQdrant(["code_a_v1", "code_wt_v1"]);
      const { purger } = buildPurger({ qdrant, registry });

      const report = await purger.purge({ logicalName: "code_a" });

      const kept = report.kept.join("\n");
      expect(kept).toContain("thing-worktree-fix");
      expect(kept).not.toContain("other-worktree-x");
      // The clone's own collection is another project's footprint — untouched.
      expect([...qdrant.live]).toEqual(["code_wt_v1"]);
    });

    it("leaves a codegraph daemon that is serving other clients running, and says so", async () => {
      const daemon = { pid: () => 4242, refs: () => 3 };
      const { purger } = buildPurger({ daemon });

      const report = await purger.purge({ logicalName: "code_a" });

      const kept = report.kept.join("\n");
      expect(kept).toContain("4242");
      expect(kept).toMatch(/serving|client/i);
    });

    it("says nothing about the daemon when none is running", async () => {
      const daemon = { pid: () => undefined, refs: () => 0 };
      const { purger } = buildPurger({ daemon });

      const report = await purger.purge({ logicalName: "code_a" });

      expect(report.kept.join("\n")).not.toMatch(/daemon/i);
    });
  });

  describe("purgeGeneration", () => {
    // An orphan generation of a LIVE project (`code_a_v1` while alias `code_a`
    // points at `code_a_v2`) is addressed by its physical name alone. Routing it
    // through the logical-name `purge` would take the live generation, the
    // alias and every alias-keyed store with it.
    function liveProject() {
      const qdrant = fakeQdrant(["code_a_v1", "code_a_v2"], [{ aliasName: "code_a", collectionName: "code_a_v2" }]);
      const codegraph = fakeCodegraphStore(["code_a_v1", "code_a_v2"]);
      return { qdrant, codegraph, ...buildPurger({ qdrant, codegraph }) };
    }

    it("drops the orphan generation and leaves the live generation, the alias and the stores", async () => {
      const { purger, qdrant, codegraph, stores } = liveProject();

      const report = await purger.purgeGeneration({
        logicalName: "code_a",
        physicalName: fixturePhysicalCollectionName("code_a_v1"),
      });

      expect([...qdrant.live]).toEqual(["code_a_v2"]);
      expect(await qdrant.aliases.listAliases()).toEqual([{ aliasName: "code_a", collectionName: "code_a_v2" }]);
      expect([...codegraph.files]).toEqual(["code_a_v2"]);
      expect(stores.snapshotDeleted).toEqual([]);
      expect(stores.statsInvalidated).toEqual([]);
      expect(stores.lockTornDown).toEqual([]);
      expect(report.qdrantCollections).toEqual(["code_a_v1"]);
      expect(report.codegraphDatabases).toEqual(["code_a_v1"]);
      expect(report.qdrantAlias).toBe("code_a_v2");
      expect(report.failures).toEqual([]);
    });

    it("refuses the generation the alias points at and removes nothing", async () => {
      const { purger, qdrant, codegraph } = liveProject();

      const report = await purger.purgeGeneration({
        logicalName: "code_a",
        physicalName: fixturePhysicalCollectionName("code_a_v2"),
      });

      expect([...qdrant.live].sort()).toEqual(["code_a_v1", "code_a_v2"]);
      expect([...codegraph.files].sort()).toEqual(["code_a_v1", "code_a_v2"]);
      expect(qdrant.deleteCollection).not.toHaveBeenCalled();
      expect(report.failures).toEqual([
        { artifact: "qdrant", target: "code_a_v2", reason: "live generation of 'code_a' — refusing to purge it" },
      ]);
    });

    it("refuses a name that is not a generation of the logical collection", async () => {
      const { purger, qdrant } = liveProject();

      const report = await purger.purgeGeneration({
        logicalName: "code_a",
        physicalName: fixturePhysicalCollectionName("code_a"),
      });

      expect(qdrant.deleteCollection).not.toHaveBeenCalled();
      expect(report.failures.map((f) => f.reason)).toEqual(["'code_a' is not a versioned generation of 'code_a'"]);
    });

    it("refuses when the alias cannot be read, since the generation cannot be proven dead", async () => {
      const { purger, qdrant } = liveProject();
      qdrant.aliases.listAliases.mockRejectedValueOnce(new Error("connection refused"));

      const report = await purger.purgeGeneration({
        logicalName: "code_a",
        physicalName: fixturePhysicalCollectionName("code_a_v1"),
      });

      expect(qdrant.deleteCollection).not.toHaveBeenCalled();
      expect(report.failures).toEqual([
        { artifact: "qdrant", target: "code_a_v1", reason: "cannot read aliases (connection refused) — refusing" },
      ]);
    });
  });

  describe("purgeStoreLeftovers", () => {
    // Store-only leftovers are swept in one pass: Qdrant is read once for the
    // whole batch, not once per logical name as `purge` would.
    it("clears the alias-keyed stores of every leftover with one Qdrant read for the batch", async () => {
      const qdrant = fakeQdrant([]);
      const { purger, stores } = buildPurger({ qdrant });

      const result = await purger.purgeStoreLeftovers(["code_x", "code_y"]);

      expect(result.purged).toEqual(["code_x", "code_y"]);
      expect(result.failures).toEqual([]);
      expect(stores.snapshotDeleted).toEqual(["code_x", "code_y"]);
      expect(stores.statsInvalidated).toEqual(["code_x", "code_y"]);
      expect(stores.quarantineCleared).toEqual(["code_x", "code_y"]);
      expect(stores.skippedCleared).toEqual(["code_x", "code_y"]);
      expect(stores.lockTornDown).toEqual(["code_x", "code_y"]);
      expect(qdrant.listCollections).toHaveBeenCalledTimes(1);
      expect(qdrant.aliases.listAliases).toHaveBeenCalledTimes(1);
      expect(qdrant.deleteCollection).not.toHaveBeenCalled();
    });

    it("refuses a logical name that still has an alias or a Qdrant generation", async () => {
      const qdrant = fakeQdrant(["code_g_v3"], [{ aliasName: "code_a", collectionName: "code_b_v1" }]);
      const { purger, stores } = buildPurger({ qdrant });

      const result = await purger.purgeStoreLeftovers(["code_a", "code_g", "code_x"]);

      expect(result.purged).toEqual(["code_x"]);
      expect(stores.snapshotDeleted).toEqual(["code_x"]);
      expect(result.failures).toEqual([
        { artifact: "snapshot", target: "code_a", reason: "alias 'code_a' is live — not a store leftover" },
        { artifact: "snapshot", target: "code_g", reason: "Qdrant still holds code_g_v3 — not a store leftover" },
      ]);
    });

    it("refuses the whole batch when Qdrant cannot be read", async () => {
      const qdrant = fakeQdrant([]);
      qdrant.listCollections.mockRejectedValueOnce(new Error("connection refused"));
      const { purger, stores } = buildPurger({ qdrant });

      const result = await purger.purgeStoreLeftovers(["code_x"]);

      expect(result.purged).toEqual([]);
      expect(stores.snapshotDeleted).toEqual([]);
      expect(result.failures).toEqual([
        { artifact: "snapshot", target: "code_x", reason: "cannot read Qdrant (connection refused) — refusing" },
      ]);
    });

    it("reports progress as a running count", async () => {
      const { purger } = buildPurger();
      const progress: [number, number][] = [];

      await purger.purgeStoreLeftovers(["a", "b", "c"], {
        progressEvery: 2,
        onProgress: (d, t) => progress.push([d, t]),
      });

      expect(progress).toEqual([
        [2, 3],
        [3, 3],
      ]);
    });
  });
});
