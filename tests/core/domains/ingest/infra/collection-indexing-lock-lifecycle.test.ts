/**
 * The held lock's lifecycle past the happy path (bd tea-rags-mcp-39xca.13):
 * what a heartbeat does once the file under it vanished, was taken over or is
 * no lock at all; that release is idempotent; that a garbled lock is judged by
 * its age alone; and that the DEFAULT liveness probe — `kill(pid, 0)` — tells a
 * dead pid from a live one. Real files in a temp dir; clocks and pids injected
 * wherever the verdict would otherwise depend on timing.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
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

const COLLECTION = "code_lifecycle";
const HOST = "host-a";
const T0 = Date.parse("2026-09-15T10:00:00.000Z");
const HOUR = 3_600_000;
const iso = (epochMs: number): string => new Date(epochMs).toISOString();

describe("CollectionIndexingLock — held-lock lifecycle", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "indexing-lock-lifecycle-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function lockWith(over: Partial<CollectionIndexingLockOptions> = {}): CollectionIndexingLock {
    return new CollectionIndexingLock({
      lockDir: dir,
      pid: 1111,
      hostname: HOST,
      now: () => T0,
      isProcessAlive: () => true,
      heartbeatIntervalMs: HOUR,
      ...over,
    });
  }

  const lockFile = (): string => join(dir, `${COLLECTION}.indexing.lock`);
  const readLock = (): IndexingLockRecord => JSON.parse(readFileSync(lockFile(), "utf8")) as IndexingLockRecord;

  function writeRecord(record: Partial<IndexingLockRecord>): void {
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

  describe("heartbeat", () => {
    it("refreshes on demand, and concurrent refreshes resolve together onto one write", async () => {
      let now = T0;
      const held = await lockWith({ now: () => now }).tryAcquire(COLLECTION, "index-codebase");
      now = T0 + 45_000;

      const [first, second] = await Promise.all([held?.refreshHeartbeat(), held?.refreshHeartbeat()]);

      expect([first, second]).toEqual([true, true]);
      expect(readLock()).toMatchObject({ pid: 1111, startedAt: iso(T0), heartbeatAt: iso(T0 + 45_000) });
      expect(held?.record.heartbeatAt).toBe(iso(T0 + 45_000));
      await held?.release();
    });

    it("writes nothing once released, and a second release is a no-op", async () => {
      const held = await lockWith().tryAcquire(COLLECTION, "index-codebase");
      await held?.release();
      await held?.release();

      expect(await held?.refreshHeartbeat()).toBe(false);
      expect(existsSync(lockFile())).toBe(false);
    });

    it("never revives a lock whose file was removed under it", async () => {
      const held = await lockWith().tryAcquire(COLLECTION, "index-codebase");
      unlinkSync(lockFile());

      expect(await held?.refreshHeartbeat()).toBe(false);
      expect(existsSync(lockFile())).toBe(false);
      await held?.release();
    });

    it("leaves a successor's lock untouched when the path no longer holds this lock", async () => {
      let now = T0;
      const held = await lockWith({ now: () => now }).tryAcquire(COLLECTION, "index-codebase");
      unlinkSync(lockFile());
      writeRecord({ pid: 2222, startedAt: iso(T0 + 1_000), heartbeatAt: iso(T0 + 1_000), operation: "force-reindex" });
      now = T0 + 90_000;

      expect(await held?.refreshHeartbeat()).toBe(false);
      await held?.release();

      expect(readLock()).toEqual({
        pid: 2222,
        hostname: HOST,
        startedAt: iso(T0 + 1_000),
        heartbeatAt: iso(T0 + 1_000),
        operation: "force-reindex",
      });
    });

    it("reports a heartbeat that cannot be written as not refreshed instead of throwing", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      const held = await lockWith().tryAcquire(COLLECTION, "index-codebase");
      unlinkSync(lockFile());
      mkdirSync(lockFile());

      expect(await held?.refreshHeartbeat()).toBe(false);
      // Release cannot read the path either: it surfaces as the typed lock error.
      await expect(held?.release()).rejects.toBeInstanceOf(IndexingLockUnavailableError);
    });
  });

  describe("footprint teardown of a lock whose content does not parse", () => {
    it.each([
      ["a JSON null", "null"],
      [
        "a record missing its operation",
        JSON.stringify({ pid: 1, hostname: HOST, startedAt: "x", heartbeatAt: iso(T0) }),
      ],
      [
        "a record whose heartbeat is not a date",
        JSON.stringify({ pid: 1, hostname: HOST, startedAt: "x", heartbeatAt: "soon", operation: "index-codebase" }),
      ],
    ])("keeps %s while the file is fresh, naming no holder", async (_label, content) => {
      writeFileSync(lockFile(), content);

      const outcome = await lockWith({ now: () => Date.now() }).removeIfStale(COLLECTION);

      expect(outcome).toEqual({ status: "held-live" });
      expect(readFileSync(lockFile(), "utf8")).toBe(content);
    });

    it("removes it once the file's modification time ages past the stale threshold", async () => {
      writeFileSync(lockFile(), "null");
      const agedOutSeconds = (Date.now() - STALE_INDEXING_THRESHOLD_MS - 60_000) / 1000;
      utimesSync(lockFile(), agedOutSeconds, agedOutSeconds);

      const outcome = await lockWith({ now: () => Date.now() }).removeIfStale(COLLECTION);

      expect(outcome).toEqual({ status: "removed-stale" });
      expect(existsSync(lockFile())).toBe(false);
    });

    it("reports an unusable lock directory as IndexingLockUnavailableError", async () => {
      const notADir = join(dir, "plain-file");
      writeFileSync(notADir, "");

      await expect(lockWith({ lockDir: notADir }).removeIfStale(COLLECTION)).rejects.toBeInstanceOf(
        IndexingLockUnavailableError,
      );
    });
  });

  describe("the default liveness probe", () => {
    function lockWithRealProbe(): CollectionIndexingLock {
      return new CollectionIndexingLock({ lockDir: dir, pid: 1111, hostname: HOST, now: () => T0 });
    }

    it("takes over a fresh lock whose same-host owner process has exited", async () => {
      const exited = spawnSync(process.execPath, ["-e", ""]).pid;
      writeRecord({ pid: exited });

      const held = await lockWithRealProbe().tryAcquire(COLLECTION, "index-codebase");

      expect(held).toBeDefined();
      expect(readLock().pid).toBe(1111);
      await held?.release();
    });

    it("refuses a fresh lock whose same-host owner process is running", async () => {
      writeRecord({ pid: process.ppid });

      expect(await lockWithRealProbe().tryAcquire(COLLECTION, "index-codebase")).toBeUndefined();
      expect(readLock().pid).toBe(process.ppid);
    });

    it("counts a process it may not signal (another user's) as alive", async () => {
      // pid 1 always exists; an unprivileged kill(1, 0) fails with EPERM, not ESRCH.
      writeRecord({ pid: 1 });

      const outcome = await lockWithRealProbe().removeIfStale(COLLECTION);

      expect(outcome).toMatchObject({ status: "held-live", holder: { pid: 1 } });
    });
  });
});
