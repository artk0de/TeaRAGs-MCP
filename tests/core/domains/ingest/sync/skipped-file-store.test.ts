import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SkippedFileStore } from "../../../../../src/core/domains/ingest/sync/skipped-file-store.js";

describe("SkippedFileStore", () => {
  let snapshotDir: string;
  const collectionName = "test-collection";
  let store: SkippedFileStore;

  beforeEach(async () => {
    snapshotDir = join(tmpdir(), `skipped-file-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(join(snapshotDir, collectionName), { recursive: true });
    store = new SkippedFileStore(snapshotDir, collectionName);
  });

  afterEach(async () => {
    await fs.rm(snapshotDir, { recursive: true, force: true });
  });

  it("returns an empty map when the file is absent or corrupted", async () => {
    expect((await store.load()).size).toBe(0);
    await fs.writeFile(join(snapshotDir, `${collectionName}.skipped.json`), "{ nope", "utf-8");
    expect((await new SkippedFileStore(snapshotDir, collectionName).load()).size).toBe(0);
  });

  it("persists an entry as a SIBLING of the snapshot dir, keyed by relative path", async () => {
    await store.record("lib/seed.rb", "secretsGate", "abc123");

    const raw = JSON.parse(await fs.readFile(join(snapshotDir, `${collectionName}.skipped.json`), "utf-8")) as {
      files: Record<string, { reason: string; contentHash: string; recordedAt: string }>;
    };
    expect(raw.files["lib/seed.rb"]).toMatchObject({ reason: "secretsGate", contentHash: "abc123" });
    expect(typeof raw.files["lib/seed.rb"].recordedAt).toBe("string");
    // Nothing written inside the swapped snapshot directory.
    expect(await fs.readdir(join(snapshotDir, collectionName))).toEqual([]);
  });

  it("overwrites an entry when the same path is skipped again", async () => {
    await store.record("a.ts", "secretsGate", "h1");
    await store.record("a.ts", "emptyFile", "h2");

    const entry = (await new SkippedFileStore(snapshotDir, collectionName).load()).get("a.ts");
    expect(entry).toMatchObject({ reason: "emptyFile", contentHash: "h2" });
  });

  it("serializes concurrent records without losing an update", async () => {
    await Promise.all(Array.from({ length: 20 }, async (_, i) => store.record(`f${i}.ts`, "emptyFile", `h${i}`)));
    expect((await new SkippedFileStore(snapshotDir, collectionName).load()).size).toBe(20);
  });

  it("clear removes one path and leaves the rest", async () => {
    await store.record("a.ts", "secretsGate", "h1");
    await store.record("b.ts", "compiled", "h2");

    await store.clear("a.ts");
    await store.clear("never-skipped.ts");

    expect([...(await new SkippedFileStore(snapshotDir, collectionName).load()).keys()]).toEqual(["b.ts"]);
  });

  it("clearMany removes every listed path in one write", async () => {
    await store.record("a.ts", "secretsGate", "h1");
    await store.record("b.ts", "compiled", "h2");
    await store.record("c.ts", "emptyFile", "h3");

    await store.clearMany(["a.ts", "c.ts", "absent.ts"]);

    expect([...(await store.paths())]).toEqual(["b.ts"]);
  });

  it("clearAll drops the file", async () => {
    await store.record("a.ts", "secretsGate", "h1");
    await store.clearAll();

    expect((await new SkippedFileStore(snapshotDir, collectionName).load()).size).toBe(0);
    expect((await store.paths()).size).toBe(0);
  });

  it("cloneTo copies the file to the target collection and no-ops when absent", async () => {
    await new SkippedFileStore(snapshotDir, "empty-src").cloneTo("empty-dst");
    expect((await new SkippedFileStore(snapshotDir, "empty-dst").load()).size).toBe(0);

    await store.record("a.ts", "compiled", "h1");
    await store.cloneTo("clone-collection");

    const cloned = await new SkippedFileStore(snapshotDir, "clone-collection").load();
    expect(cloned.get("a.ts")).toMatchObject({ reason: "compiled", contentHash: "h1" });
  });

  it("paths() is the deterministic-skip set a snapshot-vs-points probe subtracts", async () => {
    await store.record("a.ts", "secretsGate", "h1");
    await store.record("b.ts", "emptyFile", "h2");

    const paths = await new SkippedFileStore(snapshotDir, collectionName).paths();

    expect(paths).toEqual(new Set(["a.ts", "b.ts"]));
  });

  describe("summarize", () => {
    it("is undefined when nothing is skipped", async () => {
      expect(await store.summarize()).toBeUndefined();
    });

    it("counts by reason and carries no sample unless one is asked for", async () => {
      await store.record("a.ts", "secretsGate", "h1");
      await store.record("b.ts", "secretsGate", "h2");
      await store.record("c.ts", "emptyFile", "h3");

      expect(await store.summarize()).toEqual({ count: 3, byReason: { secretsGate: 2, emptyFile: 1 } });
    });

    it("caps the sample at the requested size, ordered by path", async () => {
      for (const name of ["d.ts", "b.ts", "c.ts", "a.ts"]) await store.record(name, "compiled", name);

      const summary = await store.summarize({ sampleLimit: 2 });

      expect(summary?.count).toBe(4);
      expect(summary?.sample).toEqual([
        { path: "a.ts", reason: "compiled" },
        { path: "b.ts", reason: "compiled" },
      ]);
    });
  });
  describe("runtime skips (bd tea-rags-mcp-muj77)", () => {
    it("records a runtimeError entry as retryable with the short error class", async () => {
      await store.recordRuntimeError("lib/slow.rb", "WorkerTimeoutError");

      const entry = (await new SkippedFileStore(snapshotDir, collectionName).load()).get("lib/slow.rb");
      expect(entry).toMatchObject({ reason: "runtimeError", errorClass: "WorkerTimeoutError", retryable: true });
    });

    it("paths() keeps deterministic skips only; retryablePaths() holds the runtime ones", async () => {
      await store.record("a.ts", "secretsGate", "h1");
      await store.recordRuntimeError("b.ts", "PipelineNotStartedError");

      const reread = new SkippedFileStore(snapshotDir, collectionName);
      expect(await reread.paths()).toEqual(new Set(["a.ts"]));
      expect(await reread.retryablePaths()).toEqual(new Set(["b.ts"]));
    });

    it("counts runtimeError in the by-reason summary and clears like any entry", async () => {
      await store.record("a.ts", "emptyFile", "h1");
      await store.recordRuntimeError("b.ts", "WorkerTimeoutError");

      expect(await store.summarize()).toEqual({ count: 2, byReason: { emptyFile: 1, runtimeError: 1 } });
      await store.clear("b.ts");
      expect(await store.retryablePaths()).toEqual(new Set());
    });
  });
});
