/**
 * Dense vectors beside the stored rows (bd tea-rags-mcp-xi2r9, WTO-5): a
 * restarted server does not re-embed a tree's delta chunks it has embedded
 * before. Vectors live in the entry of the file whose rows they belong to,
 * keyed by the chunk content's sha256 and the embedding model, and share that
 * entry's retention: evicted with it, counted in its bytes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../../../__helpers__/git-working-tree-fixture.js";
import {
  computeGitBlobId,
  createWorkingTreeChunkLayer,
  createWorkingTreeChunkStore,
  type WorkingTreeChunkStore,
  type WorkingTreeChunkStoreEntry,
} from "../../../../../src/core/domains/explore/working-tree/index.js";

const HOUR = 3_600_000;
const COLLECTION = "code_store";
const MODEL = "nomic-embed-text:768";

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

describe("WorkingTreeChunkStore dense vectors", { timeout: 60_000 }, () => {
  let fixture: GitWorkingTreeFixture;
  let tree: string;
  let scratch: string;
  let rootDir: string;
  let clock: number;

  const write = (relativePath: string, content: string): void => {
    const target = join(tree, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };

  const storeAt = (capBytes?: number): WorkingTreeChunkStore =>
    createWorkingTreeChunkStore({ rootDir, now: () => clock, ...(capBytes === undefined ? {} : { capBytes }) });

  const entryFor = (relativePath: string, content: string): Omit<WorkingTreeChunkStoreEntry, "lastReadAt"> => ({
    treeRoot: tree,
    relativePath,
    contentSha256: sha256(content),
    chunkerFingerprint: "chunker-a",
    blobId: computeGitBlobId(Buffer.from(content)),
    rows: [{ id: `id:${relativePath}`, payload: { relativePath, content } }],
  });

  const keyOf = (entry: Omit<WorkingTreeChunkStoreEntry, "lastReadAt">) => ({
    treeRoot: entry.treeRoot,
    relativePath: entry.relativePath,
    contentSha256: entry.contentSha256,
    chunkerFingerprint: entry.chunkerFingerprint,
  });

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture();
    tree = fixture.addWorktree("feature");
    scratch = mkdtempSync(join(tmpdir(), "wt-chunk-vectors-"));
    rootDir = join(scratch, "working-tree");
    clock = Date.UTC(2026, 9, 2);
  });

  afterEach(() => {
    fixture.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("round-trips vectors by chunk content hash, for the model that made them only", async () => {
    const store = storeAt();
    const entry = entryFor("src/a.ts", "export const a = 1;\n");
    await store.put(COLLECTION, entry);

    await store.putVectors(COLLECTION, keyOf(entry), MODEL, new Map([["h1", [0.1, 0.2]]]));

    expect(await storeAt().getVectors(COLLECTION, keyOf(entry), MODEL)).toEqual(new Map([["h1", [0.1, 0.2]]]));
    expect(await store.getVectors(COLLECTION, keyOf(entry), "other-model:768")).toBeUndefined();
    expect(await store.getVectors(COLLECTION, { ...keyOf(entry), chunkerFingerprint: "chunker-b" }, MODEL)).toBe(
      undefined,
    );
  });

  it("merges later vectors of the same model into the entry's", async () => {
    const store = storeAt();
    const entry = entryFor("src/a.ts", "export const a = 1;\n");
    await store.put(COLLECTION, entry);

    await store.putVectors(COLLECTION, keyOf(entry), MODEL, new Map([["h1", [1, 0]]]));
    await store.putVectors(COLLECTION, keyOf(entry), MODEL, new Map([["h2", [0, 1]]]));

    expect(await store.getVectors(COLLECTION, keyOf(entry), MODEL)).toEqual(
      new Map([
        ["h1", [1, 0]],
        ["h2", [0, 1]],
      ]),
    );
  });

  it("replaces another model's vectors instead of mixing them", async () => {
    const store = storeAt();
    const entry = entryFor("src/a.ts", "export const a = 1;\n");
    await store.put(COLLECTION, entry);

    await store.putVectors(COLLECTION, keyOf(entry), "old-model:768", new Map([["h1", [1, 0]]]));
    await store.putVectors(COLLECTION, keyOf(entry), MODEL, new Map([["h2", [0, 1]]]));

    expect(await store.getVectors(COLLECTION, keyOf(entry), MODEL)).toEqual(new Map([["h2", [0, 1]]]));
    expect(await store.getVectors(COLLECTION, keyOf(entry), "old-model:768")).toBeUndefined();
  });

  it("stores no vectors for an entry the store does not hold", async () => {
    const store = storeAt();
    const entry = entryFor("src/a.ts", "export const a = 1;\n");

    await store.putVectors(COLLECTION, keyOf(entry), MODEL, new Map([["h1", [1, 0]]]));

    expect(await store.getVectors(COLLECTION, keyOf(entry), MODEL)).toBeUndefined();
    expect(existsSync(rootDir)).toBe(false);
  });

  it("evicts the vectors with their entry", async () => {
    const store = storeAt();
    write("src/a.ts", "export const a = 1;\n");
    const entry = entryFor("src/a.ts", "export const a = 1;\n");
    await store.put(COLLECTION, entry);
    await store.putVectors(COLLECTION, keyOf(entry), MODEL, new Map([["h1", [1, 0]]]));
    fixture.git(fixture.mainRoot, "worktree", "remove", "--force", tree);

    expect(await store.sweep(clock)).toMatchObject({ evicted: 1, kept: 0, bytes: 0 });
    expect(readdirSync(join(rootDir), { recursive: true }).filter((f) => String(f).endsWith(".json"))).toEqual([]);
  });

  it("counts the vectors in the entry's bytes", async () => {
    write("src/a.ts", "export const a = 1;\n");
    const store = storeAt();
    const entry = entryFor("src/a.ts", "export const a = 1;\n");
    await store.put(COLLECTION, entry);
    const without = (await store.sweep(clock)).bytes;

    await store.putVectors(COLLECTION, keyOf(entry), MODEL, new Map([["h1", Array.from({ length: 64 }, () => 0.5)]]));

    expect((await store.sweep(clock)).bytes).toBeGreaterThan(without + 64);
  });

  it("removes a vectors file whose entry is gone once it is an hour old", async () => {
    const dir = join(rootDir, COLLECTION);
    mkdirSync(dir, { recursive: true });
    const orphan = join(dir, "deadbeef.vectors.json");
    writeFileSync(orphan, JSON.stringify({ model: MODEL, vectors: {} }));
    const old = (clock - 2 * HOUR) / 1000;
    utimesSync(orphan, old, old);

    await storeAt().sweep(clock);

    expect(existsSync(orphan)).toBe(false);
  });

  it("names the store entry of every file a layer read, on a chunk and on a memory hit alike", async () => {
    write("src/a.ts", "export const a = 1;\n");
    const store = storeAt();
    const chunkFile = vi.fn(async (_pool: unknown, file: { relativePath: string }) => [
      { id: `id:${file.relativePath}`, payload: { relativePath: file.relativePath, content: "x" } },
    ]);
    const layer = createWorkingTreeChunkLayer({
      createPool: () => ({ shutdown: async () => undefined }),
      chunkFile,
      store,
    });
    const config = { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 2500 };

    const first = await layer.chunk(tree, ["src/a.ts"], config, COLLECTION);
    const key = first.storeKeys?.get("src/a.ts");
    expect(key).toBeDefined();
    if (!key) return;
    await store.putVectors(COLLECTION, key, MODEL, new Map([["h1", [1, 0]]]));
    const second = await layer.chunk(tree, ["src/a.ts"], config, COLLECTION);

    expect(chunkFile).toHaveBeenCalledTimes(1);
    expect(second.storeKeys?.get("src/a.ts")).toEqual(key);
    expect(await store.getVectors(COLLECTION, key, MODEL)).toEqual(new Map([["h1", [1, 0]]]));
    await layer.dispose();
  });
});
