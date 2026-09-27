/**
 * get_index_status against a run that was hard-killed (bd tea-rags-mcp-f93ao).
 *
 * The Qdrant indexing marker carries only timestamps, so on its own a reader
 * cannot tell a slow live run from a dead one and waits out
 * `STALE_INDEXING_THRESHOLD_MS`. The collection's indexing lock names the
 * writer's pid and host: when that writer is provably dead on this host, status
 * says `stale_indexing` at once. Deleting the orphan stays on the timer.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MockQdrantManager } from "../__helpers__/test-helpers.js";
import { fixtureCollectionAlias } from "../../../__helpers__/collection-identity.js";
import { INDEXING_METADATA_ID } from "../../../../../src/core/contracts/constants.js";
import {
  CollectionIndexingLock,
  type CollectionIndexingLockOptions,
} from "../../../../../src/core/domains/ingest/infra/collection-indexing-lock.js";
import { StatusModule } from "../../../../../src/core/domains/ingest/pipeline/status-module.js";

const ALIAS = "code_f93ao";
const HOST = "host-a";
const WRITER_PID = 4242;
const VECTOR = new Array(384).fill(0);

describe("StatusModule — writer liveness from the collection's indexing lock", () => {
  let lockDir: string;
  let qdrant: MockQdrantManager;

  beforeEach(() => {
    lockDir = mkdtempSync(join(tmpdir(), "status-liveness-"));
    qdrant = new MockQdrantManager();
  });

  afterEach(() => {
    rmSync(lockDir, { recursive: true, force: true });
  });

  function statusWith(lockOptions?: Partial<CollectionIndexingLockOptions>): StatusModule {
    const lock = lockOptions ? new CollectionIndexingLock({ lockDir, hostname: HOST, ...lockOptions }) : undefined;
    return new StatusModule(
      qdrant as never,
      lockDir,
      undefined,
      [],
      async () => Promise.resolve(fixtureCollectionAlias(ALIAS)),
      lock,
    );
  }

  function writeWriterLock(record: { pid?: number; hostname?: string } = {}): void {
    const now = new Date().toISOString();
    writeFileSync(
      join(lockDir, `${ALIAS}.indexing.lock`),
      JSON.stringify({
        pid: WRITER_PID,
        hostname: HOST,
        startedAt: now,
        heartbeatAt: now,
        operation: "force-reindex",
        ...record,
      }),
    );
  }

  /** `_v1` complete behind the alias, `_v2` a force reindex whose marker heartbeat is FRESH. */
  async function seedForceReindexInFlight(): Promise<void> {
    await qdrant.createCollection(`${ALIAS}_v1`, 384, "Cosine", false);
    await qdrant.addPoints(`${ALIAS}_v1`, [
      {
        id: INDEXING_METADATA_ID,
        vector: VECTOR,
        payload: { _type: "indexing_metadata", indexingComplete: true, completedAt: new Date().toISOString() },
      },
      { id: "chunk-1", vector: VECTOR, payload: { relativePath: "a.ts" } },
    ]);
    await qdrant.aliases.createAlias(ALIAS, `${ALIAS}_v1`);

    const now = new Date().toISOString();
    await qdrant.createCollection(`${ALIAS}_v2`, 384, "Cosine", false);
    await qdrant.addPoints(`${ALIAS}_v2`, [
      {
        id: INDEXING_METADATA_ID,
        vector: VECTOR,
        payload: { _type: "indexing_metadata", indexingComplete: false, startedAt: now, lastHeartbeat: now },
      },
      { id: "partial-1", vector: VECTOR, payload: { relativePath: "a.ts" } },
      { id: "partial-2", vector: VECTOR, payload: { relativePath: "b.ts" } },
    ]);
  }

  it("reports stale_indexing immediately when the lock's writer is a dead process on this host", async () => {
    await seedForceReindexInFlight();
    writeWriterLock();

    const status = await statusWith({ isProcessAlive: (pid) => pid !== WRITER_PID }).getIndexStatus("/tmp");

    expect(status).toMatchObject({ isIndexed: false, status: "stale_indexing", collectionName: ALIAS, chunksCount: 2 });
  });

  it("keeps the orphan collection while its marker heartbeat is fresh — deletion stays on the timer", async () => {
    await seedForceReindexInFlight();
    writeWriterLock();

    await statusWith({ isProcessAlive: (pid) => pid !== WRITER_PID }).getIndexStatus("/tmp");

    expect(await qdrant.collectionExists(`${ALIAS}_v2`)).toBe(true);
  });

  it("reports indexing while the lock's writer is alive on this host", async () => {
    await seedForceReindexInFlight();
    writeWriterLock();

    const status = await statusWith({ isProcessAlive: () => true }).getIndexStatus("/tmp");

    expect(status).toMatchObject({ status: "indexing", collectionName: ALIAS });
  });

  it("falls back to the marker heartbeat when no lock exists — a writer on another host", async () => {
    await seedForceReindexInFlight();

    const status = await statusWith({ isProcessAlive: () => false }).getIndexStatus("/tmp");

    expect(status).toMatchObject({ status: "indexing", collectionName: ALIAS });
  });

  it("falls back to the marker heartbeat when the lock names a writer on another host", async () => {
    await seedForceReindexInFlight();
    writeWriterLock({ hostname: "another-machine" });

    const status = await statusWith({ isProcessAlive: () => false }).getIndexStatus("/tmp");

    expect(status).toMatchObject({ status: "indexing", collectionName: ALIAS });
  });

  it("falls back to the marker heartbeat when the lock cannot be read", async () => {
    await seedForceReindexInFlight();
    // The lock directory is a plain file: every read of a lock inside it fails.
    const notADir = join(lockDir, "not-a-dir");
    writeFileSync(notADir, "");
    const status = new StatusModule(
      qdrant as never,
      lockDir,
      undefined,
      [],
      async () => Promise.resolve(fixtureCollectionAlias(ALIAS)),
      new CollectionIndexingLock({ lockDir: notADir, hostname: HOST, isProcessAlive: () => false }),
    );

    await expect(status.getIndexStatus("/tmp")).resolves.toMatchObject({ status: "indexing", collectionName: ALIAS });
  });

  it("falls back to the marker heartbeat when no lock is wired", async () => {
    await seedForceReindexInFlight();
    writeWriterLock();

    const status = await statusWith().getIndexStatus("/tmp");

    expect(status).toMatchObject({ status: "indexing", collectionName: ALIAS });
  });
});
