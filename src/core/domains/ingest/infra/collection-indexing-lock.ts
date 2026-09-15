/**
 * The cross-process claim one index operation holds on a collection
 * (bd tea-rags-mcp-39xca.13): an exclusive `<collection>.indexing.lock` file
 * beside the collection's other per-collection artifacts.
 *
 * The Qdrant lease (`isCollectionIndexingInFlight`) cannot be the first line on
 * its own. An incremental run writes its indexing marker only when it closes and
 * its `_run` pointer only when enrichment begins, so from the claim until
 * `beginRun` another process reading Qdrant sees nothing and both proceed.
 * `open(path, "wx")` is atomic for every process on the machine and happens at
 * claim time, before any indexing work. The Qdrant lease stays as the second
 * line, for a Qdrant shared across machines.
 *
 * Contention rules:
 * - A lock is LIVE unless stale. Stale means written on THIS host by a pid that
 *   no longer exists, or a heartbeat older than `STALE_INDEXING_THRESHOLD_MS` —
 *   the window after which an indexing marker is presumed dead too. A pid from
 *   another host is never probed: it names a process on that machine.
 * - A lock that does not parse (a claimant died between creating the file and
 *   writing it) is aged by the file's modification time instead.
 * - A stale lock is taken over by renaming it aside, confirming the renamed file
 *   is the very lock that was judged stale, and retrying `wx` once. Unlinking by
 *   path would let a second claimant that judged the same stale lock delete the
 *   first one's fresh lock; the confirmation turns that race into a refusal.
 * - Only the owner — same pid and startedAt, same file — removes a lock.
 * - A lock naming THIS process is live only while this process holds it. The
 *   process is the authority on its own claims, so a successor here takes over a
 *   lock whose release is still unlinking, or whose unlink failed, instead of
 *   waiting out a heartbeat `kill(own pid, 0)` would call alive forever.
 */

