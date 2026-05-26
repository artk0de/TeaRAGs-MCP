/**
 * Codegraph payload-signal descriptors — schema-shape contract.
 *
 * Pins the descriptor shapes that get_index_metrics (skips when stats.labels
 * absent) and the reranker label resolver (same skip rule) rely on. Without
 * these blocks codegraph signals are invisible to both surfaces.
 */

import { describe, expect, it } from "vitest";

import type { PayloadSignalDescriptor } from "../../../../../../src/core/contracts/types/trajectory.js";
import {
  CODEGRAPH_SYMBOLS_CHUNK_SIGNALS,
  CODEGRAPH_SYMBOLS_FILE_SIGNALS,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/payload-signals.js";

function find(list: PayloadSignalDescriptor[], key: string): PayloadSignalDescriptor {
  const d = list.find((s) => s.key === key);
  if (!d) throw new Error(`descriptor not found: ${key}`);
  return d;
}

describe("CODEGRAPH_SYMBOLS_FILE_SIGNALS — stats.labels", () => {
  it("declares percentile labels for fanIn", () => {
    expect(find(CODEGRAPH_SYMBOLS_FILE_SIGNALS, "codegraph.file.fanIn").stats?.labels).toEqual({
      p25: "isolated",
      p50: "typical",
      p75: "popular",
      p95: "hub",
    });
  });

  it("declares percentile labels for fanOut", () => {
    expect(find(CODEGRAPH_SYMBOLS_FILE_SIGNALS, "codegraph.file.fanOut").stats?.labels).toEqual({
      p25: "minimal",
      p50: "typical",
      p75: "heavy",
      p95: "exhaustive",
    });
  });

  it("declares percentile labels for instability", () => {
    expect(find(CODEGRAPH_SYMBOLS_FILE_SIGNALS, "codegraph.file.instability").stats?.labels).toEqual({
      p50: "stable",
      p75: "mixed",
      p95: "unstable",
    });
  });

  it("declares percentile labels for transitiveImpact", () => {
    expect(find(CODEGRAPH_SYMBOLS_FILE_SIGNALS, "codegraph.file.transitiveImpact").stats?.labels).toEqual({
      p50: "local",
      p75: "regional",
      p95: "systemic",
    });
  });
});

describe("CODEGRAPH_SYMBOLS_CHUNK_SIGNALS — stats.labels", () => {
  it("declares percentile labels for chunk fanIn with chunkTypeFilter=function", () => {
    const d = find(CODEGRAPH_SYMBOLS_CHUNK_SIGNALS, "codegraph.chunk.fanIn");
    expect(d.stats?.labels).toEqual({
      p25: "unused",
      p50: "typical",
      p75: "frequent",
      p95: "central",
    });
    expect(d.stats?.chunkTypeFilter).toBe("function");
  });

  it("declares percentile labels for chunk fanOut with chunkTypeFilter=function", () => {
    const d = find(CODEGRAPH_SYMBOLS_CHUNK_SIGNALS, "codegraph.chunk.fanOut");
    expect(d.stats?.labels).toEqual({
      p25: "leaf",
      p50: "typical",
      p75: "orchestrator",
      p95: "god-method",
    });
    expect(d.stats?.chunkTypeFilter).toBe("function");
  });

  it("declares percentile labels for pageRank with chunkTypeFilter=function", () => {
    const d = find(CODEGRAPH_SYMBOLS_CHUNK_SIGNALS, "codegraph.chunk.pageRank");
    expect(d.stats?.labels).toEqual({
      p50: "peripheral",
      p75: "important",
      p95: "critical",
    });
    expect(d.stats?.chunkTypeFilter).toBe("function");
  });
});

describe("CODEGRAPH_SYMBOLS_FILE_SIGNALS — connectionCount support signal", () => {
  it("declares codegraph.file.connectionCount as numeric raw signal", () => {
    const d = find(CODEGRAPH_SYMBOLS_FILE_SIGNALS, "codegraph.file.connectionCount");
    expect(d.type).toBe("number");
  });

  it("connectionCount declares percentile labels", () => {
    expect(find(CODEGRAPH_SYMBOLS_FILE_SIGNALS, "codegraph.file.connectionCount").stats?.labels).toEqual({
      p25: "sparse",
      p50: "typical",
      p75: "busy",
      p95: "highly-connected",
    });
  });

  it("connectionCount declares percentilesToCompute including p10 for instability confidence", () => {
    const d = find(CODEGRAPH_SYMBOLS_FILE_SIGNALS, "codegraph.file.connectionCount");
    expect(d.stats?.percentilesToCompute).toContain(10);
  });
});

describe("CODEGRAPH_SYMBOLS_FILE_SIGNALS — instability confidence", () => {
  it("declares confidence block with connectionCount support", () => {
    const d = find(CODEGRAPH_SYMBOLS_FILE_SIGNALS, "codegraph.file.instability");
    expect(d.stats?.confidence?.support).toBe("connectionCount");
  });

  it("declares static score floor + adaptive p25 percentile", () => {
    const d = find(CODEGRAPH_SYMBOLS_FILE_SIGNALS, "codegraph.file.instability");
    expect(d.stats?.confidence?.score).toEqual({ threshold: 5, adaptivePercentile: 25 });
  });

  it("declares label clamp rules that match descriptor labels", () => {
    const d = find(CODEGRAPH_SYMBOLS_FILE_SIGNALS, "codegraph.file.instability");
    expect(d.stats?.confidence?.label?.rules).toEqual([
      { whenSupportBelow: "p10", fallback: 2, ceiling: "stable" },
      { whenSupportBelow: "p25", fallback: 5, ceiling: "mixed" },
    ]);
  });
});
