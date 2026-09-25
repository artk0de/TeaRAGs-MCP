/**
 * CodegraphRunState (bd tea-rags-mcp-6vfrj / G2) — per-run state extracted
 * from `CodegraphEnrichmentProvider` so one object owns the lifecycle of the
 * run-global aggregation maps + resolve tally.
 */

import { describe, expect, it, vi } from "vitest";

import { EMPTY_RESOLVE_DENOMINATOR_MARKER } from "../../../../../../src/core/contracts/resolve-rate.js";
import type { FileExtraction } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  CodegraphRunState,
  languageKindTally,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

describe("CodegraphRunState.absorb", () => {
  it("merges classPrependedAncestors and ivarTypes from a file extraction into the run-global maps", () => {
    const runState = new CodegraphRunState();
    const extraction: FileExtraction = {
      relPath: "app/models/post.rb",
      language: "ruby",
      imports: [],
      chunks: [],
      fileScope: [],
      classPrependedAncestors: { Post: ["Taggable"] },
      ivarTypes: { Post: { "@author": "User" } },
    };

    runState.absorb(extraction, []);

    expect(runState.prependedAncestors).toEqual({ Post: ["Taggable"] });
    expect(runState.ivarTypes).toEqual({ Post: { "@author": "User" } });
  });

  it("leaves the run-global maps untouched when a file extraction carries no prepended-ancestor or ivar data", () => {
    const runState = new CodegraphRunState();
    const extraction: FileExtraction = {
      relPath: "app/models/comment.rb",
      language: "ruby",
      imports: [],
      chunks: [],
      fileScope: [],
    };

    runState.absorb(extraction, []);

    expect(runState.prependedAncestors).toEqual({});
    expect(runState.ivarTypes).toEqual({});
  });
});

describe("CodegraphRunState.drainMetrics", () => {
  it("reports null resolveSuccessRate and inProjectEdgeRecall for a run that extracted files/edges but attempted no calls", () => {
    const runState = new CodegraphRunState();
    // A file with only file-edges (bare imports, no method calls) keeps
    // fileEdgeCount > 0 so drainMetrics takes the real-run branch rather
    // than the wide empty-run reset (which reports undefined instead).
    runState.stats.extractedFiles = 1;
    runState.stats.fileEdgeCount = 1;

    const metrics = runState.drainMetrics();

    expect(metrics).toBeDefined();
    // bd tea-rags-mcp-stpvj — nothing scored is null, not 0.
    expect(metrics?.resolveSuccessRate).toBeNull();
    expect(metrics?.inProjectEdgeRecall).toBeNull();
    expect(metrics?.fileEdgeCount).toBe(1);
  });

  // bd tea-rags-mcp-stpvj — every attempted call fell into an excluded bucket:
  // the old `max(1, …)` guard turned the empty denominator into a 0 rate, both
  // in the run result and in the stderr diagnostic line.
  it("reports null rates and logs the marker when every attempted call was excluded", () => {
    const runState = new CodegraphRunState();
    runState.stats.extractedFiles = 1;
    runState.stats.methodEdgeCount = 0;
    runState.stats.fileEdgeCount = 1;
    runState.stats.callsAttempted = 6;
    runState.stats.callsNoInProjectDef = 4;
    runState.stats.callsExternalSkipped = 2;
    const kinds = languageKindTally(runState.stats, "swift");
    kinds.index.attempted = 6;
    kinds.index.noInProjectDef = 4;
    kinds.index.externalSkipped = 2;
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    let metrics: ReturnType<CodegraphRunState["drainMetrics"]>;
    try {
      metrics = runState.drainMetrics();
    } finally {
      spy.mockRestore();
    }

    expect(metrics?.resolveSuccessRate).toBeNull();
    expect(metrics?.inProjectEdgeRecall).toBeNull();
    const line = writes.find((w) => w.includes("[codegraph] resolve by receiver-kind"));
    expect(line).toContain(`(rate ${EMPTY_RESOLVE_DENOMINATOR_MARKER}, `);
  });

  it("keeps a scored zero as 0 in the run result and the stderr line", () => {
    const runState = new CodegraphRunState();
    runState.stats.extractedFiles = 1;
    runState.stats.fileEdgeCount = 1;
    runState.stats.callsAttempted = 3;
    const kinds = languageKindTally(runState.stats, "swift");
    kinds.index.attempted = 3;
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });

    let metrics: ReturnType<CodegraphRunState["drainMetrics"]>;
    try {
      metrics = runState.drainMetrics();
    } finally {
      spy.mockRestore();
    }

    expect(metrics?.resolveSuccessRate).toBe(0);
    expect(metrics?.inProjectEdgeRecall).toBe(0);
    const byKind = metrics?.resolveByReceiverKind as Record<string, { rate: number | null }>;
    expect(byKind.index.rate).toBe(0);
    expect(writes.find((w) => w.includes("[codegraph] resolve by receiver-kind"))).toContain("(rate 0.00, ");
  });

  it("reports a null per-receiver-kind rate for a kind with no attempted call", () => {
    const runState = new CodegraphRunState();
    runState.stats.extractedFiles = 1;
    runState.stats.fileEdgeCount = 1;

    const metrics = runState.drainMetrics();

    const byKind = metrics?.resolveByReceiverKind as Record<string, { attempted: number; rate: number | null }>;
    expect(byKind.dynamic).toEqual({ attempted: 0, resolved: 0, rate: null });
  });

  it("resets the tally to empty stats after draining, so a second drain of an untouched run reports undefined", () => {
    const runState = new CodegraphRunState();
    runState.stats.extractedFiles = 1;
    runState.stats.fileEdgeCount = 1;

    runState.drainMetrics();

    expect(runState.drainMetrics()).toBeUndefined();
  });
});

