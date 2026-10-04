/**
 * Embedding throughput optima are a fact about the embedding CONFIGURATION —
 * provider + endpoint set + model — not about the project that measured them
 * (bd tea-rags-mcp-auoxk). They live in ONE registry-level section every
 * project seeds from and persists to; per-entry records of earlier builds are
 * lifted into it on read.
 */

import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  embeddingThroughputOptimumKey,
  type CollectionEntry,
  type EmbeddingThroughputOptimum,
  type RecordEntryInput,
  type RegistryFileV1,
} from "../../../../../src/core/contracts/types/registry.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";
import { saveRegistryFile } from "../../../../../src/core/domains/maintenance/registry/registry-file.js";

const PRIMARY = "http://192.168.1.71:8080";
const FALLBACK = "http://localhost:8080";
const MODEL = "jina";
const PROVIDER = "llama-server";

const PRIMARY_KEY = embeddingThroughputOptimumKey(PRIMARY, MODEL, PROVIDER);
const FALLBACK_KEY = embeddingThroughputOptimumKey(FALLBACK, MODEL, PROVIDER);

function entry(collectionName: string, over: Partial<CollectionEntry> = {}): CollectionEntry {
  return {
    collectionName,
    path: `/repo/${collectionName}`,
    name: null,
    embeddingModel: MODEL,
    embeddingDimensions: 768,
    qdrantUrl: "http://localhost:6333",
    indexedAt: "2026-10-02T00:00:00.000Z",
    teaRagsVersion: "0.1.0",
    chunksCount: 10,
    ...over,
  };
}

function recordInput(collectionName: string, over: Partial<RecordEntryInput> = {}): RecordEntryInput {
  const { name: _name, ...rest } = entry(collectionName);
  return { ...rest, ...over };
}

function aggregate(
  charsPerSecond: number,
  settledAt = "2026-10-02T00:00:00.000Z",
  batchSize = 128,
): EmbeddingThroughputOptimum {
  return { batchSize, concurrency: 8, charsPerSecond, settledAt, measurement: "aggregate" };
}

function perBatch(charsPerSecond: number, settledAt = "2026-10-02T00:00:00.000Z"): EmbeddingThroughputOptimum {
  return { batchSize: 64, concurrency: 2, charsPerSecond, settledAt, measurement: "per-batch" };
}

function readDisk(dir: string): RegistryFileV1 {
  return JSON.parse(readFileSync(join(dir, "registry.json"), "utf-8")) as RegistryFileV1;
}