import { randomUUID } from "node:crypto";
import { link, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { hostname as osHostname } from "node:os";
import { join } from "node:path";

import type { IndexingLockRemovalOutcome } from "../../../contracts/types/footprint.js";
import { isDebug } from "../../../infra/runtime.js";
import { IndexingLockUnavailableError } from "../errors.js";
import { INDEXING_HEARTBEAT_INTERVAL_MS, STALE_INDEXING_THRESHOLD_MS } from "../pipeline/index.js";

/** The lock file's JSON content. */
export interface IndexingLockRecord {
  pid: number;
  hostname: string;
  startedAt: string;
  heartbeatAt: string;
  /** What the holder is doing: `index-codebase`, `force-reindex`, `force-enrichments`. */
  operation: string;
}

export interface CollectionIndexingLockOptions {
  /** Directory holding the per-collection artifacts (the snapshots dir). Created on the first claim. */
  lockDir: string;
  /** Epoch ms. Defaults to `Date.now`. */
  now?: () => number;
  /** This process's pid. Defaults to `process.pid`. */
  pid?: number;
  /** This machine's name. Defaults to `os.hostname()`. */
  hostname?: string;
  /** Does a pid on THIS host still name a running process? Defaults to a `kill(pid, 0)` probe. */
  isProcessAlive?: (pid: number) => boolean;
  /** Heartbeat cadence of a held lock. Defaults to `INDEXING_HEARTBEAT_INTERVAL_MS`. */
  heartbeatIntervalMs?: number;
}

/** A lock file as read at one instant: which file it was, what it said, when it last changed. */
interface InspectedLock {
  dev: number;
  ino: number;
  mtimeMs: number;
  record: IndexingLockRecord | undefined;
}

/** `removed` — the expected lock is gone; `gone` — nothing was there; `replaced` — a newer lock holds the path and was kept. */
type ExactLockRemoval = "removed" | "gone" | "replaced";

/**
 * Every lock this process holds right now, by {@link lockHoldKey}. Entries are
 * added when a claim's file is written and dropped synchronously when its release
 * begins — before the unlink — which is what lets a successor in this process
 * take the file over at once.
 */
const locksHeldByThisProcess = new Set<string>();

function lockHoldKey(path: string, record: IndexingLockRecord): string {
  return [path, record.hostname, record.pid, record.startedAt].join("\0");
}

export class CollectionIndexingLock {
  private readonly now: () => number;
  private readonly pid: number;
  private readonly hostname: string;
  private readonly isProcessAlive: (pid: number) => boolean;
  private readonly heartbeatIntervalMs: number;

  constructor(private readonly options: CollectionIndexingLockOptions) {
    this.now = options.now ?? Date.now;
    this.pid = options.pid ?? process.pid;
    this.hostname = options.hostname ?? osHostname();
    this.isProcessAlive = options.isProcessAlive ?? isProcessAliveOnThisHost;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? INDEXING_HEARTBEAT_INTERVAL_MS;
  }

  lockPathFor(collectionName: string): string {
    return join(this.options.lockDir, `${collectionName}.indexing.lock`);
  }

  /**
   * Claim the collection for one operation. Resolves the held lock, or
   * `undefined` when a live run holds it — including when this claim lost the
   * race to take over a stale lock.
   */
  async tryAcquire(collectionName: string, operation: string): Promise<HeldCollectionIndexingLock | undefined> {
    const path = this.lockPathFor(collectionName);
    try {
      await mkdir(this.options.lockDir, { recursive: true });
      const held = await this.create(path, operation);
      if (held) return held;

      const existing = await inspectLock(path);
      if (existing) {
        if (!this.isStale(path, existing)) return undefined;
        if ((await removeExactLock(path, existing)) === "replaced") return undefined;
      }
      return await this.create(path, operation);
    } catch (error) {
      throw new IndexingLockUnavailableError(path, asError(error));
    }
  }

  /**
   * Footprint teardown: remove the collection's lock when the run that holds it
   * is dead, leave it in place when that run is alive.
   */
  async removeIfStale(collectionName: string): Promise<IndexingLockRemovalOutcome> {
    const path = this.lockPathFor(collectionName);
    try {
      const existing = await inspectLock(path);
      if (!existing) return { status: "absent" };
      if (!this.isStale(path, existing)) return heldLive(existing.record);

      const removal = await removeExactLock(path, existing);
      if (removal === "removed") return { status: "removed-stale" };
      if (removal === "gone") return { status: "absent" };
      return heldLive((await inspectLock(path))?.record);
    } catch (error) {
      throw new IndexingLockUnavailableError(path, asError(error));
    }
  }

  private async create(path: string, operation: string): Promise<HeldCollectionIndexingLock | undefined> {
    let handle: FileHandle;
    try {
      handle = await open(path, "wx");
    } catch (error) {
      if (errorCode(error) === "EEXIST") return undefined;
      throw error;
    }

    const startedAt = new Date(this.now()).toISOString();
    const record: IndexingLockRecord = {
      pid: this.pid,
      hostname: this.hostname,
      startedAt,
      heartbeatAt: startedAt,
      operation,
    };
    let created: InspectedLock | undefined;
    try {
      const { dev, ino, mtimeMs } = await handle.stat();
      created = { dev, ino, mtimeMs, record };
      await handle.writeFile(JSON.stringify(record));
    } catch (error) {
      if (created) await removeExactLock(path, { ...created, record: undefined }).catch(() => undefined);
      throw error;
    } finally {
      await handle.close();
    }
    locksHeldByThisProcess.add(lockHoldKey(path, record));
    return new HeldCollectionIndexingLock(path, created, this.now, this.heartbeatIntervalMs);
  }

  private isStale(path: string, lock: InspectedLock): boolean {
    const now = this.now();
    if (!lock.record) return now - lock.mtimeMs > STALE_INDEXING_THRESHOLD_MS;
    if (lock.record.hostname === this.hostname) {
      if (lock.record.pid === this.pid) return !locksHeldByThisProcess.has(lockHoldKey(path, lock.record));
      if (!this.isProcessAlive(lock.record.pid)) return true;
    }
    return now - Date.parse(lock.record.heartbeatAt) > STALE_INDEXING_THRESHOLD_MS;
  }
}

/**
 * A lock this process holds. Keeps its heartbeat fresh until released; the
 * timer is unref'd, so a held lock never keeps the process alive on its own.
 */
export class HeldCollectionIndexingLock {
  private readonly current: IndexingLockRecord;
  private readonly timer: ReturnType<typeof setInterval>;
  private pendingRefresh: Promise<boolean> | undefined;
  private released = false;

  constructor(
    readonly path: string,
    private readonly identity: InspectedLock,
    private readonly now: () => number,
    heartbeatIntervalMs: number,
  ) {
    this.current = { ...(identity.record as IndexingLockRecord) };
    this.timer = setInterval(() => {
      void this.refreshHeartbeat();
    }, heartbeatIntervalMs);
    this.timer.unref();
  }

  /** A copy of what the lock file currently says. */
  get record(): IndexingLockRecord {
    return { ...this.current };
  }

  /**
   * Rewrite `heartbeatAt` in place. Resolves `false` — writing nothing — once the
   * lock is released or the path no longer holds THIS lock.
   */
  async refreshHeartbeat(): Promise<boolean> {
    if (this.released) return false;
    if (this.pendingRefresh) return this.pendingRefresh;
    this.pendingRefresh = this.writeHeartbeat()
      .catch((error: unknown) => {
        if (isDebug()) console.error(`[CollectionIndexingLock] heartbeat of ${this.path} failed:`, error);
        return false;
      })
      .finally(() => {
        this.pendingRefresh = undefined;
      });
    return this.pendingRefresh;
  }

  /** Stop the heartbeat and remove the lock file — only if it is still this lock. Idempotent. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    clearInterval(this.timer);
    locksHeldByThisProcess.delete(lockHoldKey(this.path, this.current));
    await this.pendingRefresh;
    try {
      const onDisk = await inspectLock(this.path);
      if (!onDisk || !isSameLock(this.ownIdentity(), onDisk)) return;
      await removeExactLock(this.path, this.ownIdentity());
    } catch (error) {
      throw new IndexingLockUnavailableError(this.path, asError(error));
    }
  }

  private ownIdentity(): InspectedLock {
    return { ...this.identity, record: this.current };
  }

  private async writeHeartbeat(): Promise<boolean> {
    let handle: FileHandle;
    try {
      // `r+` never creates: a lock that was released or taken over is not revived.
      handle = await open(this.path, "r+");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    try {
      const { dev, ino, mtimeMs } = await handle.stat();
      const onDisk: InspectedLock = { dev, ino, mtimeMs, record: parseLockRecord(await handle.readFile("utf8")) };
      if (this.released || !isSameLock(this.ownIdentity(), onDisk)) return false;
      this.current.heartbeatAt = new Date(this.now()).toISOString();
      await handle.truncate(0);
      await handle.write(JSON.stringify(this.current), 0, "utf8");
      return true;
    } finally {
      await handle.close();
    }
  }
}

/**
 * Is `actual` the lock `expected` describes? Same file, and the same claim in it:
 * pid and startedAt when the content parses, the modification time when it does
 * not. The content check matters because a filesystem may hand a just-freed
 * inode number straight to the next claimant's new file.
 */
function isSameLock(expected: InspectedLock, actual: InspectedLock): boolean {
  if (expected.dev !== actual.dev || expected.ino !== actual.ino) return false;
  if (!expected.record) return !actual.record && expected.mtimeMs === actual.mtimeMs;
  return actual.record?.pid === expected.record.pid && actual.record.startedAt === expected.record.startedAt;
}

async function inspectLock(path: string): Promise<InspectedLock | undefined> {
  let handle: FileHandle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    const { dev, ino, mtimeMs } = await handle.stat();
    return { dev, ino, mtimeMs, record: parseLockRecord(await handle.readFile("utf8")) };
  } finally {
    await handle.close();
  }
}

/**
 * Remove the lock at `path` only if it is still `expected`. The file is renamed
 * aside first — atomic, so nobody else can be holding the path at that moment —
 * and checked there. A lock that turns out to be newer than `expected` is linked
 * back into place (`link` refuses to overwrite a claim made in the meantime).
 */
async function removeExactLock(path: string, expected: InspectedLock): Promise<ExactLockRemoval> {
  const aside = `${path}.${randomUUID()}.takeover`;
  try {
    await rename(path, aside);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "gone";
    throw error;
  }
  const moved = await inspectLock(aside);
  if (moved && isSameLock(expected, moved)) {
    await unlink(aside);
    return "removed";
  }
  try {
    await link(aside, path);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
  }
  await unlink(aside);
  return "replaced";
}

function parseLockRecord(raw: string): IndexingLockRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const { pid, hostname, startedAt, heartbeatAt, operation } = value as Record<string, unknown>;
  if (
    typeof pid !== "number" ||
    typeof hostname !== "string" ||
    typeof startedAt !== "string" ||
    typeof heartbeatAt !== "string" ||
    typeof operation !== "string" ||
    !Number.isFinite(Date.parse(heartbeatAt))
  ) {
    return undefined;
  }
  return { pid, hostname, startedAt, heartbeatAt, operation };
}

function heldLive(record: IndexingLockRecord | undefined): IndexingLockRemovalOutcome {
  if (!record) return { status: "held-live" };
  return { status: "held-live", holder: { pid: record.pid, hostname: record.hostname, operation: record.operation } };
}

/** `kill(pid, 0)` delivers nothing; ESRCH means no such process, EPERM means it exists under another user. */
function isProcessAliveOnThisHost(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

function asError(error: unknown): Error | undefined {
  return error instanceof Error ? error : undefined;
}
