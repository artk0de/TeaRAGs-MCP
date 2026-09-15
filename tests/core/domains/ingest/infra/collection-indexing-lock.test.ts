/**
 * The cross-process claim a collection holds while one index operation runs on it
 * (bd tea-rags-mcp-39xca.13): an exclusive `<collection>.indexing.lock` file.
 *
 * What these pin is the contention contract — who may take the file, who must be
 * refused, and that only the owner ever removes it. Every clock, pid and liveness
 * probe is injected, so each verdict is decided by the rule, not by timing.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IndexingLockUnavailableError } from "../../../../../src/core/domains/ingest/errors.js";
import {
  CollectionIndexingLock,
  type CollectionIndexingLockOptions,
  type IndexingLockRecord,
} from "../../../../../src/core/domains/ingest/infra/collection-indexing-lock.js";
import { STALE_INDEXING_THRESHOLD_MS } from "../../../../../src/core/domains/ingest/pipeline/indexing-marker-codec.js";

const COLLECTION = "code_abc";
const HOST = "host-a";
const T0 = Date.parse("2026-09-15T10:00:00.000Z");
const iso = (epochMs: number): string => new Date(epochMs).toISOString();

describe("CollectionIndexingLock", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "indexing-lock-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function lockWith(over: Partial<CollectionIndexingLockOptions> = {}): CollectionIndexingLock {
    return new CollectionIndexingLock({
      lockDir: dir,
      pid: 1111,
      hostname: HOST,
      now: () => T0,
      isProcessAlive: () => true,
      ...over,
    });
  }

  const lockFile = (): string => join(dir, `${COLLECTION}.indexing.lock`);
  const readLock = (): IndexingLockRecord => JSON.parse(readFileSync(lockFile(), "utf8")) as IndexingLockRecord;

  function writeLockOfAnotherRun(record: Partial<IndexingLockRecord> = {}): void {
    writeFileSync(
      lockFile(),
      JSON.stringify({
        pid: 4242,
        hostname: HOST,
        startedAt: iso(T0),
        heartbeatAt: iso(T0),
        operation: "index-codebase",
        ...record,
      }),
    );
  }

  describe("claiming", () => {
    it("creates <collection>.indexing.lock carrying pid, hostname, startedAt, heartbeatAt and operation", async () => {
      const held = await lockWith().tryAcquire(COLLECTION, "force-reindex");

      expect(held).toBeDefined();
      expect(readLock()).toEqual({
        pid: 1111,
        hostname: HOST,
        startedAt: iso(T0),
        heartbeatAt: iso(T0),
        operation: "force-reindex",
      });
      await held?.release();
    });

    it("creates the lock directory when it does not exist yet", async () => {
      const lockDir = join(dir, "snapshots");
      const held = await lockWith({ lockDir }).tryAcquire(COLLECTION, "index-codebase");

      expect(existsSync(join(lockDir, `${COLLECTION}.indexing.lock`))).toBe(true);
      await held?.release();
    });

    it("refuses a second claim while the first is held, even from the same process", async () => {
      const first = await lockWith().tryAcquire(COLLECTION, "index-codebase");

      const second = await lockWith({ now: () => T0 + 5_000 }).tryAcquire(COLLECTION, "force-reindex");

      expect(second).toBeUndefined();
      expect(readLock()).toMatchObject({ startedAt: iso(T0), operation: "index-codebase" });
      await first?.release();
    });

    it("refuses a lock held by a live process on this host", async () => {
      writeLockOfAnotherRun({ pid: 4242 });

      const held = await lockWith({ isProcessAlive: (pid) => pid === 4242 }).tryAcquire(COLLECTION, "index-codebase");

      expect(held).toBeUndefined();
      expect(readLock().pid).toBe(4242);
    });

    it("takes over a lock whose owner process is dead on this host", async () => {
      writeLockOfAnotherRun({ pid: 4242 });

      const held = await lockWith({ isProcessAlive: (pid) => pid !== 4242 }).tryAcquire(COLLECTION, "index-codebase");

      expect(held).toBeDefined();
      expect(readLock().pid).toBe(1111);
      await held?.release();
    });

    it("takes over a fresh lock that names this very process but that this process no longer holds", async () => {
      // The process is the authority on its own claims: a lock carrying its pid
      // that it does not hold was released mid-unlink or leaked, never live —
      // `kill(own pid, 0)` would call it alive forever.
      writeLockOfAnotherRun({ pid: 1111 });

      const held = await lockWith({ pid: 1111, isProcessAlive: () => true }).tryAcquire(COLLECTION, "index-codebase");

      expect(held).toBeDefined();
      expect(readLock()).toMatchObject({ pid: 1111, operation: "index-codebase", startedAt: iso(T0) });
      await held?.release();
    });

    it("admits a successor in this process as soon as the holder starts releasing", async () => {
      const holder = await lockWith().tryAcquire(COLLECTION, "index-codebase");

      const releasing = holder?.release();
      const successor = await lockWith({ now: () => T0 + 1_000 }).tryAcquire(COLLECTION, "force-reindex");
      await releasing;

      expect(successor).toBeDefined();
      expect(readLock()).toMatchObject({ operation: "force-reindex", startedAt: iso(T0 + 1_000) });
      await successor?.release();
    });

    it("never probes a pid from another host: a fresh lock written elsewhere stays live", async () => {
      writeLockOfAnotherRun({ pid: 4242, hostname: "host-b" });

      const held = await lockWith({ isProcessAlive: () => false }).tryAcquire(COLLECTION, "index-codebase");

      expect(held).toBeUndefined();
    });

    it("takes over a lock whose heartbeat is older than the stale indexing threshold", async () => {
      const agedOut = T0 - STALE_INDEXING_THRESHOLD_MS - 1_000;
      writeLockOfAnotherRun({ hostname: "host-b", startedAt: iso(agedOut), heartbeatAt: iso(agedOut) });

      const held = await lockWith().tryAcquire(COLLECTION, "index-codebase");

      expect(held).toBeDefined();
      expect(readLock()).toMatchObject({ pid: 1111, hostname: HOST });
      await held?.release();
    });

    it("keeps a lock whose heartbeat is exactly at the stale threshold", async () => {
      const edge = T0 - STALE_INDEXING_THRESHOLD_MS;
      writeLockOfAnotherRun({ hostname: "host-b", heartbeatAt: iso(edge) });

      expect(await lockWith().tryAcquire(COLLECTION, "index-codebase")).toBeUndefined();
    });

    it("treats an unreadable lock as live until its modification time ages past the threshold", async () => {
      // A claimant that died between creating the file and writing it leaves it
      // empty. Its pid is unknowable, so only the file's own age can retire it.
      writeFileSync(lockFile(), "");
      const lock = lockWith({ now: () => Date.now() });

      expect(await lock.tryAcquire(COLLECTION, "index-codebase")).toBeUndefined();

      const agedOutSeconds = (Date.now() - STALE_INDEXING_THRESHOLD_MS - 60_000) / 1000;
      utimesSync(lockFile(), agedOutSeconds, agedOutSeconds);
      const held = await lock.tryAcquire(COLLECTION, "index-codebase");
      expect(held).toBeDefined();
      await held?.release();
    });

    it("lets exactly one of two claimants racing over the same stale lock win, leaving no debris", async () => {
      for (let round = 0; round < 25; round++) {
        writeLockOfAnotherRun({ pid: 4242 });
        const isProcessAlive = (pid: number): boolean => pid !== 4242;

        const outcomes = await Promise.all([
          lockWith({ pid: 1111, isProcessAlive }).tryAcquire(COLLECTION, "index-codebase"),
          lockWith({ pid: 2222, isProcessAlive }).tryAcquire(COLLECTION, "index-codebase"),
        ]);

        const winners = outcomes.filter((held) => held !== undefined);
        expect(winners).toHaveLength(1);
        expect(readLock().pid).toBe(winners[0]?.record.pid);
        expect(readdirSync(dir)).toEqual([`${COLLECTION}.indexing.lock`]);
        await winners[0]?.release();
      }
    });

    it("reports an unusable lock directory as IndexingLockUnavailableError", async () => {
      writeFileSync(join(dir, "a-file"), "");

      await expect(
        lockWith({ lockDir: join(dir, "a-file", "snapshots") }).tryAcquire(COLLECTION, "index-codebase"),
      ).rejects.toBeInstanceOf(IndexingLockUnavailableError);
    });
  });

  describe("releasing", () => {
    it("removes the owner's lock", async () => {
      const held = await lockWith().tryAcquire(COLLECTION, "index-codebase");

      await held?.release();

      expect(existsSync(lockFile())).toBe(false);
    });

    it("leaves a lock another claimant took over after this one went stale", async () => {
      const original = await lockWith({ pid: 1111 }).tryAcquire(COLLECTION, "index-codebase");
      const later = T0 + STALE_INDEXING_THRESHOLD_MS + 60_000;
      const successor = await lockWith({ pid: 2222, now: () => later }).tryAcquire(COLLECTION, "index-codebase");
      expect(successor).toBeDefined();

      await original?.release();

      expect(readLock()).toMatchObject({ pid: 2222, startedAt: iso(later) });
      await successor?.release();
    });
  });

  describe("heartbeat", () => {
    it("refreshes heartbeatAt on the heartbeat cadence while the lock is held", async () => {
      let now = T0;
      const held = await lockWith({ now: () => now, heartbeatIntervalMs: 10 }).tryAcquire(COLLECTION, "index-codebase");
      now = T0 + 90_000;

      await vi.waitFor(() => {
        expect(readLock()).toMatchObject({ startedAt: iso(T0), heartbeatAt: iso(T0 + 90_000) });
      });
      await held?.release();
    });

    it("never recreates the lock after it was released", async () => {
      const held = await lockWith({ heartbeatIntervalMs: 5 }).tryAcquire(COLLECTION, "index-codebase");
      await held?.release();

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 40));

      expect(existsSync(lockFile())).toBe(false);
    });
  });

  describe("footprint teardown", () => {
    it("reports absent when no lock exists", async () => {
      expect(await lockWith().removeIfStale(COLLECTION)).toEqual({ status: "absent" });
    });

    it("removes a stale lock", async () => {
      writeLockOfAnotherRun({ pid: 4242 });

      const outcome = await lockWith({ isProcessAlive: () => false }).removeIfStale(COLLECTION);

      expect(outcome).toEqual({ status: "removed-stale" });
      expect(existsSync(lockFile())).toBe(false);
    });

    it("leaves a live lock in place and names its holder", async () => {
      writeLockOfAnotherRun({ pid: 4242, operation: "force-reindex" });

      const outcome = await lockWith().removeIfStale(COLLECTION);

      expect(outcome).toEqual({
        status: "held-live",
        holder: { pid: 4242, hostname: HOST, operation: "force-reindex" },
      });
      expect(readLock().pid).toBe(4242);
    });
  });
});
