/**
 * The live defect end to end (bd tea-rags-mcp-9mwny): a chunk whose walk found
 * a commit 13 days ago is enriched, then re-enriched after its chunk window no
 * longer holds any commit. The real git assembler emits the second overlay
 * with `lastModifiedAt: 0` and `ageDays` omitted; the real applier writes it
 * with the real git provider's declaration onto a store that models Qdrant's
 * wire (an `undefined` never arrives, `set_payload` with `key` merges).
 *
 * Before the fix the second write left `ageDays: 13` beside
 * `lastModifiedAt: 0` — the shape 286 self-index chunks carry — and the `age` /
 * `recency` rerank read the chunk as two-week-old code.
 */

import { describe, expect, it } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import type { ChunkAccumulator } from "../../../../../../src/core/domains/trajectory/git/infra/metrics.js";
import { assembleChunkSignals } from "../../../../../../src/core/domains/trajectory/git/infra/metrics/chunk-assembler.js";
import { GitEnrichmentProvider } from "../../../../../../src/core/domains/trajectory/git/provider.js";

const DAY = 86_400;

function accumulator(lastModifiedAt: number): ChunkAccumulator {
  const touched = lastModifiedAt > 0;
  return {
    commitShas: new Set(touched ? ["abc123"] : []),
    authors: new Set(touched ? ["alice"] : []),
    bugFixCount: 0,
    lastModifiedAt,
    linesAdded: touched ? 4 : 0,
    linesDeleted: 0,
    commitTimestamps: touched ? [lastModifiedAt] : [],
    commitAuthors: touched ? ["alice"] : [],
    taskIds: new Set(),
  };
}

async function seededStore(): Promise<MockQdrantManager> {
  const qdrant = new MockQdrantManager();
  await qdrant.createCollection("coll", 4);
  await qdrant.addPoints("coll", [
    {
      id: "c1",
      vector: [0, 0, 0, 0],
      payload: {
        relativePath: "scripts/forensics.ts",
        git: { file: { commitCount: 3, ageDays: 13, enrichedAt: "t0" } },
        codegraph: { symbols: { chunk: { fanIn: 2, fanOut: 1, pageRank: 0.1 } } },
      },
    },
  ]);
  return qdrant;
}

async function enrichChunk(applier: EnrichmentApplier, lastModifiedAt: number, enrichedAt: string): Promise<void> {
  const overlay = assembleChunkSignals(accumulator(lastModifiedAt), 3, 1, 10);
  await applier.applyChunkSignals(
    "coll",
    "git",
    new Map([["scripts/forensics.ts", new Map([["c1", overlay]])]]),
    enrichedAt,
  );
}

describe("re-enriching a chunk whose commits left the chunk window", () => {
  it("removes the stale ageDays and keeps every other payload subtree as it was", async () => {
    const qdrant = await seededStore();
    const applier = new EnrichmentApplier(qdrant as never, { baseDelayMs: 0 }, [new GitEnrichmentProvider()]);

    await enrichChunk(applier, Math.floor(Date.now() / 1000) - 13 * DAY, "t1");
    expect((await qdrant.getPoint("coll", "c1"))?.payload.git.chunk.ageDays).toBe(13);

    await enrichChunk(applier, 0, "t2");

    const payload = (await qdrant.getPoint("coll", "c1"))?.payload;
    expect(payload.git.chunk).not.toHaveProperty("ageDays");
    expect(payload.git.chunk).toMatchObject({ commitCount: 0, lastModifiedAt: 0, enrichedAt: "t2" });
    // The file level and the other provider's subtree are not this write's business.
    expect(payload.git.file).toEqual({ commitCount: 3, ageDays: 13, enrichedAt: "t0" });
    expect(payload.codegraph).toEqual({ symbols: { chunk: { fanIn: 2, fanOut: 1, pageRank: 0.1 } } });
  });

  it("costs one extra request for the whole apply call, however many chunks it re-enriches", async () => {
    const qdrant = await seededStore();
    const applier = new EnrichmentApplier(qdrant as never, { baseDelayMs: 0 }, [new GitEnrichmentProvider()]);

    await enrichChunk(applier, 0, "t2");

    expect(qdrant.batchDeletePayloadCalls).toHaveLength(1);
    expect(qdrant.batchDeletePayloadCalls[0].operations).toEqual([{ keys: ["git.chunk.ageDays"], points: ["c1"] }]);
  });
});
