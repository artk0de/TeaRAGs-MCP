import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ParallelFileSynchronizer } from "../../../../../../src/core/domains/ingest/sync/parallel-synchronizer.js";
import { FileStoreGate } from "../../../../../../src/core/domains/ingest/sync/resume/file-store-gate.js";
import {
  checkpointFromStoredPaths,
  FIRST_INDEX_RESUME_KIND,
  FIRST_INDEX_RESUME_VERSION,
  firstIndexResumeDirectory,
  FirstIndexResumeStore,
  planResumeFiles,
  selectFirstIndexResume,
  type FirstIndexGeneration,
} from "../../../../../../src/core/domains/ingest/sync/resume/first-index-resume.js";
import type { FileMetadata } from "../../../../../../src/core/domains/ingest/sync/snapshot/sharded-snapshot.js";

const NOW = Date.parse("2026-10-30T12:00:00.000Z");
const STALE_AT = "2026-10-24T00:00:00.000Z";
const LIVE_AT = "2026-10-30T11:59:00.000Z";

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(async (dir) => rm(dir, { recursive: true, force: true })));
});

function meta(hash: string, mtime = 1_000, size = 10): FileMetadata {
  return { mtime, size, hash };
}

function generation(version: number, overrides: Partial<FirstIndexGeneration> = {}): FirstIndexGeneration {
  return {
    physical: `code_a1b2c3d4_v${version}`,
    version,
    marker: { indexingComplete: false, startedAt: STALE_AT, lastHeartbeat: STALE_AT },
    hasCheckpoint: false,
    ...overrides,
  };
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

describe("selectFirstIndexResume", () => {
  it("reuses the newest stale generation when none has a checkpoint", () => {
    const selected = selectFirstIndexResume([generation(1), generation(2), generation(3), generation(4)], NOW);
    expect(selected).toEqual({ physical: "code_a1b2c3d4_v4", version: 4 });
  });

  it("returns undefined when a generation is live", () => {
    const selected = selectFirstIndexResume(
      [generation(2), generation(4, { marker: { indexingComplete: false, lastHeartbeat: LIVE_AT } })],
      NOW,
    );
    expect(selected).toBeUndefined();
  });

  it("returns undefined when two generations have checkpoints", () => {
    const selected = selectFirstIndexResume(
      [generation(2, { hasCheckpoint: true }), generation(4, { hasCheckpoint: true })],
      NOW,
    );
    expect(selected).toBeUndefined();
  });

  it("keeps the single checkpoint instead of a newer generation without one", () => {
    const selected = selectFirstIndexResume([generation(2, { hasCheckpoint: true }), generation(4)], NOW);
    expect(selected).toEqual({ physical: "code_a1b2c3d4_v2", version: 2 });
  });

  it("skips a complete marker and treats a missing marker as stale and incomplete", () => {
    const selected = selectFirstIndexResume(
      [
        generation(4, { marker: { indexingComplete: true, lastHeartbeat: LIVE_AT } }),
        generation(3, { marker: null }),
        generation(1),
      ],
      NOW,
    );
    expect(selected).toEqual({ physical: "code_a1b2c3d4_v3", version: 3 });
  });
});

describe("planResumeFiles", () => {
  const done = new Map<string, FileMetadata>([
    ["keep.ts", meta("aaa", 10_000, 3)],
    ["clock.ts", meta("old", 10_000, 3)],
    ["edit.ts", meta("bbb", 1_000, 10)],
    ["gone.ts", meta("ccc")],
  ]);
  const current = new Map<string, FileMetadata>([
    ["keep.ts", meta("aaa", 10_000, 3)],
    ["clock.ts", meta("new", 10_500, 3)],
    ["edit.ts", meta("zzz", 5_000, 10)],
    ["new.ts", meta("ddd", 5_000, 4)],
    ["partial.ts", meta("eee", 5_000, 4)],
  ]);
  const diskPaths = ["keep.ts", "clock.ts", "edit.ts", "new.ts", "partial.ts"];

  it("skips unchanged, rewrites hash changes, ingests missing, and removes checkpoint-only paths", () => {
    const plan = planResumeFiles({ diskPaths, done, current });
    expect(plan.unchanged).toEqual(["keep.ts", "clock.ts"]);
    expect(plan.rewrite).toEqual(["edit.ts"]);
    expect(plan.ingest).toEqual(["new.ts", "partial.ts"]);
    expect(plan.removed).toEqual(["gone.ts"]);
  });

  it("omits unchanged and ingest paths absent from a provided stored set", () => {
    const plan = planResumeFiles({
      diskPaths,
      done,
      current,
      storedPaths: new Set(["partial.ts"]),
    });
    expect(plan.pathsToDelete).toEqual(["edit.ts", "gone.ts", "partial.ts"]);
    expect(plan.pathsToDelete).not.toContain("keep.ts");
    expect(plan.pathsToDelete).not.toContain("clock.ts");
    expect(plan.pathsToDelete).not.toContain("new.ts");
  });

  it("includes every ingest path when the stored set is omitted", () => {
    const plan = planResumeFiles({ diskPaths, done, current });
    expect(plan.pathsToDelete).toEqual(["edit.ts", "gone.ts", "new.ts", "partial.ts"]);
    expect(plan.pathsToDelete).not.toContain("keep.ts");
  });
});

describe("checkpointFromStoredPaths", () => {
  it("keeps stored paths that still hash and lists the rest as missing", () => {
    const derived = checkpointFromStoredPaths(
      ["kept.ts", "kept.ts", "gone.ts", "empty.ts"],
      new Map([
        ["kept.ts", meta("abc")],
        ["empty.ts", { mtime: 1, size: 1, hash: "" }],
      ]),
    );
    expect([...derived.done.keys()]).toEqual(["kept.ts"]);
    expect(derived.done.get("kept.ts")?.hash).toBe("abc");
    expect(derived.missingFromDisk).toEqual(["gone.ts", "empty.ts"]);
  });
});

describe("FirstIndexResumeStore", () => {
  it("round-trips a checkpoint next to the snapshot directory, never inside it", async () => {
    const snapshotDir = await tempDir("resume-roundtrip-");
    const alias = "code_a1b2c3d4";
    const physical = "code_a1b2c3d4_v4";
    const store = new FirstIndexResumeStore(snapshotDir, alias, physical);
    const files = new Map<string, FileMetadata>([
      ["src/b.ts", meta("bbb", 20, 4)],
      ["src/a.ts", meta("aaa", 10, 2)],
    ]);

    await store.save(files);

    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect(Object.fromEntries(loaded ?? [])).toEqual({
      "src/a.ts": meta("aaa", 10, 2),
      "src/b.ts": meta("bbb", 20, 4),
    });
    await expect(readFile(join(snapshotDir, alias, "meta.json"), "utf8")).rejects.toThrow();
    const metaPath = join(firstIndexResumeDirectory(snapshotDir, alias, physical), "meta.json");
    const raw = JSON.parse(await readFile(metaPath, "utf8")) as { kind: string; version: number; batches: unknown[] };
    expect(raw.kind).toBe(FIRST_INDEX_RESUME_KIND);
    expect(raw.version).toBe(FIRST_INDEX_RESUME_VERSION);
    expect(raw.batches).toHaveLength(1);
  });

  it("loads foreign meta as null", async () => {
    const snapshotDir = await tempDir("resume-foreign-");
    const cases: { physical: string; meta: unknown }[] = [
      { physical: "code_a1b2c3d4_v1", meta: { kind: "snapshot", version: 1, batches: [] } },
      {
        physical: "code_a1b2c3d4_v2",
        meta: { kind: FIRST_INDEX_RESUME_KIND, version: 2, batches: [] },
      },
      {
        physical: "code_a1b2c3d4_v3",
        meta: {
          version: "3",
          codebasePath: "/path/to/repo",
          timestamp: 1,
          aliasVersion: 2,
          shards: [],
          metaRootHash: "abc",
        },
      },
    ];

    for (const entry of cases) {
      const dir = firstIndexResumeDirectory(snapshotDir, "code_a1b2c3d4", entry.physical);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "meta.json"), JSON.stringify(entry.meta));
      await writeFile(join(dir, "batch-0001.json"), JSON.stringify({ files: { "should-not-load.ts": meta("nope") } }));
      const loaded = await new FirstIndexResumeStore(snapshotDir, "code_a1b2c3d4", entry.physical).load();
      expect(loaded).toBeNull();
    }
  });

  it("drops only the batch whose checksum does not match", async () => {
    const snapshotDir = await tempDir("resume-checksum-");
    const store = new FirstIndexResumeStore(snapshotDir, "code_a1b2c3d4", "code_a1b2c3d4_v4");
    await store.save(new Map([["a.ts", meta("aaa")]]));
    await store.save(new Map([["b.ts", meta("bbb")]]));
    const batch = join(firstIndexResumeDirectory(snapshotDir, "code_a1b2c3d4", "code_a1b2c3d4_v4"), "batch-0001.json");
    await writeFile(batch, `${await readFile(batch, "utf8")} `);

    const loaded = await store.load();
    expect(loaded).not.toBeNull();
    expect([...(loaded ?? new Map()).keys()]).toEqual(["b.ts"]);
  });
});

