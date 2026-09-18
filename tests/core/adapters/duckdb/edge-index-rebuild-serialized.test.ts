/**
 * The periodic `cg_symbols_edges_file` index rebuild never lands inside another
 * writer's transaction (bd tea-rags-mcp-sgo8v).
 *
 * Every write to a codegraph database reaches ONE connection — in production the
 * daemon's per-collection client, which every enrichment worker multiplexes
 * onto. Transactional writes serialize through the session's write queue, so a
 * second BEGIN never lands on an open one. The index rebuild used to bypass that
 * queue: its DROP/CREATE INDEX executed the moment it was issued, and when
 * another writer's bulk upsert had its BEGIN open on the shared connection the
 * DDL simply became part of THAT transaction.
 *
 * With one pass-2 writer the only candidate was the node-flush chain; with one
 * pass-2 writer per language partition, each pass-2's checkpoint-time rebuild
 * can land inside the other's `upsertFilesBulk` — the transaction that writes
 * the very table being re-indexed.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../src/core/domains/maintenance/migration/database/migrations");

/** The shared connection's write surface: what every writer on it goes through. */
interface SharedConnectionSession {
  exec: (sql: string) => Promise<void>;
  transaction: <T>(body: () => Promise<T>) => Promise<T>;
}

describe("DuckDbGraphClient — edge-index rebuild on a shared connection", () => {
  let tmp: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-index-rebuild-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
  });

  afterEach(async () => {
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("waits for an open transaction to COMMIT instead of executing inside it", async () => {
    const { session } = client as unknown as { session: SharedConnectionSession };
    const statements: string[] = [];
    const exec = session.exec.bind(session);
    session.exec = async (sql: string) => {
      statements.push(sql.startsWith("DROP INDEX") ? "REBUILD" : sql);
      return exec(sql);
    };

    let releaseWriter!: () => void;
    const writerHeld = new Promise<void>((resolveHeld) => {
      releaseWriter = resolveHeld;
    });
    let writerOpened!: () => void;
    const writerBegan = new Promise<void>((resolveBegan) => {
      writerOpened = resolveBegan;
    });
    // Another writer's transaction, held open the way a bulk upsert is while
    // its statements run.
    const writer = session.transaction(async () => {
      writerOpened();
      await writerHeld;
    });
    await writerBegan;

    const rebuild = client.rebuildEdgeFileTargetIndex();
    // Give an unserialized rebuild every chance to run before the writer ends.
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    releaseWriter();
    await Promise.all([writer, rebuild]);

    const begin = statements.indexOf("BEGIN");
    const commit = statements.indexOf("COMMIT");
    const rebuildAt = statements.indexOf("REBUILD");
    expect(begin).toBeGreaterThanOrEqual(0);
    expect(rebuildAt).toBeGreaterThan(commit);
  });
});
