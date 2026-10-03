/**
 * `WorkingTreeDeltaWarmer` (WTO unbounded delta, Task 5): a per-process queue
 * that turns a tree's re-read files into rows through the chunk layer. A view
 * waits at most its budget and is answered with what is warm; the rest is
 * `pending` and keeps warming in the background.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import {
  createWorkingTreeChunkLayer,
  createWorkingTreeChunkStore,
  WorkingTreeDeltaWarmer,
  type WorkingTreeChunkLayer,
  type WorkingTreeDeltaWarmRequest,
} from "../../../../../src/core/domains/explore/working-tree/index.js";
import type { ChunkerConfig } from "../../../../../src/core/types.js";
import { cleanupTempDir, createTempTestDir } from "../../ingest/__helpers__/test-helpers.js";

const CONFIG: ChunkerConfig = { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 2500 };
const COLLECTION = "code_warmer";
/** A clock far ahead of every file timestamp: no remembered result looks racily fresh. */
const AFTER_THE_FACT = () => Date.now() + 60_000;

type ChunkFile = (pool: unknown, file: { relativePath: string; code: string }) => Promise<ScrollChunk[]>;

const rowOf = (file: { relativePath: string; code: string }): ScrollChunk[] => [
  { id: `id:${file.relativePath}`, payload: { relativePath: file.relativePath, content: file.code } },
];

