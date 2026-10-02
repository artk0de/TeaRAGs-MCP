/**
 * `WorkingTreeChunkStore` (bd tea-rags-mcp-xi2r9.3): the delta-chunk cache that
 * outlives the process, and its retention — a removed tree is evicted at once,
 * committed content ages out 96 h after max(commit, last read), uncommitted
 * content of a live tree stays, and the store is held under its byte cap by
 * evicting the least recently read. Commit detection drives real git.
 */
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createGitWorkingTreeFixture,
  type GitWorkingTreeFixture,
} from "../../../__helpers__/git-working-tree-fixture.js";
import { readBlobCommitTime } from "../../../../../src/core/adapters/vcs/git/git-cli/client.js";
import type { ScrollChunk } from "../../../../../src/core/domains/explore/chunk-grouping/types.js";
import {
  computeGitBlobId,
  createWorkingTreeChunkLayer,
  createWorkingTreeChunkStore,
  scheduleWorkingTreeChunkSweep,
  WORKING_TREE_CHUNK_RETENTION_MS,
  WORKING_TREE_CHUNK_STORE_CAP_BYTES,
  type WorkingTreeChunkStore,
  type WorkingTreeChunkStoreEntry,
} from "../../../../../src/core/domains/explore/working-tree/index.js";
import type { ChunkerConfig } from "../../../../../src/core/types.js";

const HOUR = 3_600_000;
const COLLECTION = "code_store";
const FINGERPRINT = "chunker-a";
const CONFIG: ChunkerConfig = { chunkSize: 2500, chunkOverlap: 300, maxChunkSize: 2500 };

const sha256 = (content: string): string => createHash("sha256").update(content).digest("hex");