describe("FileStoreGate", () => {
  const metadata = new Map<string, FileMetadata>([
    ["partial.ts", meta("p")],
    ["never.ts", meta("n")],
    ["empty.ts", meta("e", 1, 0)],
  ]);

  it("does not persist a file until stored count reaches submitted count, and a file never submitted is absent", async () => {
    const saved: string[] = [];
    const gate = new FileStoreGate(
      {
        save: async (files) => {
          saved.push(...files.keys());
        },
      },
      metadata,
    );

    gate.onChunksStored(["never.ts", "never.ts"]);
    gate.onFileSubmitted("partial.ts", 2);
    gate.onChunksStored(["partial.ts"]);
    await gate.settled();
    expect(saved).toEqual([]);

    gate.onChunksStored(["partial.ts"]);
    await gate.settled();
    expect(saved).toEqual(["partial.ts"]);

    gate.onFileSubmitted("empty.ts", 0);
    gate.onFileSubmitted("nometa.ts", 0);
    await gate.settled();
    expect(saved).toEqual(["partial.ts", "empty.ts"]);
    expect(saved).not.toContain("never.ts");
    expect(saved).not.toContain("nometa.ts");
  });

  it("serializes checkpoint saves", async () => {
    const started: string[] = [];
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const gate = new FileStoreGate(
      {
        save: async (files) => {
          calls += 1;
          started.push(...files.keys());
          if (calls === 1) await blocked;
        },
      },
      new Map([
        ["a.ts", meta("a")],
        ["b.ts", meta("b")],
      ]),
    );

    gate.onFileSubmitted("a.ts", 0);
    gate.onFileSubmitted("b.ts", 0);
    await Promise.resolve();
    expect(started).toEqual(["a.ts"]);
    release();
    await gate.settled();
    expect(started).toEqual(["a.ts", "b.ts"]);
  });
});

describe("ParallelFileSynchronizer.getCachedFileMetadata", () => {
  it("returns a copy of the metadata computeContentHashes stored", async () => {
    const root = await tempDir("resume-hash-");
    await writeFile(join(root, "a.ts"), "export const a = 1;\n");
    const synchronizer = new ParallelFileSynchronizer(root, "code_test", join(root, "snaps"), 1);

    expect(synchronizer.getCachedFileMetadata().size).toBe(0);
    const hashes = await synchronizer.computeContentHashes([join(root, "a.ts")]);
    const cached = synchronizer.getCachedFileMetadata();
    expect(cached.get("a.ts")?.hash).toBe(hashes.get("a.ts"));
    cached.clear();
    expect(synchronizer.getCachedFileMetadata().get("a.ts")?.hash).toBe(hashes.get("a.ts"));
  });
});
