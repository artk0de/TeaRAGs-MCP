/**
 * createCodegraphExtractionSink (bd tea-rags-mcp-6vfrj / G2) — the sink the
 * chunker writes to during pass-1: symbol persist + NDJSON spill append on
 * `write`, node-flush drain + pass-2 dispatch + spill cleanup on `finish`.
 *
 * These two error-recovery paths are new to the extracted sink and were not
 * previously reachable in isolation from the provider facade: the spill
 * stream's `end()` callback reporting a write error, and `cleanupSpill`
 * swallowing a failing `fs.rm` so a failed run never leaks NDJSON but also
 * never crashes `finish()` over housekeeping.
 */

import type * as NodeFs from "node:fs";
import { createWriteStream, mkdtempSync, rmSync, type createWriteStream as CreateWriteStream } from "node:fs";
import type * as NodeFsPromises from "node:fs/promises";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { FileExtraction, GlobalSymbolTable } from "../../../../../../src/core/contracts/types/codegraph.js";
import {
  createCodegraphExtractionSink,
  type CodegraphSinkDeps,
} from "../../../../../../src/core/domains/trajectory/codegraph/symbols/extraction-sink.js";
import type { SymbolNodeFlushQueue } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/node-flush.js";
import { CodegraphRunState } from "../../../../../../src/core/domains/trajectory/codegraph/symbols/run-state.js";
import { CodegraphSpillIoError } from "../../../../../../src/core/domains/trajectory/errors.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFsPromises>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

const extraction = (relPath: string): FileExtraction => ({
  relPath,
  language: "typescript",
  imports: [],
  chunks: [],
  fileScope: [],
});

describe("createCodegraphExtractionSink", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "extraction-sink-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    vi.mocked(createWriteStream).mockClear();
    vi.mocked(rm).mockClear();
  });

  function makeDeps(overrides: Partial<CodegraphSinkDeps> = {}): CodegraphSinkDeps {
    return {
      resolveSymbolTable: async () => ({ upsertFile: vi.fn() }) as unknown as GlobalSymbolTable,
      runState: new CodegraphRunState(),
      nodeFlush: {
        buffer: vi.fn(),
        flushRemainder: vi.fn().mockResolvedValue(undefined),
      } as unknown as SymbolNodeFlushQueue,
      buildSymbolDefs: () => [],
      indexChunkSymbolsByLine: () => undefined,
      collectionKey: (c) => c ?? "__direct__",
      spillPathFor: (_c, runId) => join(tmp, `${runId}.ndjson`),
      resolveAndUpsert: async () => undefined,
      recomputeMetrics: async () => undefined,
      ...overrides,
    };
  }

  it("finish() rejects with CodegraphSpillIoError when the spill stream's end() callback reports a write error", async () => {
    const fakeStream = {
      write: () => true,
      end: (cb?: (err?: Error | null) => void) => {
        cb?.(new Error("disk full"));
      },
    } as unknown as ReturnType<typeof CreateWriteStream>;
    vi.mocked(createWriteStream).mockReturnValueOnce(fakeStream);

    const sink = createCodegraphExtractionSink(makeDeps(), "run-end-error");
    await sink.write(extraction("src/a.ts"));

    try {
      await sink.finish();
      throw new Error("expected finish() to reject");
    } catch (err) {
      expect(err).toBeInstanceOf(CodegraphSpillIoError);
      expect((err as CodegraphSpillIoError).message).toContain("write");
    }
  });

  it("cleanupSpill swallows a failing fs.rm during finish() so the sink still resolves cleanly", async () => {
    vi.mocked(rm).mockRejectedValueOnce(new Error("EACCES: permission denied"));

    const sink = createCodegraphExtractionSink(makeDeps(), "run-rm-fails");
    await sink.write(extraction("src/b.ts"));

    // The real spill stream + a real (failing-to-remove) file: finish()
    // must resolve regardless — a failed best-effort cleanup is never a
    // reason to fail the whole ingest pass.
    await expect(sink.finish()).resolves.toBeUndefined();
    expect(rm).toHaveBeenCalled();
  });
});
