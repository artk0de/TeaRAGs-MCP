/**
 * The one-terminal-state invariant.
 *
 * A point carries exactly ONE terminal marker per (provider, level): either
 * `<provider>.<level>.enrichedAt` (we settled it) or
 * `<provider>.<level>.skippedAs` (policy declined it). Never both, never
 * neither-forever.
 *
 * Recovery's candidate set is defined as the complement — `buildUnenrichedFilter`
 * asks for points where BOTH keys are empty. So a point with neither marker is
 * rescanned on every run, and a point with both is a contradiction the health
 * mapper cannot resolve.
 *
 * This invariant is the single most expensive one in the enrichment pipeline:
 * it is restated in four docblocks and hand-enforced at four separate write
 * sites, and the 2026-08-08 risk assessment measured the two files that own it
 * at 62% and 53% bugFixRate — the worst in the project. Before this file it was
 * asserted nowhere as an invariant; each site only tested its own happy path,
 * which is exactly how the same defect landed five times under different names
 * (4ef5f9c4, 605ca827, 7e49de66, eb687658, 3d385cab).
 *
 * Every case below is written against the applier's observable payload, not its
 * internals, so a decomposition of `EnrichmentApplier` must leave this file
 * untouched.
 */
import { describe, expect, it } from "vitest";

import { MockQdrantManager } from "../../__helpers__/test-helpers.js";
import { EnrichmentApplier } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/applier.js";
import type { ChunkItem } from "../../../../../../src/core/domains/ingest/pipeline/types.js";

/** ChunkItem whose filePath sits under pathBase "/r", so `relative("/r", …)`
 *  yields the overlay key the applier looks up. */
function chunkItem(relPath: string, chunkId: string): ChunkItem {
  return {
    chunkId,
    chunk: {
      content: "",
      startLine: 1,
      endLine: 5,
      metadata: { filePath: `/r/${relPath}` },
    },
  } as unknown as ChunkItem;
}

async function seed(ids: string[]): Promise<MockQdrantManager> {
  const qdrant = new MockQdrantManager();
  await qdrant.createCollection("c", 384);
  await qdrant.addPoints(
    "c",
    ids.map((id) => ({ id, vector: new Array(384).fill(0.1), payload: {} })),
  );
  return qdrant;
}

/** Terminal markers actually present on a point for one (provider, level). */
async function terminals(
  qdrant: MockQdrantManager,
  id: string,
  level: "file" | "chunk",
): Promise<{ enrichedAt: unknown; skippedAs: unknown }> {
  const point = (await qdrant.getPoint("c", id)) as { payload?: Record<string, never> } | null;
  const sub = point?.payload?.git?.[level] as { enrichedAt?: unknown; skippedAs?: unknown } | undefined;
  return { enrichedAt: sub?.enrichedAt, skippedAs: sub?.skippedAs };
}

/** Policy stub: declines exactly the (path, level) pairs it is given. */
function declines(pairs: readonly [string, "file" | "chunk"][]) {
  const set = new Set(pairs.map(([p, l]) => `${p}\0${l}`));
  return (relativePath: string, level: "file" | "chunk") => set.has(`${relativePath}\0${level}`);
}