describe("WorkingTreeChunkStore", { timeout: 60_000 }, () => {
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

  const entryFor = (
    relativePath: string,
    content: string,
    treeRoot: string = tree,
  ): Omit<WorkingTreeChunkStoreEntry, "lastReadAt"> => ({
    treeRoot,
    relativePath,
    contentSha256: sha256(content),
    chunkerFingerprint: FINGERPRINT,
    blobId: computeGitBlobId(Buffer.from(content)),
    rows: [{ id: `id:${relativePath}`, payload: { relativePath, content } }],
  });

  const keyOf = (entry: Omit<WorkingTreeChunkStoreEntry, "lastReadAt">) => ({
    treeRoot: entry.treeRoot,
    relativePath: entry.relativePath,
    contentSha256: entry.contentSha256,
    chunkerFingerprint: entry.chunkerFingerprint,
  });

  /** Commits `content` at `relativePath` in the tree; returns the commit time in epoch ms. */
  const commitInTree = (relativePath: string, content: string): number => {
    fixture.commit(tree, { [relativePath]: content });
    return Number(fixture.git(tree, "log", "-1", "--format=%ct").trim()) * 1000;
  };

  beforeEach(() => {
    fixture = createGitWorkingTreeFixture();
    tree = fixture.addWorktree("feature");
    scratch = mkdtempSync(join(tmpdir(), "wt-chunk-store-"));
    rootDir = join(scratch, "working-tree");
    clock = Date.UTC(2026, 9, 2);
  });

  afterEach(() => {
    vi.useRealTimers();
    fixture.cleanup();
    rmSync(scratch, { recursive: true, force: true });
  });

  describe("computeGitBlobId / readBlobCommitTime", () => {
    it("should compute the id git hash-object assigns to the same content", () => {
      write("src/a.ts", "export const a = 1;\n");

      expect(computeGitBlobId(Buffer.from("export const a = 1;\n"))).toBe(
        fixture.git(tree, "hash-object", "src/a.ts").trim(),
      );
    });

    it("should return the commit time of committed content and null for uncommitted content", async () => {
      const committedAt = commitInTree("src/a.ts", "export const a = 1;\n");
      write("src/a.ts", "export const a = 2;\n");

      expect(await readBlobCommitTime(tree, "src/a.ts", computeGitBlobId(Buffer.from("export const a = 1;\n")))).toBe(
        committedAt,
      );
      expect(
        await readBlobCommitTime(tree, "src/a.ts", computeGitBlobId(Buffer.from("export const a = 2;\n"))),
      ).toBeNull();
    });
  });

  it("should round-trip an entry through put and get", async () => {
    const store = storeAt();
    const entry = entryFor("src/a.ts", "export const a = 1;\n");

    await store.put(COLLECTION, entry);

    expect(await store.get(COLLECTION, keyOf(entry))).toEqual({ ...entry, lastReadAt: clock });
    expect(await store.get(COLLECTION, { ...keyOf(entry), chunkerFingerprint: "chunker-b" })).toBeUndefined();
    expect(await store.get(COLLECTION, { ...keyOf(entry), treeRoot: fixture.mainRoot })).toBeUndefined();
    expect(await store.get("code_other", keyOf(entry))).toBeUndefined();
  });

  it("should bump lastReadAt on get, durably", async () => {
    const entry = entryFor("src/a.ts", "export const a = 1;\n");
    await storeAt().put(COLLECTION, entry);

    clock += 5 * HOUR;
    expect((await storeAt().get(COLLECTION, keyOf(entry)))?.lastReadAt).toBe(clock);
    const readAt = clock;
    clock += HOUR;

    const files = readdirSync(join(rootDir, COLLECTION));
    const meta = files.find((file) => file.endsWith(".meta.json"));
    expect(meta).toBeDefined();
    expect(JSON.parse(readFileSync(join(rootDir, COLLECTION, meta ?? ""), "utf8")).lastReadAt).toBe(readAt);
  });

  it("should evict an entry whose tree was removed, regardless of age", async () => {
    const store = storeAt();
    write("src/a.ts", "export const a = 1;\n");
    const entry = entryFor("src/a.ts", "export const a = 1;\n");
    await store.put(COLLECTION, entry);
    fixture.git(fixture.mainRoot, "worktree", "remove", "--force", tree);

    expect(await store.sweep(clock)).toMatchObject({ evicted: 1, kept: 0, bytes: 0 });
    expect(await store.get(COLLECTION, keyOf(entry))).toBeUndefined();
  });

  it("should keep committed content idle 95 h and evict it at 97 h", async () => {
    const content = "export const a = 1;\n";
    const committedAt = commitInTree("src/a.ts", content);
    clock = committedAt;
    const store = storeAt();
    const entry = entryFor("src/a.ts", content);
    await store.put(COLLECTION, entry);

    expect(await store.sweep(committedAt + 95 * HOUR)).toMatchObject({ evicted: 0, kept: 1 });
    expect(await store.sweep(committedAt + 97 * HOUR)).toMatchObject({ evicted: 1, kept: 0 });
  });

  it("should measure the idle window from the later of commit time and last read", async () => {
    const content = "export const a = 1;\n";
    const committedAt = commitInTree("src/a.ts", content);
    clock = committedAt;
    const store = storeAt();
    const entry = entryFor("src/a.ts", content);
    await store.put(COLLECTION, entry);
    clock = committedAt + 90 * HOUR;
    await store.get(COLLECTION, keyOf(entry));

    expect(await store.sweep(committedAt + 185 * HOUR)).toMatchObject({ evicted: 0, kept: 1 });
    expect(await store.sweep(committedAt + 90 * HOUR + WORKING_TREE_CHUNK_RETENTION_MS)).toMatchObject({
      evicted: 1,
      kept: 0,
    });
  });

  it("should keep uncommitted content of a live tree however long it sits unread", async () => {
    write("src/a.ts", "export const a = 9;\n");
    const store = storeAt();
    await store.put(COLLECTION, entryFor("src/a.ts", "export const a = 9;\n"));

    const swept = await store.sweep(clock + 1000 * HOUR);

    expect(swept).toMatchObject({ evicted: 0, kept: 1 });
    expect(swept.bytes).toBeGreaterThan(0);
  });

  it("should evict the least recently read entries until the store fits its cap", async () => {
    const entries = ["a", "b", "c"].map((name) => entryFor(`src/${name}.ts`, `export const ${name} = 1;\n`));
    const probe = storeAt();
    await probe.put(COLLECTION, entries[0]);
    const oneEntryBytes = (await probe.sweep(clock)).bytes;
    rmSync(rootDir, { recursive: true, force: true });

    const store = storeAt(oneEntryBytes * 2 + 1);
    for (const entry of entries) {
      await store.put(COLLECTION, entry);
      clock += HOUR;
    }
    await store.get(COLLECTION, keyOf(entries[0]));

    const swept = await store.sweep(clock);

    expect(swept).toMatchObject({ evicted: 1, kept: 2 });
    expect(swept.bytes).toBeLessThanOrEqual(oneEntryBytes * 2 + 1);
    expect(await store.get(COLLECTION, keyOf(entries[1]))).toBeUndefined();
    expect(await store.get(COLLECTION, keyOf(entries[0]))).toBeDefined();
    expect(await store.get(COLLECTION, keyOf(entries[2]))).toBeDefined();
    expect(WORKING_TREE_CHUNK_STORE_CAP_BYTES).toBe(512 * 1024 * 1024);
  });

  it("should never touch anything outside its root", async () => {
    const sibling = join(scratch, "sibling");
    mkdirSync(join(sibling, COLLECTION), { recursive: true });
    writeFileSync(join(sibling, COLLECTION, "x.meta.json"), "{}");
    writeFileSync(join(scratch, "loose.json"), "{}");
    const before = [readdirSync(scratch).sort(), readdirSync(join(sibling, COLLECTION)).sort()];
    const store = storeAt(1);
    await store.put(COLLECTION, entryFor("src/a.ts", "export const a = 1;\n"));
    await store.put(COLLECTION, entryFor("src/gone.ts", "export const gone = 1;\n", join(scratch, "no-such-tree")));

    await store.sweep(clock + 10_000 * HOUR);

    expect([readdirSync(scratch).sort(), readdirSync(join(sibling, COLLECTION)).sort()]).toEqual([
      [...before[0], "working-tree"].sort(),
      before[1],
    ]);
  });

  it("should refuse a collection name that would leave the root", async () => {
    const store = storeAt();
    const entry = entryFor("src/a.ts", "export const a = 1;\n");

    await store.put("../escape", entry);

    expect(readdirSync(scratch)).not.toContain("escape");
    expect(await store.get("../escape", keyOf(entry))).toBeUndefined();
  });

  it("should sweep at start and on every interval until stopped, without holding the process open", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const sweep = vi.fn(async () => ({ evicted: 0, kept: 0, bytes: 0 }));

    const stop = scheduleWorkingTreeChunkSweep({ sweep }, 6 * HOUR);
    expect(sweep).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(sweep).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it("should serve a fresh layer from the store without re-chunking unchanged content", async () => {
    write("src/a.ts", "export const a = 1;\n");
    const chunkFile = vi.fn(
      async (_pool: unknown, file: { relativePath: string; code: string }): Promise<ScrollChunk[]> => [
        { id: `id:${file.relativePath}:${file.code.length}`, payload: { relativePath: file.relativePath } },
      ],
    );
    const layerOver = () =>
      createWorkingTreeChunkLayer({
        createPool: () => ({ shutdown: async () => undefined }),
        chunkFile,
        store: storeAt(),
      });

    const first = layerOver();
    const firstRead = await first.chunk(tree, ["src/a.ts"], CONFIG, COLLECTION);
    await first.dispose();
    const second = layerOver();
    const secondRead = await second.chunk(tree, ["src/a.ts"], CONFIG, COLLECTION);

    expect(chunkFile).toHaveBeenCalledTimes(1);
    expect(secondRead).toEqual(firstRead);

    write("src/a.ts", "export const a = 2; // edited\n");
    await second.chunk(tree, ["src/a.ts"], CONFIG, COLLECTION);
    expect(chunkFile).toHaveBeenCalledTimes(2);
    await second.dispose();
  });
});
