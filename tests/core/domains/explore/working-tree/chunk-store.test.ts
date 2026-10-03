/**
 * `WorkingTreeChunkStore` (bd tea-rags-mcp-xi2r9.3): the delta-chunk cache that
 * outlives the process, and its retention — a removed tree is evicted at once,
 * committed content ages out 96 h after max(commit, last read), uncommitted
 * content of a live tree stays, and the store is held under its byte cap by
 * evicting the least recently read. Commit detection drives real git.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as realDelay } from "node:timers/promises";

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
  WORKING_TREE_CHUNK_SWEEP_INTERVAL_MS,
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

  describe("content the tree no longer holds", () => {
    it("should evict an uncommitted superseded content of a path once it is unread 96 h, and keep it before", async () => {
      const store = storeAt();
      write("src/a.ts", "export const a = 1; // draft 1\n");
      const draft = entryFor("src/a.ts", "export const a = 1; // draft 1\n");
      await store.put(COLLECTION, draft);
      write("src/a.ts", "export const a = 2; // draft 2\n");
      const current = entryFor("src/a.ts", "export const a = 2; // draft 2\n");
      await store.put(COLLECTION, current);

      expect(await store.sweep(clock + 95 * HOUR)).toMatchObject({ evicted: 0, kept: 2 });
      expect(await store.sweep(clock + 96 * HOUR)).toMatchObject({ evicted: 1, kept: 1 });
      expect(await store.get(COLLECTION, keyOf(draft))).toBeUndefined();
      expect(await store.get(COLLECTION, keyOf(current))).toBeDefined();
    });

    it("should evict the content of a path the tree deleted once it is unread 96 h", async () => {
      const store = storeAt();
      write("src/gone.ts", "export const gone = 1;\n");
      const entry = entryFor("src/gone.ts", "export const gone = 1;\n");
      await store.put(COLLECTION, entry);
      rmSync(join(tree, "src/gone.ts"));

      expect(await store.sweep(clock + 95 * HOUR)).toMatchObject({ evicted: 0, kept: 1 });
      expect(await store.sweep(clock + 97 * HOUR)).toMatchObject({ evicted: 1, kept: 0 });
    });

    it("should measure a superseded entry's 96 h from its last read", async () => {
      const store = storeAt();
      write("src/a.ts", "export const a = 1;\n");
      const entry = entryFor("src/a.ts", "export const a = 1;\n");
      await store.put(COLLECTION, entry);
      write("src/a.ts", "export const a = 2;\n");
      clock += 50 * HOUR;
      await store.get(COLLECTION, keyOf(entry));

      expect(await store.sweep(clock + 95 * HOUR)).toMatchObject({ evicted: 0, kept: 1 });
      expect(await store.sweep(clock + 96 * HOUR)).toMatchObject({ evicted: 1, kept: 0 });
    });

    it("should evict current content stored by a superseded chunker once a newer build's entry has been read 96 h since", async () => {
      const store = storeAt();
      write("src/a.ts", "export const a = 1;\n");
      const old = { ...entryFor("src/a.ts", "export const a = 1;\n"), chunkerFingerprint: "chunker-old" };
      await store.put(COLLECTION, old);
      clock += 10 * HOUR;
      const fresh = { ...entryFor("src/a.ts", "export const a = 1;\n"), chunkerFingerprint: "chunker-new" };
      await store.put(COLLECTION, fresh);

      expect(await store.sweep(clock + 85 * HOUR)).toMatchObject({ evicted: 0, kept: 2 });
      expect(await store.sweep(clock + 87 * HOUR)).toMatchObject({ evicted: 1, kept: 1 });
      expect(await store.get(COLLECTION, keyOf(fresh))).toBeDefined();
    });

    it("should keep current uncommitted content however long it sits unread", async () => {
      const store = storeAt();
      write("src/a.ts", "export const a = 1; // current, never committed\n");
      await store.put(COLLECTION, entryFor("src/a.ts", "export const a = 1; // current, never committed\n"));

      expect(await store.sweep(clock + 10_000 * HOUR)).toMatchObject({ evicted: 0, kept: 1 });
    });
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

  // bd tea-rags-mcp-xi2r9, B1: a one-shot process that exits mid-write strands
  // its temp. The temp names its writer's pid, so the next sweep removes it at
  // once instead of after the hour's grace.
  it("should remove a temp whose writer exited mid-write, beside the entries and beside the stamp", async () => {
    const store = storeAt();
    const entry = entryFor("src/a.ts", "export const a = 1;\n");
    await store.put(COLLECTION, entry);
    const collectionDir = join(rootDir, COLLECTION);
    const [meta] = readdirSync(collectionDir).filter((name) => name.endsWith(".meta.json"));
    const strand = (path: string): void => {
      const child = spawnSync(process.execPath, [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(path)} + "." + process.pid + ".0badf00d.tmp", ""); process.exit(0);`,
      ]);
      expect(child.status).toBe(0);
    };
    strand(join(collectionDir, meta));
    strand(join(rootDir, ".sweep-stamp.json"));

    await store.sweep(clock);

    expect(readdirSync(collectionDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(rootDir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    expect(await store.get(COLLECTION, keyOf(entry))).toBeDefined();
  });

  it("should refuse a collection name that would leave the root", async () => {
    const store = storeAt();
    const entry = entryFor("src/a.ts", "export const a = 1;\n");

    await store.put("../escape", entry);

    expect(readdirSync(scratch)).not.toContain("escape");
    expect(await store.get("../escape", keyOf(entry))).toBeUndefined();
  });

  // Invariant change (bd tea-rags-mcp-xi2r9, live: 580 sequential `git log --find-object`
  // on a cold CLI call): the schedule no longer sweeps at start. Its first sweep
  // waits `initialDelayMs`, so a one-shot process never pays it, every run goes
  // through the cross-process throttle stamp, and stopping aborts a sweep in flight.
  it("should first sweep after its initial delay, then on every interval until stopped, without holding the process open", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
    const signals: AbortSignal[] = [];
    const sweepIfDue = vi.fn(async (_at?: number, options?: { signal?: AbortSignal }) => {
      if (options?.signal) signals.push(options.signal);
      return undefined;
    });

    const stop = scheduleWorkingTreeChunkSweep({ sweepIfDue }, { initialDelayMs: 2 * 60_000, intervalMs: 6 * HOUR });
    expect(sweepIfDue).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(sweepIfDue).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * HOUR);
    expect(sweepIfDue).toHaveBeenCalledTimes(2);

    stop();
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(12 * HOUR);
    expect(sweepIfDue).toHaveBeenCalledTimes(2);
  });

  describe("retention cost", () => {
    const realLookup = () => vi.fn(readBlobCommitTime);
    const storeWith = (lookup: ReturnType<typeof realLookup>, extra: { commitLookupsPerSweep?: number } = {}) =>
      createWorkingTreeChunkStore({ rootDir, now: () => clock, readBlobCommitTime: lookup, ...extra });

    it("should answer reads of a store holding many entries with no retention lookup, before the scheduled sweep runs", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const lookup = realLookup();
      const store = storeWith(lookup);
      const entries = Array.from({ length: 12 }, (_, i) => {
        const content = `export const v${String(i)} = ${String(i)};\n`;
        write(`src/v${String(i)}.ts`, content);
        return entryFor(`src/v${String(i)}.ts`, content);
      });
      for (const entry of entries) await store.put(COLLECTION, entry);
      clock += 200 * HOUR; // every entry idle: a sweep would ask git about each

      const stop = scheduleWorkingTreeChunkSweep(store, { initialDelayMs: 2 * 60_000 });
      const reads = await Promise.all(entries.map(async (entry) => store.get(COLLECTION, keyOf(entry))));

      expect(reads.every((read) => read !== undefined)).toBe(true);
      // Real time passes (the process keeps serving) and nothing has asked git yet.
      await realDelay(300);
      expect(lookup).not.toHaveBeenCalled();

      clock += 200 * HOUR;
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      await vi.waitFor(() => {
        expect(lookup).toHaveBeenCalled();
      });
      stop();
    });

    it("should not ask git about an entry read within the retention window", async () => {
      const lookup = realLookup();
      const store = storeWith(lookup);
      write("src/a.ts", "export const a = 1;\n");
      await store.put(COLLECTION, entryFor("src/a.ts", "export const a = 1;\n"));

      expect(await store.sweep(clock + 95 * HOUR)).toMatchObject({ evicted: 0, kept: 1 });
      expect(lookup).not.toHaveBeenCalled();
    });

    it("should persist a resolved commit time with the entry and never ask git for it again", async () => {
      const content = "export const a = 1;\n";
      const committedAt = commitInTree("src/a.ts", content);
      clock = committedAt - 200 * HOUR; // stored long before the commit: idle at every sweep below
      const lookup = realLookup();
      await storeWith(lookup).put(COLLECTION, entryFor("src/a.ts", content));

      expect(await storeWith(lookup).sweep(committedAt + 10 * HOUR)).toMatchObject({ evicted: 0, kept: 1 });
      expect(lookup).toHaveBeenCalledTimes(1);
      // A later process (a fresh store over the same dir) reads the persisted time.
      expect(await storeWith(lookup).sweep(committedAt + 20 * HOUR)).toMatchObject({ evicted: 0, kept: 1 });
      expect(await storeWith(lookup).sweep(committedAt + 97 * HOUR)).toMatchObject({ evicted: 1, kept: 0 });
      expect(lookup).toHaveBeenCalledTimes(1);
    });

    it("should bound commit lookups per sweep and rotate through unresolved entries across sweeps", async () => {
      const lookup = realLookup();
      const store = storeWith(lookup, { commitLookupsPerSweep: 2 });
      for (const name of ["a", "b", "c", "d", "e"]) {
        write(`src/${name}.ts`, `export const ${name} = 1;\n`);
        await store.put(COLLECTION, entryFor(`src/${name}.ts`, `export const ${name} = 1;\n`));
      }
      const asked = (): string[] => lookup.mock.calls.map((call) => call[1]);

      await store.sweep(clock + 100 * HOUR);
      expect(lookup).toHaveBeenCalledTimes(2);
      await store.sweep(clock + 101 * HOUR);
      expect(lookup).toHaveBeenCalledTimes(4);
      await store.sweep(clock + 102 * HOUR);
      expect(lookup).toHaveBeenCalledTimes(6);

      expect(new Set(asked().slice(0, 4)).size).toBe(4);
      expect(new Set(asked())).toEqual(new Set(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts", "src/e.ts"]));
    });

    it("should decide entries of a removed tree or a deleted path without git", async () => {
      const lookup = realLookup();
      const store = storeWith(lookup);
      write("src/gone.ts", "export const gone = 1;\n");
      await store.put(COLLECTION, entryFor("src/gone.ts", "export const gone = 1;\n"));
      rmSync(join(tree, "src/gone.ts"));
      await store.put(COLLECTION, entryFor("src/x.ts", "export const x = 1;\n", join(scratch, "no-such-tree")));

      expect(await store.sweep(clock + 97 * HOUR)).toMatchObject({ evicted: 2, kept: 0 });
      expect(lookup).not.toHaveBeenCalled();
    });

    it("should sweep at most once per interval across store instances sharing a directory", async () => {
      const lookup = realLookup();
      write("src/a.ts", "export const a = 1;\n");
      await storeWith(lookup).put(COLLECTION, entryFor("src/a.ts", "export const a = 1;\n"));
      const at = clock + 100 * HOUR;

      expect(await storeWith(lookup).sweepIfDue(at)).toMatchObject({ kept: 1 });
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(await storeWith(lookup).sweepIfDue(at + HOUR)).toBeUndefined();
      expect(lookup).toHaveBeenCalledTimes(1);
      expect(await storeWith(lookup).sweepIfDue(at + WORKING_TREE_CHUNK_SWEEP_INTERVAL_MS)).toMatchObject({
        kept: 1,
      });
      expect(lookup).toHaveBeenCalledTimes(2);
    });

    it("should stop a sweep whose signal is aborted without evicting anything", async () => {
      const store = storeWith(realLookup());
      await store.put(COLLECTION, entryFor("src/x.ts", "export const x = 1;\n", join(scratch, "no-such-tree")));
      const controller = new AbortController();
      controller.abort();

      expect(await store.sweep(clock, { signal: controller.signal })).toMatchObject({ evicted: 0 });
      expect(await store.sweep(clock)).toMatchObject({ evicted: 1 });
    });
  });

  it("should not serve rows a layer of an earlier row format stored (pre-stored-id `chunk_` rows)", async () => {
    write("src/a.ts", "export const a = 1;\n");
    const store = storeAt();
    // The fingerprint every layer wrote before row ids became stored point ids.
    const legacyFingerprint = createHash("sha256")
      .update(`\0${JSON.stringify(CONFIG)}`)
      .digest("hex");
    await store.put(COLLECTION, {
      ...entryFor("src/a.ts", "export const a = 1;\n"),
      chunkerFingerprint: legacyFingerprint,
      rows: [{ id: "chunk_e61bd876bd62659c", payload: { relativePath: "src/a.ts" } }],
    });
    const chunkFile = vi.fn(
      async (): Promise<ScrollChunk[]> => [{ id: "20054299-0bf6-2a2a-065d-fde15c6f8718", payload: {} }],
    );
    const layer = createWorkingTreeChunkLayer({
      createPool: () => ({ shutdown: async () => undefined }),
      chunkFile,
      store,
    });

    const read = await layer.chunk(tree, ["src/a.ts"], CONFIG, COLLECTION);

    expect(chunkFile).toHaveBeenCalledTimes(1);
    expect(read.chunks.map((row) => row.id)).toEqual(["20054299-0bf6-2a2a-065d-fde15c6f8718"]);
    await layer.dispose();
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