describe("CodegraphRunState extracted-file volume (bd tea-rags-mcp-6aytq)", () => {
  function extractionOf(relPath: string, language: string): FileExtraction {
    return { relPath, language, imports: [], chunks: [], fileScope: [] };
  }

  it("tallies absorbed files per language, so pass-2 knows its volume before it starts", () => {
    const runState = new CodegraphRunState();

    runState.absorb(extractionOf("src/a.ts", "typescript"), []);
    runState.absorb(extractionOf("src/b.ts", "typescript"), []);
    runState.absorb(extractionOf("app/models/user.rb", "ruby"), []);

    expect(runState.extractedFilesByLanguage.get("typescript")).toBe(2);
    expect(runState.extractedFilesByLanguage.get("ruby")).toBe(1);
  });

  it("ignores the defensive empty extraction, which carries no language", () => {
    const runState = new CodegraphRunState();

    runState.absorb(extractionOf("", ""), []);

    expect(runState.extractedFilesByLanguage.size).toBe(0);
  });

  it("keeps each language's file LIST, not only its count, so a resolver can root its caches at the run's corpus", () => {
    // bd tea-rags-mcp-6aytq: TypeScript's whole-project Program is built from
    // the tsconfig's world, which on taxdome misses 936 of the run's own files.
    // The count says a bulk pass is coming; the list says which files it is.
    const runState = new CodegraphRunState();

    runState.absorb(extractionOf("src/a.ts", "typescript"), []);
    runState.absorb(extractionOf("src/b.ts", "typescript"), []);
    runState.absorb(extractionOf("app/models/user.rb", "ruby"), []);

    expect(runState.extractedRelPathsByLanguage.get("typescript")).toEqual(["src/a.ts", "src/b.ts"]);
    expect(runState.extractedRelPathsByLanguage.get("ruby")).toEqual(["app/models/user.rb"]);
    expect(runState.extractedRelPathsByLanguage.has("")).toBe(false);
  });

  it("forgets the tally at both run-release seams", () => {
    const forNextRun = new CodegraphRunState();
    forNextRun.absorb(extractionOf("src/a.ts", "typescript"), []);
    forNextRun.clearForNextRun();

    const onRelease = new CodegraphRunState();
    onRelease.absorb(extractionOf("src/a.ts", "typescript"), []);
    onRelease.clearAll();

    expect(forNextRun.extractedFilesByLanguage.size).toBe(0);
    expect(onRelease.extractedFilesByLanguage.size).toBe(0);
    expect(forNextRun.extractedRelPathsByLanguage.size).toBe(0);
    expect(onRelease.extractedRelPathsByLanguage.size).toBe(0);
  });
});
