/**
 * Settled embedding throughput optima in the registry (bd tea-rags-mcp-7ju66).
 *
 * A run records what its throughput tuner settled on, keyed by endpoint URL +
 * model; the next run on the same endpoint and model starts its hill-climb
 * there. The field MERGES on `record()` — a run that lived only on the primary
 * must not erase what an earlier run learnt about the fallback.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  embeddingThroughputOptimumKey,
  type CollectionEntry,
  type EmbeddingThroughputOptimum,
} from "../../../../../src/core/contracts/types/registry.js";
import { CollectionRegistry } from "../../../../../src/core/domains/maintenance/registry/collection-registry.js";

const PRIMARY = "http://192.168.1.71:11434";
const FALLBACK = "http://localhost:11434";

function makeEntry(over: Partial<CollectionEntry> = {}): Omit<CollectionEntry, "name"> {
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
    r.record(makeEntry({ embeddingThroughputOptima: { [key]: optimum(64, "2026-10-02T01:00:00.000Z") } }));

    expect(new CollectionRegistry(dir).get("code_abc")?.embeddingThroughputOptima).toEqual({
      [key]: optimum(64, "2026-10-02T01:00:00.000Z"),
    });
  });

  it("merges on record(): a run's endpoints overwrite theirs, every other endpoint survives", () => {
    const r = new CollectionRegistry(dir);
    const primary = embeddingThroughputOptimumKey(PRIMARY, "jina");
    const fallback = embeddingThroughputOptimumKey(FALLBACK, "jina");
    r.record(
      makeEntry({
        embeddingThroughputOptima: {
          [primary]: optimum(256, "2026-10-01T00:00:00.000Z"),
          [fallback]: optimum(32, "2026-10-01T00:00:00.000Z", 1),
        },
      }),
    );

    r.record(makeEntry({ embeddingThroughputOptima: { [primary]: optimum(64, "2026-10-02T00:00:00.000Z") } }));
    r.record(makeEntry({ chunksCount: 99 })); // a run that settled nothing

    expect(r.get("code_abc")?.embeddingThroughputOptima).toEqual({
      [primary]: optimum(64, "2026-10-02T00:00:00.000Z"),
      [fallback]: optimum(32, "2026-10-01T00:00:00.000Z", 1),
    });
  });

  it("reads the optimum of the matching endpoint + model only", () => {
    const r = new CollectionRegistry(dir);
    r.record(
      makeEntry({
        embeddingThroughputOptima: {
          [embeddingThroughputOptimumKey(PRIMARY, "jina")]: optimum(64, "2026-10-02T00:00:00.000Z"),
        },
      }),
    );

    expect(r.readEmbeddingThroughputOptimum(PRIMARY, "jina")?.batchSize).toBe(64);
    expect(r.readEmbeddingThroughputOptimum(`${PRIMARY}/`, "jina")?.batchSize).toBe(64);
    expect(r.readEmbeddingThroughputOptimum(PRIMARY, "nomic")).toBeUndefined();
    expect(r.readEmbeddingThroughputOptimum(FALLBACK, "jina")).toBeUndefined();
  });

  it("answers with the freshest optimum any project learnt for the endpoint — a server fact, not a project fact", () => {
    const r = new CollectionRegistry(dir);
    const key = embeddingThroughputOptimumKey(PRIMARY, "jina");
    r.record(makeEntry({ embeddingThroughputOptima: { [key]: optimum(256, "2026-09-01T00:00:00.000Z") } }));
    r.record(
      makeEntry({
        collectionName: "code_def",
        path: "/repo/b",
        embeddingThroughputOptima: { [key]: optimum(64, "2026-10-02T00:00:00.000Z") },
      }),
    );

    expect(r.readEmbeddingThroughputOptimum(PRIMARY, "jina")?.batchSize).toBe(64);
  });
  it("drops legacy url|model keys (no provider prefix) on an optimum write — nothing reads them since y1ynz (cyw2r)", () => {
    const r = new CollectionRegistry(dir);
    const legacyPrimary = embeddingThroughputOptimumKey(PRIMARY, "jina");
    const legacyFallback = embeddingThroughputOptimumKey(FALLBACK, "brokkai/Muninn-small");
    const otherProvider = embeddingThroughputOptimumKey(FALLBACK, "jina", "ollama");
    r.record(
      makeEntry({
        embeddingThroughputOptima: {
          [legacyPrimary]: optimum(256, "2026-10-01T00:00:00.000Z"),
          [legacyFallback]: optimum(64, "2026-10-01T00:00:00.000Z"),
          [otherProvider]: optimum(32, "2026-10-01T00:00:00.000Z"),
        },
      }),
    );

    // A run that writes no optimum leaves the map alone.
    r.record(makeEntry({ chunksCount: 99 }));
    expect(Object.keys(r.get("code_abc")?.embeddingThroughputOptima ?? {})).toHaveLength(3);

    const current = embeddingThroughputOptimumKey(PRIMARY, "jina", "llama-server");
    r.record(makeEntry({ embeddingThroughputOptima: { [current]: optimum(128, "2026-10-03T00:00:00.000Z") } }));

    expect(r.get("code_abc")?.embeddingThroughputOptima).toEqual({
      [otherProvider]: optimum(32, "2026-10-01T00:00:00.000Z"),
      [current]: optimum(128, "2026-10-03T00:00:00.000Z"),
    });
  });
});
