/**
 * Settled embedding throughput optima in the registry (bd tea-rags-mcp-7ju66).
 *
 * A run records what its throughput tuner settled on, keyed by endpoint URL +
 * model; the next run on the same endpoint and model starts its hill-climb
 * there. Writes MERGE per key into the registry-level section (bd
 * tea-rags-mcp-auoxk) — a run that lived only on the primary must not erase
 * what an earlier run learnt about the fallback.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  embeddingThroughputOptimumKey,
  type EmbeddingThroughputOptimum,
  type RecordEntryInput,
} from "../../../../../src/core/contracts/types/registry.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";

const PRIMARY = "http://192.168.1.71:11434";
const FALLBACK = "http://localhost:11434";

function makeEntry(over: Partial<RecordEntryInput> = {}): RecordEntryInput {
  return {
    collectionName: "code_abc",
    path: "/repo/a",
    embeddingModel: "jina",
    embeddingDimensions: 768,
    qdrantUrl: "http://localhost:6333",
    indexedAt: "2026-10-02T00:00:00.000Z",
    teaRagsVersion: "0.1.0",
    chunksCount: 10,
    ...over,
  };
}

function optimum(batchSize: number, settledAt: string, concurrency = 4): EmbeddingThroughputOptimum {
  return { batchSize, concurrency, charsPerSecond: 50_000, settledAt };
}

describe("CollectionRegistry — embedding throughput optima", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "creg-eto-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keys an optimum by endpoint URL + model, ignoring a trailing slash", () => {
    expect(embeddingThroughputOptimumKey(`${PRIMARY}/`, "jina")).toBe(embeddingThroughputOptimumKey(PRIMARY, "jina"));
    expect(embeddingThroughputOptimumKey(PRIMARY, "jina")).not.toBe(embeddingThroughputOptimumKey(FALLBACK, "jina"));
    expect(embeddingThroughputOptimumKey(PRIMARY, "jina")).not.toBe(embeddingThroughputOptimumKey(PRIMARY, "nomic"));
  });

  it("writes the run's settled optima and persists them across instances", () => {
    const r = new CollectionRegistry(dir);
    const key = embeddingThroughputOptimumKey(PRIMARY, "jina");
    r.recordEmbeddingThroughputOptima([{ key, optimum: optimum(64, "2026-10-02T01:00:00.000Z") }]);

    expect(new CollectionRegistry(dir).readEmbeddingThroughputOptimum(PRIMARY, "jina")).toEqual(
      optimum(64, "2026-10-02T01:00:00.000Z"),
    );
  });

  it("a run's write overwrites its endpoints, every other endpoint survives, and record() never touches them", () => {
    const r = new CollectionRegistry(dir);
    const primary = embeddingThroughputOptimumKey(PRIMARY, "jina");
    const fallback = embeddingThroughputOptimumKey(FALLBACK, "jina");
    r.record(makeEntry());
    r.recordEmbeddingThroughputOptima([
      { key: primary, optimum: optimum(256, "2026-10-01T00:00:00.000Z") },
      { key: fallback, optimum: optimum(32, "2026-10-01T00:00:00.000Z", 1) },
    ]);

    r.recordEmbeddingThroughputOptima([
      {
        key: primary,
        optimum: optimum(64, "2026-10-02T00:00:00.000Z"),
        storedOptimum: optimum(256, "2026-10-01T00:00:00.000Z"),
      },
    ]);
    r.record(makeEntry({ chunksCount: 99 })); // a run that settled nothing

    expect(r.readEmbeddingThroughputOptimum(PRIMARY, "jina")).toEqual(optimum(64, "2026-10-02T00:00:00.000Z"));
    expect(r.readEmbeddingThroughputOptimum(FALLBACK, "jina")).toEqual(optimum(32, "2026-10-01T00:00:00.000Z", 1));
  });

  it("reads the optimum of the matching endpoint + model only", () => {
    const r = new CollectionRegistry(dir);
    r.recordEmbeddingThroughputOptima([
      { key: embeddingThroughputOptimumKey(PRIMARY, "jina"), optimum: optimum(64, "2026-10-02T00:00:00.000Z") },
    ]);

    expect(r.readEmbeddingThroughputOptimum(PRIMARY, "jina")?.batchSize).toBe(64);
    expect(r.readEmbeddingThroughputOptimum(`${PRIMARY}/`, "jina")?.batchSize).toBe(64);
    expect(r.readEmbeddingThroughputOptimum(PRIMARY, "nomic")).toBeUndefined();
    expect(r.readEmbeddingThroughputOptimum(FALLBACK, "jina")).toBeUndefined();
  });
});