describe("enrichment terminal-state invariant", () => {
  it("settles a matched file with enrichedAt and never a skip reason", async () => {
    const qdrant = await seed(["p1"]);
    const applier = new EnrichmentApplier(qdrant as never);

    await applier.applyFileSignals(
      "c",
      "git",
      new Map([["a.ts", { commitCount: 5 }]]),
      "/r",
      [chunkItem("a.ts", "p1")],
      undefined,
      "t0",
    );

    const file = await terminals(qdrant, "p1", "file");
    expect(file.enrichedAt).toBe("t0");
    expect(file.skippedAs).toBeUndefined();
  });

  it("leaves a policy-declined file unstamped by the applier — FilePhase owns its skip stamp", async () => {
    const qdrant = await seed(["p1"]);
    const applier = new EnrichmentApplier(qdrant as never);

    // No overlay for the path AND policy declines it at file level.
    await applier.applyFileSignals(
      "c",
      "git",
      new Map(),
      "/r",
      [chunkItem("gen.ts", "p1")],
      undefined,
      "t0",
      declines([["gen.ts", "file"]]),
    );

    const file = await terminals(qdrant, "p1", "file");
    // Neither marker here is correct: writing enrichedAt would collide with the
    // skippedAs stamp FilePhase writes for the same point.
    expect(file.enrichedAt).toBeUndefined();
    expect(file.skippedAs).toBeUndefined();
    expect(applier.ignoredFiles).toBe(1);
  });

  it("stamps file level but not chunk level when only chunk level is declined", async () => {
    const qdrant = await seed(["p1"]);
    const applier = new EnrichmentApplier(qdrant as never);

    // A doc file: git takes its file signals, never walks its chunks.
    await applier.applyFileSignals(
      "c",
      "git",
      new Map(),
      "/r",
      [chunkItem("README.md", "p1")],
      undefined,
      "t0",
      declines([["README.md", "chunk"]]),
    );

    expect((await terminals(qdrant, "p1", "file")).enrichedAt).toBe("t0");
    // ChunkPhase stamps skippedAs on this point; a chunk-level enrichedAt here
    // would put both terminal markers on it.
    expect((await terminals(qdrant, "p1", "chunk")).enrichedAt).toBeUndefined();
  });

  it("bare-stamps a genuine miss so it leaves the candidate set", async () => {
    const qdrant = await seed(["p1"]);
    const applier = new EnrichmentApplier(qdrant as never);

    // No overlay and NO policy decline ⇒ real miss: must still be settled.
    await applier.applyFileSignals(
      "c",
      "git",
      new Map(),
      "/r",
      [chunkItem("lost.ts", "p1")],
      undefined,
      "t0",
      declines([]),
    );

    expect((await terminals(qdrant, "p1", "file")).enrichedAt).toBe("t0");
    expect(applier.missedFiles).toBe(1);
  });

  it("applies the same split on the finalize path", async () => {
    const qdrant = await seed(["p1", "p2"]);
    const applier = new EnrichmentApplier(qdrant as never);

    await applier.applyFinalizeFile(
      "c",
      "git",
      new Map([["kept.ts", { fanIn: 3 }]]),
      new Map([
        ["kept.ts", [{ chunkId: "p1", startLine: 1, endLine: 5 }]],
        ["gen.ts", [{ chunkId: "p2", startLine: 1, endLine: 5 }]],
      ]),
      undefined,
      "t0",
      declines([["gen.ts", "file"]]),
    );

    expect((await terminals(qdrant, "p1", "file")).enrichedAt).toBe("t0");
    expect((await terminals(qdrant, "p2", "file")).enrichedAt).toBeUndefined();
    expect(applier.ignoredFiles).toBe(1);
  });

  it("never adds enrichedAt to a chunk the applier itself already stamped as declined", async () => {
    const qdrant = await seed(["p1", "p2"]);
    const applier = new EnrichmentApplier(qdrant as never);

    // ChunkPhase settled p1 as a deliberate skip.
    await applier.applySkipStamps("c", "git", "chunk", [{ id: "p1", skippedAs: "documentation" }]);

    // A later pass is handed p1 among the requested ids. buildChunkSignals found
    // no commits for it, so it falls into the bare-stamp loop. The applier is the
    // chokepoint every enrichment write flows through, so it — not the caller —
    // must refuse to put the second terminal marker on that point.
    await applier.applyChunkSignals(
      "c",
      "git",
      new Map([["b.ts", new Map([["p2", { churnRatio: 1 }]])]]),
      "t0",
      new Set(["p1", "p2"]),
      new Set(["p1"]),
    );

    const declined = await terminals(qdrant, "p1", "chunk");
    expect(declined.skippedAs).toBe("documentation");
    expect(declined.enrichedAt).toBeUndefined();

    // The owed point is unaffected.
    const owed = await terminals(qdrant, "p2", "chunk");
    expect(owed.enrichedAt).toBe("t0");
    expect(owed.skippedAs).toBeUndefined();
  });

  // bd tea-rags-mcp-2brzq: `--force-enrichments` re-stamps points an earlier
  // run ENRICHED. A stamp merged into that level kept the stale overlay and its
  // enrichedAt — both terminal markers, plus numeric zeros that read as data.
  it("a skip stamp replaces the level: stale overlay and enrichedAt go, other levels and providers stay", async () => {
    const qdrant = new MockQdrantManager();
    await qdrant.createCollection("c", 384);
    await qdrant.addPoints("c", [
      {
        id: "p1",
        vector: new Array(384).fill(0.1),
        payload: {
          git: {
            file: { commitCount: 12, enrichedAt: "t-old" },
            chunk: { commitCount: 0, bugFixRate: 0, authors: [], enrichedAt: "t-old" },
          },
          codegraph: { symbols: { chunk: { fanIn: 2, enrichedAt: "t-old" } } },
        },
      },
    ]);
    const applier = new EnrichmentApplier(qdrant as never);

    await applier.applySkipStamps("c", "git", "chunk", [{ id: "p1", skippedAs: "oversized" }]);

    const point = (await qdrant.getPoint("c", "p1")) as { payload: Record<string, any> };
    expect(point.payload.git.chunk).toEqual({ skippedAs: "oversized" });
    expect(point.payload.git.file).toEqual({ commitCount: 12, enrichedAt: "t-old" });
    expect(point.payload.codegraph).toEqual({ symbols: { chunk: { fanIn: 2, enrichedAt: "t-old" } } });
    // Exactly one terminal marker: recovery's is_empty(enrichedAt) AND
    // is_empty(skippedAs) conjunction no longer selects the point.
    const chunk = await terminals(qdrant, "p1", "chunk");
    expect(chunk.skippedAs).toBe("oversized");
    expect(chunk.enrichedAt).toBeUndefined();
  });

  it("never overwrites a declined chunk that arrives carrying an overlay", async () => {
    const qdrant = await seed(["p1"]);
    const applier = new EnrichmentApplier(qdrant as never);

    await applier.applySkipStamps("c", "git", "chunk", [{ id: "p1", skippedAs: "generated" }]);

    // Overlay present for a declined point — the persisted-graph case: a run made
    // after the policy tightened is still handed rows for paths indexed under the
    // old config.
    await applier.applyChunkSignals(
      "c",
      "git",
      new Map([["gen.ts", new Map([["p1", { churnRatio: 1 }]])]]),
      "t0",
      undefined,
      new Set(["p1"]),
    );

    const point = await terminals(qdrant, "p1", "chunk");
    expect(point.skippedAs).toBe("generated");
    expect(point.enrichedAt).toBeUndefined();
  });
});