const settle = async (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("WorkingTreeDeltaWarmer", () => {
  let tempDir: string;
  let tree: string;
  const disposables: { dispose: () => unknown }[] = [];

  const write = (relativePath: string, content: string): void => {
    const target = join(tree, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  const request = (paths: readonly string[]): WorkingTreeDeltaWarmRequest => ({
    treeRoot: tree,
    collectionName: COLLECTION,
    config: CONFIG,
    paths,
  });

  const layerOver = (chunkFile: ChunkFile, storeDir?: string): WorkingTreeChunkLayer => {
    const layer = createWorkingTreeChunkLayer({
      createPool: () => ({ shutdown: async () => undefined }),
      chunkFile: vi.fn(chunkFile),
      ...(storeDir ? { store: createWorkingTreeChunkStore({ rootDir: storeDir }) } : {}),
    });
    disposables.push(layer);
    return layer;
  };

  const warmerOver = (
    layer: WorkingTreeChunkLayer,
    options: { batchSize?: number; now?: () => number } = {},
  ): WorkingTreeDeltaWarmer => {
    const warmer = new WorkingTreeDeltaWarmer({ layer, ...options });
    disposables.push(warmer);
    return warmer;
  };

  /** A chunker whose calls wait until the test releases them, by path. */
  const gatedChunker = () => {
    const started: string[] = [];
    const gates = new Map<string, () => void>();
    const chunkFile = vi.fn(async (_pool: unknown, file: { relativePath: string; code: string }) => {
      started.push(file.relativePath);
      await new Promise<void>((resolve) => gates.set(file.relativePath, resolve));
      return rowOf(file);
    });
    const release = async (path: string): Promise<void> => {
      while (!gates.has(path)) await settle();
      gates.get(path)?.();
      gates.delete(path);
    };
    return { chunkFile, started, release };
  };

  beforeEach(async () => {
    ({ tempDir, codebaseDir: tree } = await createTempTestDir());
  });

  afterEach(async () => {
    for (const disposable of disposables.splice(0)) await disposable.dispose();
    vi.useRealTimers();
    await cleanupTempDir(tempDir);
  });

  it("should answer with the warm part when the budget lapses and keep warming the rest", async () => {
    write("a.ts", "export const a = 1;\n");
    write("b.ts", "export const b = 1;\n");
    let releaseB: () => void = () => undefined;
    const chunkFile = vi.fn(async (_pool: unknown, file: { relativePath: string; code: string }) => {
      if (file.relativePath === "b.ts") await new Promise<void>((resolve) => (releaseB = resolve));
      return rowOf(file);
    });
    const warmer = warmerOver(layerOver(chunkFile), { batchSize: 1 });

    const partial = await warmer.warm(request(["a.ts", "b.ts"]), 1_000, "live");

    expect([...partial.warmPaths]).toEqual(["a.ts"]);
    expect(partial.rows.map((row) => row.id)).toEqual(["id:a.ts"]);
    expect(partial.pending).toEqual(["b.ts"]);
    expect([...partial.storeKeys.keys()]).toEqual(["a.ts"]);

    releaseB();
    await vi.waitFor(() => {
      expect(chunkFile).toHaveBeenCalledTimes(2);
    });
    const full = await warmer.warm(request(["a.ts", "b.ts"]), 5_000, "live");

    expect(full.pending).toEqual([]);
    expect(full.rows.map((row) => row.id)).toEqual(["id:a.ts", "id:b.ts"]);
    expect(chunkFile).toHaveBeenCalledTimes(2); // b.ts warmed once, in the background
  });

  it("should take live work before queued background work", async () => {
    for (const path of ["x1.ts", "x2.ts", "x3.ts", "live.ts"]) write(path, `export const v = "${path}";\n`);
    const chunker = gatedChunker();
    const warmer = warmerOver(layerOver(chunker.chunkFile), { batchSize: 1 });

    const background = warmer.warm(request(["x1.ts", "x2.ts", "x3.ts"]), 10_000, "background");
    while (chunker.started.length === 0) await settle();
    const live = warmer.warm(request(["live.ts"]), 10_000, "live");
    await settle();
    await chunker.release("x1.ts");
    await chunker.release("live.ts");
    await chunker.release("x2.ts");
    await chunker.release("x3.ts");

    expect((await live).pending).toEqual([]);
    expect((await background).pending).toEqual([]);
    expect(chunker.started).toEqual(["x1.ts", "live.ts", "x2.ts", "x3.ts"]);
  });

  it("should promote a path queued in the background when a live request waits on it", async () => {
    for (const path of ["x1.ts", "x2.ts", "x3.ts"]) write(path, `export const v = "${path}";\n`);
    const chunker = gatedChunker();
    const warmer = warmerOver(layerOver(chunker.chunkFile), { batchSize: 1 });

    const background = warmer.warm(request(["x1.ts", "x2.ts", "x3.ts"]), 10_000, "background");
    while (chunker.started.length === 0) await settle();
    const live = warmer.warm(request(["x3.ts"]), 10_000, "live");
    await settle();
    await chunker.release("x1.ts");
    await chunker.release("x3.ts");

    const liveState = await live;
    expect(liveState.pending).toEqual([]);
    expect(liveState.rows.map((row) => row.id)).toEqual(["id:x3.ts"]);
    await chunker.release("x2.ts");
    expect((await background).pending).toEqual([]);
    expect(chunker.started).toEqual(["x1.ts", "x3.ts", "x2.ts"]);
  });

  it("should chunk each path once when two warms overlap", async () => {
    for (const path of ["a.ts", "b.ts", "c.ts", "d.ts"]) write(path, `export const v = "${path}";\n`);
    const layer = layerOver(async (_pool, file) => rowOf(file));
    const chunk = vi.spyOn(layer, "chunk");
    const warmer = warmerOver(layer);

    const [first, second] = await Promise.all([
      warmer.warm(request(["a.ts", "b.ts", "c.ts"]), 5_000, "live"),
      warmer.warm(request(["b.ts", "c.ts", "d.ts"]), 5_000, "live"),
    ]);

    expect(first.pending).toEqual([]);
    expect(second.pending).toEqual([]);
    expect(second.rows.map((row) => row.id)).toEqual(["id:b.ts", "id:c.ts", "id:d.ts"]);
    expect(chunk.mock.calls.flatMap(([, paths]) => paths).sort()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts"]);
  });

  it("should chunk nothing in a fresh process over the same store and answer warm well inside the budget", async () => {
    const paths = ["a.ts", "b.ts", "src/c.ts"];
    for (const path of paths) write(path, `export const v = "${path}";\n`);
    const storeDir = join(tempDir, "working-tree");
    const firstChunkFile = vi.fn(async (_pool: unknown, file: { relativePath: string; code: string }) => rowOf(file));
    const first = await warmerOver(layerOver(firstChunkFile, storeDir)).warm(request(paths), 5_000, "live");
    expect(first.pending).toEqual([]);

    const secondChunkFile = vi.fn(async (_pool: unknown, file: { relativePath: string; code: string }) => rowOf(file));
    const startedAt = Date.now();
    const second = await warmerOver(layerOver(secondChunkFile, storeDir)).warm(request(paths), 5_000, "live");

    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(secondChunkFile).not.toHaveBeenCalled();
    expect(second.pending).toEqual([]);
    expect(second.rows).toEqual(first.rows);
    expect([...second.storeKeys.entries()]).toEqual([...first.storeKeys.entries()]);
  });

  it("should serve a remembered result without asking the layer while the file is unchanged", async () => {
    write("a.ts", "export const a = 1;\n");
    const layer = layerOver(async (_pool, file) => rowOf(file));
    const chunk = vi.spyOn(layer, "chunk");
    const warmer = warmerOver(layer, { now: AFTER_THE_FACT });

    await warmer.warm(request(["a.ts"]), 5_000, "live");
    const again = await warmer.warm(request(["a.ts"]), 5_000, "live");

    expect(again.rows.map((row) => row.payload.content)).toEqual(["export const a = 1;\n"]);
    expect(chunk).toHaveBeenCalledTimes(1);
  });

  it("should serve an edited file's new content, never the result warmed before the edit", async () => {
    write("a.ts", "export const a = 1;\n");
    const warmer = warmerOver(layerOver(async (_pool, file) => rowOf(file)));

    const before = await warmer.warm(request(["a.ts"]), 5_000, "live");
    write("a.ts", "export const a = 2;\n"); // same size, likely the same mtime tick
    const after = await warmer.warm(request(["a.ts"]), 5_000, "live");

    expect(before.rows.map((row) => row.payload.content)).toEqual(["export const a = 1;\n"]);
    expect(after.rows.map((row) => row.payload.content)).toEqual(["export const a = 2;\n"]);
  });

  it("should not answer a request with a read that began before it — an edit mid-batch is re-read", async () => {
    write("a.ts", "export const a = 1;\n");
    const chunker = gatedChunker();
    const warmer = warmerOver(layerOver(chunker.chunkFile));

    const early = warmer.warm(request(["a.ts"]), 10_000, "background");
    while (chunker.started.length === 0) await settle(); // the layer has read version 1
    write("a.ts", "export const a = 2;\n");
    const late = warmer.warm(request(["a.ts"]), 10_000, "live");
    await chunker.release("a.ts");
    await chunker.release("a.ts");

    expect((await early).rows.map((row) => row.payload.content)).toEqual(["export const a = 1;\n"]);
    expect((await late).rows.map((row) => row.payload.content)).toEqual(["export const a = 2;\n"]);
    expect(chunker.started).toEqual(["a.ts", "a.ts"]);
  });

  it("should re-ask the layer for a remembered file whose stat changed", async () => {
    write("a.ts", "export const a = 1;\n");
    const warmer = warmerOver(
      layerOver(async (_pool, file) => rowOf(file)),
      { now: AFTER_THE_FACT },
    );

    await warmer.warm(request(["a.ts"]), 5_000, "live");
    write("a.ts", "export const a = 22;\n");
    const after = await warmer.warm(request(["a.ts"]), 5_000, "live");

    expect(after.rows.map((row) => row.payload.content)).toEqual(["export const a = 22;\n"]);
  });

  it("should count an unparsed file as warm with no rows", async () => {
    write("good.ts", "export const good = 1;\n");
    write("bad.ts", "BROKEN\n");
    const warmer = warmerOver(
      layerOver(async (_pool, file) => {
        if (file.code.includes("BROKEN")) throw new Error("parse failed");
        return rowOf(file);
      }),
    );

    const state = await warmer.warm(request(["good.ts", "bad.ts", "missing.ts"]), 5_000, "live");

    expect([...state.warmPaths]).toEqual(["good.ts", "bad.ts", "missing.ts"]);
    expect(state.unparsed).toEqual(["bad.ts", "missing.ts"]);
    expect(state.pending).toEqual([]);
    expect(state.rows.map((row) => row.id)).toEqual(["id:good.ts"]);
  });

  it("should leave paths pending when the layer fails, without waiting out the budget, and recover next time", async () => {
    write("a.ts", "export const a = 1;\n");
    const layer = layerOver(async (_pool, file) => rowOf(file));
    vi.spyOn(layer, "chunk").mockRejectedValueOnce(new Error("pool died"));
    const warmer = warmerOver(layer);

    const startedAt = Date.now();
    const failed = await warmer.warm(request(["a.ts"]), 10_000, "live");
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(failed.pending).toEqual(["a.ts"]);
    expect(failed.warmPaths.size).toBe(0);

    const recovered = await warmer.warm(request(["a.ts"]), 5_000, "live");
    expect(recovered.pending).toEqual([]);
    expect(recovered.rows.map((row) => row.id)).toEqual(["id:a.ts"]);
  });

  it("should stop background work on dispose and answer waiting requests", async () => {
    for (const path of ["x1.ts", "x2.ts"]) write(path, `export const v = "${path}";\n`);
    const chunker = gatedChunker();
    const warmer = warmerOver(layerOver(chunker.chunkFile), { batchSize: 1 });

    const waiting = warmer.warm(request(["x1.ts", "x2.ts"]), 60_000, "background");
    while (chunker.started.length === 0) await settle();
    warmer.dispose();

    expect((await waiting).pending).toEqual(["x1.ts", "x2.ts"]);
    await chunker.release("x1.ts");
    for (let i = 0; i < 10; i++) await settle();
    expect(chunker.started).toEqual(["x1.ts"]);
  });

  it("should resolve within the budget when nothing ever warms", async () => {
    write("a.ts", "export const a = 1;\n");
    const chunker = gatedChunker();
    const warmer = warmerOver(layerOver(chunker.chunkFile));

    const state = await warmer.warm(request(["a.ts"]), 50, "live");

    expect(state.pending).toEqual(["a.ts"]);
    expect(state.rows).toEqual([]);
    await chunker.release("a.ts");
  });
});
