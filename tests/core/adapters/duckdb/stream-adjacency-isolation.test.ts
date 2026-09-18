/**
 * The adjacency stream the cycle / PageRank recompute drains is either WHOLE or
 * an error — never a silently short graph (bd tea-rags-mcp-sgo8v).
 *
 * `streamAdjacency` used to stream on the session's one shared connection. A
 * DuckDB streaming result is invalidated by any other statement on its
 * connection, and `fetchChunk` then answers `null` — exactly what it answers at
 * the true end. Probed: 3000 edges drained alone, 2048 beside one concurrent
 * read, no error either way. In the daemon every client of a collection shares
 * that connection, so any `get_callers` landing during
 * `computeAndPersistCyclesAndSignals` handed Tarjan and PageRank the first
 * chunk of the graph, and the truncated result was persisted as the metrics.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DuckDBResult } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DuckDbGraphClient } from "../../../../src/core/adapters/duckdb/client.js";
import { DuckDbStreamIncompleteError } from "../../../../src/core/adapters/duckdb/errors.js";
import { runMigrations } from "../../../../src/core/domains/maintenance/migration/database/runner.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MIG_DIR = resolve(__dirname, "../../../../src/core/domains/maintenance/migration/database/migrations");

/** More edges than one DuckDB chunk (2048 rows), so a truncation is visible. */
const EDGES = 3000;

async function seedFileRing(client: DuckDbGraphClient, count: number): Promise<void> {
  await client.upsertFilesBulk(
    Array.from({ length: count }, (_, i) => ({
      node: { relPath: `f${i}.ts`, language: "typescript" },
      edges: { fileEdges: [{ targetRelPath: `f${(i + 1) % count}.ts`, importText: "./next" }], methodEdges: [] },
    })),
  );
}

async function drain(client: DuckDbGraphClient): Promise<number> {
  let n = 0;
  for await (const _edge of client.streamAdjacency("file")) n += 1;
  return n;
}

describe("DuckDbGraphClient#streamAdjacency — whole or loud", () => {
  let tmp: string;
  let client: DuckDbGraphClient;

  beforeEach(async () => {
    tmp = mkdtempSync(join(tmpdir(), "cg-stream-isolation-"));
    client = new DuckDbGraphClient({ path: join(tmp, "g.duckdb") });
    await client.init();
    await runMigrations(client, MIG_DIR);
    await seedFileRing(client, EDGES);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await client.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("drains every edge while other statements run on the same client", async () => {
    const [drained] = await Promise.all([
      drain(client),
      (async () => {
        for (let i = 0; i < 5; i++) await client.getFanInP95();
      })(),
    ]);

    expect(drained).toBe(EDGES);
  });

  it("drains the graph as it stood when the stream began, whatever commits meanwhile", async () => {
    const [drained] = await Promise.all([
      drain(client),
      client.upsertFilesBulk([
        {
          node: { relPath: "late.ts", language: "typescript" },
          edges: { fileEdges: [{ targetRelPath: "f0.ts", importText: "./f0" }], methodEdges: [] },
        },
      ]),
    ]);

    expect([EDGES, EDGES + 1]).toContain(drained);
    expect(await drain(client)).toBe(EDGES + 1);
  });

  it("throws, rather than ending short, when the driver stops answering before the result is done", async () => {
    // The shape of an invalidated stream: a null chunk before the last row.
    const { fetchChunk } = DuckDBResult.prototype;
    let fetches = 0;
    vi.spyOn(DuckDBResult.prototype, "fetchChunk").mockImplementation(async function (this: DuckDBResult) {
      fetches += 1;
      return fetches === 1 ? fetchChunk.call(this) : null;
    });

    await expect(drain(client)).rejects.toBeInstanceOf(DuckDbStreamIncompleteError);
  });

  it("throws when the client closes under a stream that is still being drained", async () => {
    const iterator = client.streamAdjacency("file")[Symbol.asyncIterator]();
    await iterator.next();

    await client.close();

    await expect(
      (async () => {
        for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
          // drain whatever was already buffered
        }
      })(),
    ).rejects.toBeInstanceOf(DuckDbStreamIncompleteError);
    // The fixture's afterEach closes again; that must stay a no-op.
  });
});
