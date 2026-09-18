import { describe, expect, it, vi } from "vitest";

import type { EnrichmentRunHandle } from "../../../../../../src/core/contracts/types/enrichment-executor.js";
import { EnrichmentCoordinator } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/coordinator.js";
import { InlineEnrichmentExecutor } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/index.js";
import { reindexRunSpec } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/run-spec.js";
import type { EnrichmentProvider } from "../../../../../../src/core/domains/ingest/pipeline/enrichment/types.js";

/**
 * A `--force-enrichments` recompute reads its whole chunk set back BEFORE it
 * opens its run, so it is the one entry point that knows every file the run
 * will feed — and it declares them at the executor's run-start seam (bd
 * tea-rags-mcp-sgo8v). Per-language affinity plans its partitions from that
 * set: every partition must absorb every file from the first batch on, so the
 * partitions have to exist before any file arrives. A streaming run knows only
 * a count, declares nothing, and keeps collection affinity.
 */
function provider(): EnrichmentProvider {
  return {
    key: "codegraph.symbols",
    signals: [],
    derivedSignals: [],
    filters: [],
    presets: [],
    resolveRoot: (p: string) => p,
    buildFileSignals: vi.fn().mockResolvedValue(new Map()),
    buildChunkSignals: vi.fn().mockResolvedValue(new Map()),
  } as unknown as EnrichmentProvider;
}

function qdrantDouble(): Record<string, unknown> {
  return {
    scrollFiltered: vi.fn().mockResolvedValue([
      { id: "c1", payload: { relativePath: "src/a.ts", startLine: 1, endLine: 10 } },
      { id: "c2", payload: { relativePath: "src/a.ts", startLine: 11, endLine: 20 } },
      { id: "c3", payload: { relativePath: "lib/b.rb", startLine: 1, endLine: 10 } },
    ]),
    setPayload: vi.fn().mockResolvedValue(undefined),
    batchSetPayload: vi.fn().mockResolvedValue(undefined),
    countPoints: vi.fn().mockResolvedValue(0),
    getPoint: vi.fn().mockResolvedValue(null),
    upsertPoints: vi.fn().mockResolvedValue(undefined),
  };
}

class RunStartRecorder extends InlineEnrichmentExecutor {
  readonly starts: { fileCount?: number; runRelPaths?: readonly string[] }[] = [];

  beginRun(_run: EnrichmentRunHandle, fileCount?: number, runRelPaths?: readonly string[]): void {
    this.starts.push({ fileCount, runRelPaths });
  }
}

describe("EnrichmentCoordinator — the run's declared file set", () => {
  it("a recompute declares every file it will feed, once each", async () => {
    const executor = new RunStartRecorder();
    const coordinator = new EnrichmentCoordinator(qdrantDouble() as never, [provider()], undefined, executor);

    await coordinator.recomputeEnrichments("coll", "/repo", ["codegraph"]);

    expect(executor.starts).toHaveLength(1);
    expect(executor.starts[0].fileCount).toBe(2);
    expect([...(executor.starts[0].runRelPaths ?? [])].sort()).toEqual(["lib/b.rb", "src/a.ts"]);
  });

  it("a streaming run declares none", () => {
    const executor = new RunStartRecorder();
    const coordinator = new EnrichmentCoordinator(qdrantDouble() as never, [provider()], undefined, executor);

    coordinator.beginRun(reindexRunSpec({ absolutePath: "/repo", collection: "coll" as never, fileCount: 7 }));

    expect(executor.starts).toEqual([{ fileCount: 7, runRelPaths: undefined }]);
  });
});
