/**
 * Byte-level characterization of the spill `createCodegraphExtractionSink`
 * hands to pass-2 (bd tea-rags-mcp-89k7k.35.16). The spill is an on-disk
 * contract between the pass-1 writer and the pass-2 line reader, so the exact
 * bytes — one `JSON.stringify(extraction)` per line, `\n`-terminated, written
 * extractions first in write order and cone-moved dependents after them — are
 * pinned here independent of how the sink structures its spill I/O.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { spillLiveMarkerPath } from "../../../../../../src/core/contracts/types/codegraph-spill.js";
import type { FileExtraction, GlobalSymbolTable } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  createCodegraphExtractionSink,
  type CodegraphSinkDeps,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/extraction-sink.js";
import type { SymbolNodeFlushQueue } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/node-flush.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";

const extraction = (relPath: string, language = "typescript"): FileExtraction => ({
  relPath,
  language,
  imports: [{ source: "./x.js", names: ["x"] }] as unknown as FileExtraction["imports"],
  chunks: [],
  fileScope: [],
});

const ndjson = (rows: readonly FileExtraction[]): string => rows.map((row) => `${JSON.stringify(row)}\n`).join("");

describe("createCodegraphExtractionSink spill bytes", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "extraction-sink-bytes-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeDeps(overrides: Partial<CodegraphSinkDeps> = {}): CodegraphSinkDeps {
    return {
      resolveSymbolTable: async () => ({ upsertFile: vi.fn() }) as unknown as GlobalSymbolTable,
      loadPersistedPass1Aggregates: async () => [],
      runState: new CodegraphRunState(),
      nodeFlush: {
        buffer: vi.fn(),
        dispatchRemainder: vi.fn(),
        settle: vi.fn().mockResolvedValue(undefined),
        flushRemainder: vi.fn().mockResolvedValue(undefined),
      } as unknown as SymbolNodeFlushQueue,
      buildSymbolDefs: () => [],
      buildIdentifierRows: () => [],
      indexChunkSymbolsByLine: () => undefined,
      collectionKey: (c) => c ?? "__direct__",
      spillPathFor: (_c, runId) => join(tmp, "nested", `${runId}.ndjson`),
      resolveAndUpsert: async () => undefined,
      recomputeMetrics: async () => undefined,
      ...overrides,
    };
  }

  it("hands pass-2 the written extractions then the cone-moved dependents, one JSON line each, and leaves nothing behind", async () => {
    const written = [extraction("src/a.ts"), extraction("src/b.ts"), extraction("lib/c.rb", "ruby")];
    const dependents = [extraction("src/dep1.ts"), extraction("src/dep2.ts")];
    let seenSpill: string | undefined;
    let seenSpillPath: string | undefined;
    let markerDuringPass2: string | undefined;
    const runState = new CodegraphRunState();
    const deps = makeDeps({
      runState,
      extractHierarchyDependents: async () => dependents,
      resolveAndUpsert: async (spillPath) => {
        seenSpillPath = spillPath;
        seenSpill = readFileSync(spillPath, "utf8");
        markerDuringPass2 = readFileSync(spillLiveMarkerPath(spillPath), "utf8");
      },
    });

    const sink = createCodegraphExtractionSink(deps, "run-bytes");
    const spillPath = join(tmp, "nested", "run-bytes.ndjson");
    // Lazy open: nothing exists before the first write.
    expect(existsSync(spillPath)).toBe(false);
    expect(existsSync(spillLiveMarkerPath(spillPath))).toBe(false);

    await sink.write(written[0]);
    // Claimed while open: the marker carries this process's pid.
    expect(readFileSync(spillLiveMarkerPath(spillPath), "utf8")).toBe(`${process.pid}`);
    await sink.write(written[1]);
    await sink.write(written[2]);
    await sink.finish({ recomputeMetrics: false });

    expect(seenSpillPath).toBe(spillPath);
    expect(seenSpill).toBe(ndjson([...written, ...dependents]));
    expect(markerDuringPass2).toBe(`${process.pid}`);
    expect(runState.stats.extractedFiles).toBe(written.length + dependents.length);
    expect(existsSync(spillPath)).toBe(false);
    expect(existsSync(spillLiveMarkerPath(spillPath))).toBe(false);
  });

  it("never opens a spill and never runs pass-2 when nothing was written", async () => {
    const resolveAndUpsert = vi.fn(async () => undefined);
    const extractHierarchyDependents = vi.fn(async () => [extraction("src/dep.ts")]);
    const sink = createCodegraphExtractionSink(makeDeps({ resolveAndUpsert, extractHierarchyDependents }), "run-empty");

    await sink.finish({ recomputeMetrics: false });

    expect(resolveAndUpsert).not.toHaveBeenCalled();
    expect(extractHierarchyDependents).not.toHaveBeenCalled();
    expect(existsSync(join(tmp, "nested"))).toBe(false);
  });
});