describe("CollectionRegistry — shared embedding throughput optima (auoxk)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creg-auoxk-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("an optimum recorded while project A indexed seeds project B on the same identity", () => {
    const a = new CollectionRegistry(dir);
    a.record(recordInput("code_a"));
    a.recordEmbeddingThroughputOptima([{ key: PRIMARY_KEY, optimum: aggregate(90_000) }]);

    const b = new CollectionRegistry(dir);
    b.record(recordInput("code_b"));
    expect(b.readEmbeddingThroughputOptimum(PRIMARY, MODEL, PROVIDER)).toEqual(aggregate(90_000));
  });

  it("stores the section at the registry top level, not on any entry", () => {
    const r = new CollectionRegistry(dir);
    r.record(recordInput("code_a"));
    r.recordEmbeddingThroughputOptima([{ key: PRIMARY_KEY, optimum: aggregate(90_000) }]);

    const disk = readDisk(dir);
    expect(disk.embeddingThroughputOptima).toEqual({ [PRIMARY_KEY]: aggregate(90_000) });
    expect(disk.collections.code_a).not.toHaveProperty("embeddingThroughputOptima");
  });

  it("keeps identities apart: the fallback tier and another model never inherit the primary's optimum", () => {
    const r = new CollectionRegistry(dir);
    r.recordEmbeddingThroughputOptima([{ key: PRIMARY_KEY, optimum: aggregate(90_000) }]);

    expect(r.readEmbeddingThroughputOptimum(FALLBACK, MODEL, PROVIDER)).toBeUndefined();
    expect(r.readEmbeddingThroughputOptimum(PRIMARY, "nomic", PROVIDER)).toBeUndefined();
    expect(r.readEmbeddingThroughputOptimum(PRIMARY, MODEL, "ollama")).toBeUndefined();
    expect(r.readEmbeddingThroughputOptimum(`${PRIMARY}/`, MODEL, PROVIDER)).toEqual(aggregate(90_000));
  });

  it("merges per key: a write for the primary leaves the fallback's optimum alone", () => {
    const r = new CollectionRegistry(dir);
    r.recordEmbeddingThroughputOptima([
      { key: PRIMARY_KEY, optimum: aggregate(90_000) },
      { key: FALLBACK_KEY, optimum: aggregate(20_000) },
    ]);
    r.recordEmbeddingThroughputOptima([
      { key: PRIMARY_KEY, optimum: aggregate(95_000, "2026-10-03T00:00:00.000Z"), storedOptimum: aggregate(90_000) },
    ]);

    expect(new CollectionRegistry(dir).readEmbeddingThroughputOptimum(FALLBACK, MODEL, PROVIDER)).toEqual(
      aggregate(20_000),
    );
  });

  it("survives a flush of an unrelated entry field (setName) by another instance", () => {
    const writer = new CollectionRegistry(dir);
    writer.record(recordInput("code_a"));
    const renamer = new CollectionRegistry(dir);
    renamer.get("code_a"); // load before the optima write
    writer.recordEmbeddingThroughputOptima([{ key: PRIMARY_KEY, optimum: aggregate(90_000) }]);

    renamer.setName("code_a", "proj-a");

    expect(readDisk(dir).embeddingThroughputOptima).toEqual({ [PRIMARY_KEY]: aggregate(90_000) });
  });

  describe("concurrent writers (revision CAS, reconciled against the CURRENT disk value)", () => {
    it("two processes writing different identities both survive", () => {
      const a = new CollectionRegistry(dir);
      const b = new CollectionRegistry(dir);
      a.list();
      b.list(); // both caches loaded before either write

      a.recordEmbeddingThroughputOptima([{ key: PRIMARY_KEY, optimum: aggregate(90_000) }]);
      b.recordEmbeddingThroughputOptima([{ key: FALLBACK_KEY, optimum: aggregate(20_000) }]);

      expect(readDisk(dir).embeddingThroughputOptima).toEqual({
        [PRIMARY_KEY]: aggregate(90_000),
        [FALLBACK_KEY]: aggregate(20_000),
      });
    });

    it("a worse run from project B does not overwrite the better point project A persisted meanwhile", () => {
      const a = new CollectionRegistry(dir);
      const b = new CollectionRegistry(dir);
      b.list(); // B's run started (and read nothing stored) before A wrote

      a.recordEmbeddingThroughputOptima([{ key: PRIMARY_KEY, optimum: aggregate(90_000) }]);
      b.recordEmbeddingThroughputOptima([
        { key: PRIMARY_KEY, optimum: aggregate(40_000, "2026-10-03T00:00:00.000Z", 32) },
      ]);

      expect(readDisk(dir).embeddingThroughputOptima?.[PRIMARY_KEY]).toEqual(aggregate(90_000));
      expect(b.readEmbeddingThroughputOptimum(PRIMARY, MODEL, PROVIDER)).toEqual(aggregate(90_000));
    });

    it("a faster run from project B replaces A's point even when B never saw it", () => {
      const a = new CollectionRegistry(dir);
      const b = new CollectionRegistry(dir);
      b.list();

      a.recordEmbeddingThroughputOptima([{ key: PRIMARY_KEY, optimum: aggregate(90_000) }]);
      b.recordEmbeddingThroughputOptima([
        { key: PRIMARY_KEY, optimum: aggregate(120_000, "2026-10-03T00:00:00.000Z") },
      ]);

      expect(readDisk(dir).embeddingThroughputOptima?.[PRIMARY_KEY]).toEqual(
        aggregate(120_000, "2026-10-03T00:00:00.000Z"),
      );
    });

    it("a per-batch fallback point never displaces a record another process wrote meanwhile", () => {
      const a = new CollectionRegistry(dir);
      const b = new CollectionRegistry(dir);
      b.list();

      a.recordEmbeddingThroughputOptima([{ key: PRIMARY_KEY, optimum: aggregate(90_000) }]);
      b.recordEmbeddingThroughputOptima([{ key: PRIMARY_KEY, optimum: perBatch(150_000) }]);

      expect(readDisk(dir).embeddingThroughputOptima?.[PRIMARY_KEY]).toEqual(aggregate(90_000));
    });

    it("keeps the tuner's verdict when the record it reconciled against is still the one on disk (slower server lowers it)", () => {
      const r = new CollectionRegistry(dir);
      r.recordEmbeddingThroughputOptima([{ key: PRIMARY_KEY, optimum: aggregate(90_000) }]);

      const slower = aggregate(60_000, "2026-10-03T00:00:00.000Z");
      new CollectionRegistry(dir).recordEmbeddingThroughputOptima([
        { key: PRIMARY_KEY, optimum: slower, storedOptimum: aggregate(90_000) },
      ]);

      expect(readDisk(dir).embeddingThroughputOptima?.[PRIMARY_KEY]).toEqual(slower);
    });

    it("loses no update when another process writes between the CAS read and the rename", () => {
      const r = new CollectionRegistry(dir);
      r.recordEmbeddingThroughputOptima([{ key: FALLBACK_KEY, optimum: aggregate(20_000) }]);

      const realStat = fs.statSync.bind(fs);
      let calls = 0;
      const spy = vi.spyOn(fs, "statSync").mockImplementation(((p: string) => {
        calls++;
        if (calls === 2) {
          // The competing process lands its better primary point mid-flush.
          const disk = readDisk(dir);
          saveRegistryFile(dir, {
            ...disk,
            embeddingThroughputOptima: { ...disk.embeddingThroughputOptima, [PRIMARY_KEY]: aggregate(90_000) },
          });
        }
        return realStat(p);
      }) as typeof fs.statSync);
      try {
        r.recordEmbeddingThroughputOptima([{ key: PRIMARY_KEY, optimum: aggregate(40_000) }]);
      } finally {
        spy.mockRestore();
      }

      expect(readDisk(dir).embeddingThroughputOptima).toEqual({
        [FALLBACK_KEY]: aggregate(20_000),
        [PRIMARY_KEY]: aggregate(90_000),
      });
    });
  });

  describe("migration of per-entry optima (written by earlier builds)", () => {
    const LEGACY_KEY = embeddingThroughputOptimumKey(PRIMARY, MODEL);

    function seedLegacy(
      collections: Record<string, CollectionEntry>,
      section?: RegistryFileV1["embeddingThroughputOptima"],
    ) {
      writeFileSync(
        join(dir, "registry.json"),
        JSON.stringify({
          version: 1,
          revision: 2,
          collections,
          ...(section ? { embeddingThroughputOptima: section } : {}),
        }),
      );
    }

    it("lifts per-entry records, preferring aggregate, then higher chars/s, then the newer settle", () => {
      const OTHER_MODEL_KEY = embeddingThroughputOptimumKey(PRIMARY, "nomic", PROVIDER);
      seedLegacy({
        code_a: entry("code_a", {
          embeddingThroughputOptima: {
            [PRIMARY_KEY]: perBatch(200_000, "2026-10-03T00:00:00.000Z"),
            [FALLBACK_KEY]: aggregate(20_000, "2026-10-01T00:00:00.000Z"),
            [OTHER_MODEL_KEY]: aggregate(5_000, "2026-10-01T00:00:00.000Z"),
          },
        }),
        code_b: entry("code_b", {
          embeddingThroughputOptima: {
            [PRIMARY_KEY]: aggregate(80_000, "2026-09-01T00:00:00.000Z"),
            [FALLBACK_KEY]: aggregate(20_000, "2026-10-02T00:00:00.000Z", 64),
            [OTHER_MODEL_KEY]: aggregate(7_000, "2026-09-01T00:00:00.000Z"),
          },
        }),
        code_c: entry("code_c", {
          embeddingThroughputOptima: { [PRIMARY_KEY]: aggregate(70_000, "2026-10-03T00:00:00.000Z") },
        }),
      });

      const r = new CollectionRegistry(dir);
      expect(r.readEmbeddingThroughputOptimum(PRIMARY, MODEL, PROVIDER)).toEqual(
        aggregate(80_000, "2026-09-01T00:00:00.000Z"),
      );
      expect(r.readEmbeddingThroughputOptimum(FALLBACK, MODEL, PROVIDER)).toEqual(
        aggregate(20_000, "2026-10-02T00:00:00.000Z", 64),
      );
      expect(r.readEmbeddingThroughputOptimum(PRIMARY, "nomic", PROVIDER)).toEqual(
        aggregate(7_000, "2026-09-01T00:00:00.000Z"),
      );
    });

    it("does not lift legacy url|model keys", () => {
      seedLegacy({ code_a: entry("code_a", { embeddingThroughputOptima: { [LEGACY_KEY]: aggregate(90_000) } }) });

      const r = new CollectionRegistry(dir);
      expect(r.readEmbeddingThroughputOptimum(PRIMARY, MODEL)).toBeUndefined();
      r.record(recordInput("code_b"));
      expect(readDisk(dir).embeddingThroughputOptima ?? {}).toEqual({});
    });

    it("never overrides a key the section already holds — per-entry records are no longer read once lifted", () => {
      seedLegacy(
        { code_a: entry("code_a", { embeddingThroughputOptima: { [PRIMARY_KEY]: aggregate(200_000) } }) },
        { [PRIMARY_KEY]: aggregate(90_000) },
      );

      expect(new CollectionRegistry(dir).readEmbeddingThroughputOptimum(PRIMARY, MODEL, PROVIDER)).toEqual(
        aggregate(90_000),
      );
    });

    it("persists the lifted section on the next write and drops the per-entry field when that entry is recorded", () => {
      seedLegacy({
        code_a: entry("code_a", { embeddingThroughputOptima: { [PRIMARY_KEY]: aggregate(80_000) } }),
        code_b: entry("code_b", { embeddingThroughputOptima: { [FALLBACK_KEY]: aggregate(20_000) } }),
      });

      new CollectionRegistry(dir).record(recordInput("code_a", { chunksCount: 99 }));

      const disk = readDisk(dir);
      expect(disk.embeddingThroughputOptima).toEqual({
        [PRIMARY_KEY]: aggregate(80_000),
        [FALLBACK_KEY]: aggregate(20_000),
      });
      expect(disk.collections.code_a).not.toHaveProperty("embeddingThroughputOptima");
      // An entry nobody rewrote keeps its legacy field until its own next record().
      expect(disk.collections.code_b.embeddingThroughputOptima).toEqual({ [FALLBACK_KEY]: aggregate(20_000) });
    });

    it("is idempotent: a second load and a second write leave the section unchanged", () => {
      seedLegacy({
        code_a: entry("code_a", { embeddingThroughputOptima: { [PRIMARY_KEY]: aggregate(80_000) } }),
      });
      new CollectionRegistry(dir).record(recordInput("code_a"));
      const first = readDisk(dir).embeddingThroughputOptima;

      const again = new CollectionRegistry(dir);
      expect(again.readEmbeddingThroughputOptimum(PRIMARY, MODEL, PROVIDER)).toEqual(aggregate(80_000));
      again.record(recordInput("code_a", { chunksCount: 3 }));

      expect(readDisk(dir).embeddingThroughputOptima).toEqual(first);
    });
  });
});
