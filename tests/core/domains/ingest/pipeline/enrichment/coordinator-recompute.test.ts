import { beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../../../__helpers__/collection-identity.js";
import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import type { EnrichmentProvider } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

/**
 * A recompute is a full enrichment RUN, not a repair.
 *
 * That distinction is the whole point of these tests. Driving it through
 * recovery rewrote payload correctly but never opened a run, so
 * `finalizeSignals` — where codegraph persists its resolve breakdown to
 * `cg_run_stats` — never fired, and the coordinator's RunState reported zero
 * work. Both were observed live on 2026-08-11.
 */
function provider(key: string, extra: Partial<EnrichmentProvider> = {}): EnrichmentProvider {
  return {
    key,
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
    ...extra,
  };
}

/** Qdrant double serving one page of already-indexed points. */
function qdrantWithPoints(points: { id: string; relativePath: string }[]): Record<string, unknown> {
  return {
    scrollFiltered: vi.fn().mockResolvedValue(
      points.map((p) => ({
        id: p.id,
        payload: { relativePath: p.relativePath, startLine: 1, endLine: 10 },
      })),
    ),
    setPayload: vi.fn().mockResolvedValue(undefined),
    batchSetPayload: vi.fn().mockResolvedValue(undefined),
    countPoints: vi.fn().mockResolvedValue(0),
    getPoint: vi.fn().mockResolvedValue(null),
    upsertPoints: vi.fn().mockResolvedValue(undefined),
  };
}

const POINTS = [
  { id: "c1", relativePath: "src/a.ts" },
  { id: "c2", relativePath: "src/b.ts" },
];

describe("EnrichmentCoordinator.recomputeEnrichments", () => {
  let qdrant: Record<string, unknown>;

  beforeEach(() => {
    qdrant = qdrantWithPoints(POINTS);
  });

  it("opens a real run so the provider's finalize hook fires", async () => {
    // finalizeSignals is where codegraph writes cg_run_stats. A repair-style
    // pass never calls it, which is exactly the defect this replaces.
    const finalizeSignals = vi.fn().mockResolvedValue(new Map());
    const p = provider("codegraph.symbols", { finalizeSignals, defersChunkEnrichment: true });
    const coordinator = new EnrichmentCoordinator(qdrant as never, [p]);

    await coordinator.recomputeEnrichments(fixturePhysicalCollectionName("coll"), "/repo", ["codegraph"]);

    expect(finalizeSignals).toHaveBeenCalled();
  });

  it("returns the run's enrichment metrics rather than nothing", async () => {
    // The CLI's --json surfaces these; reporting zero work on a successful
    // recompute is what made the run look like a no-op.
    const coordinator = new EnrichmentCoordinator(qdrant as never, [provider("git")]);

    const metrics = await coordinator.recomputeEnrichments(fixturePhysicalCollectionName("coll"), "/repo", ["git"]);

    expect(metrics).toBeDefined();
  });

  it("feeds every indexed file to the selected provider", async () => {
    const p = provider("git");
    const coordinator = new EnrichmentCoordinator(qdrant as never, [p]);

    await coordinator.recomputeEnrichments(fixturePhysicalCollectionName("coll"), "/repo", ["git"]);

    const paths = (p.buildFileSignals as ReturnType<typeof vi.fn>).mock.calls.flatMap(
      (call) => (call[1] as { paths?: string[] })?.paths ?? [],
    );
    expect(new Set(paths)).toEqual(new Set(["src/a.ts", "src/b.ts"]));
  });

  it("leaves unselected providers untouched", async () => {
    const git = provider("git");
    const cg = provider("codegraph.symbols");
    const coordinator = new EnrichmentCoordinator(qdrant as never, [git, cg]);

    await coordinator.recomputeEnrichments(fixturePhysicalCollectionName("coll"), "/repo", ["git"]);

    expect(git.buildFileSignals).toHaveBeenCalled();
    expect(cg.buildFileSignals).not.toHaveBeenCalled();
  });

  it("expands a namespace selector to every provider under it", async () => {
    const symbols = provider("codegraph.symbols");
    const complexity = provider("codegraph.complexity");
    const coordinator = new EnrichmentCoordinator(qdrant as never, [provider("git"), symbols, complexity]);

    await coordinator.recomputeEnrichments(fixturePhysicalCollectionName("coll"), "/repo", ["codegraph"]);

    expect(symbols.buildFileSignals).toHaveBeenCalled();
    expect(complexity.buildFileSignals).toHaveBeenCalled();
  });

  it("does nothing when no provider matches the selector", async () => {
    const p = provider("git");
    const coordinator = new EnrichmentCoordinator(qdrant as never, [p]);

    await coordinator.recomputeEnrichments(fixturePhysicalCollectionName("coll"), "/repo", ["nonsense"]);

    expect(p.buildFileSignals).not.toHaveBeenCalled();
  });

  // bd tea-rags-mcp-39xca.5 — `--force-enrichments` reports the run done when this
  // promise resolves, so it must not resolve while the terminal chunk marker is
  // still being written (u3e77 was a marker landing late).
  it("resolves only after the run's terminal chunk marker is written", async () => {
    const chunkMarkerKey = "enrichment.codegraph.symbols.chunk";
    const requested: string[] = [];
    const written: string[] = [];
    let openMarkerWrite!: () => void;
    const markerWriteOpened = new Promise<void>((resolve) => {
      openMarkerWrite = resolve;
    });
    const gated = {
      ...qdrantWithPoints(POINTS),
      batchSetPayload: vi.fn(async (_coll: string, ops: { key?: string }[]) => {
        for (const op of ops) {
          if (op.key !== chunkMarkerKey) continue;
          requested.push(op.key);
          await markerWriteOpened;
          written.push(op.key);
        }
      }),
    };
    const p = provider("codegraph.symbols", {
      finalizeSignals: vi.fn().mockResolvedValue(new Map()),
      defersChunkEnrichment: true,
    });
    const coordinator = new EnrichmentCoordinator(gated as never, [p]);

    let resolved = false;
    const recompute = coordinator
      .recomputeEnrichments(fixturePhysicalCollectionName("coll"), "/repo", ["codegraph"])
      .then(() => {
        resolved = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(requested).toEqual([chunkMarkerKey]);
    expect(resolved).toBe(false);

    openMarkerWrite();
    await recompute;

    expect(written).toEqual([chunkMarkerKey]);
    expect(resolved).toBe(true);
  });

  it("does nothing when the index holds no points", async () => {
    const p = provider("git");
    const coordinator = new EnrichmentCoordinator(qdrantWithPoints([]) as never, [p]);

    await coordinator.recomputeEnrichments(fixturePhysicalCollectionName("coll"), "/repo", ["git"]);

    expect(p.buildFileSignals).not.toHaveBeenCalled();
  });

  // bd tea-rags-mcp-ckfof — loosening a policy (TRAJECTORY_GIT_CHUNK_MAX_FILE_LINES
  // 777 → 5000) and recomputing left `skippedAs: "oversized"` beside the fresh
  // overlay on every point: the overlay write merges, nothing retired the old
  // decline. The recompute re-decides the policy for every point it rebuilds,
  // so it retires the previous decisions first and re-stamps what it still
  // declines.
  describe("retires the previous run's skip stamps before rebuilding", () => {
    function recordingQdrant(): { qdrant: Record<string, unknown>; calls: string[] } {
      const calls: string[] = [];
      const base = qdrantWithPoints(POINTS);
      const qdrant = {
        ...base,
        deletePayloadKeys: vi.fn(async () => {
          calls.push("deletePayloadKeys");
          return Promise.resolve();
        }),
        batchSetPayload: vi.fn(async () => {
          calls.push("batchSetPayload");
          return Promise.resolve();
        }),
        batchDeletePayload: vi.fn().mockResolvedValue(undefined),
      };
      return { qdrant, calls };
    }

    it("deletes both levels' skippedAs of every selected provider — and only those — before any payload write", async () => {
      const { qdrant, calls } = recordingQdrant();
      const coordinator = new EnrichmentCoordinator(qdrant as never, [provider("git"), provider("codegraph.symbols")]);

      await coordinator.recomputeEnrichments(fixturePhysicalCollectionName("coll"), "/repo", ["git"]);

      const deletes = vi.mocked(qdrant.deletePayloadKeys as (...args: unknown[]) => Promise<void>).mock.calls;
      expect(deletes).toHaveLength(1);
      expect(deletes[0][0]).toBe("coll");
      expect(deletes[0][1]).toEqual(["git.file.skippedAs", "git.chunk.skippedAs"]);
      expect(calls[0]).toBe("deletePayloadKeys");
    });

    it("scopes the retirement to the recompute's languages", async () => {
      const { qdrant } = recordingQdrant();
      const coordinator = new EnrichmentCoordinator(qdrant as never, [provider("git")]);

      await coordinator.recomputeEnrichments(fixturePhysicalCollectionName("coll"), "/repo", ["git"], ["ruby"]);

      const deletes = vi.mocked(qdrant.deletePayloadKeys as (...args: unknown[]) => Promise<void>).mock.calls;
      expect(deletes).toHaveLength(1);
      expect(JSON.stringify(deletes[0][2])).toContain('"language","match":{"any":["ruby"]}');
    });

    it("still rebuilds when the retirement fails — the stamps stay as they were", async () => {
      const { qdrant } = recordingQdrant();
      vi.mocked(qdrant.deletePayloadKeys as () => Promise<void>).mockRejectedValue(new Error("qdrant down"));
      const p = provider("git");
      const coordinator = new EnrichmentCoordinator(qdrant as never, [p]);

      await coordinator.recomputeEnrichments(fixturePhysicalCollectionName("coll"), "/repo", ["git"]);

      expect(p.buildFileSignals).toHaveBeenCalled();
    });
  });
});
