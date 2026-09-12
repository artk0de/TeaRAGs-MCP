/**
 * Fan-out width bound by the run's size (bd tea-rags-mcp-1v12o.2).
 *
 * Spreading pass-1 over the idle workers pays on a large corpus (measured on
 * taxdome) and loses on a small one: each extra thread is an isolate plus a
 * module load (~200 ms, tens of MB) against ~0.4-2 s of parse work only if the
 * thread actually receives ~400 files. A 234-file run has no such share to
 * give, so its width collapses to the affinity worker alone.
 *
 * The pool underneath is faked here — these tests pin the width decision, not
 * the threading.
 */
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../../src/core/contracts/types/codegraph.js";
import {
  ExtractionFanoutDispatcher,
  extractionFanoutWorkerCount,
} from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/extraction-fanout.js";
import type {
  EnrichmentCallRequest,
  EnrichmentWorkerRequest,
  EnrichmentWorkerResponse,
} from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/infra/worker-protocol.js";

const COLLECTION = "code_test";
const FILES_PER_THREAD = 400;

function baseRequest(paths: string[]): EnrichmentCallRequest {
  return {
    type: "call",
    providerModulePath: "/build/provider.js",
    providerFactoryExport: "createProvider",
    serializableConfig: {},
    collectionName: COLLECTION,
    method: "runFileBatch",
    root: "/repo",
    paths,
  };
}

function extractionOf(relPath: string): FileExtraction {
  return { relPath, language: "python", imports: [], chunks: [], fileScope: [] };
}

interface RecordedDispatch {
  request: EnrichmentWorkerRequest;
  routingKey: string | undefined;
}

function recordingDispatch(): {
  dispatch: (request: EnrichmentWorkerRequest, routingKey?: string) => Promise<EnrichmentWorkerResponse>;
  calls: RecordedDispatch[];
} {
  const calls: RecordedDispatch[] = [];
  const dispatch = async (request: EnrichmentWorkerRequest, routingKey?: string): Promise<EnrichmentWorkerResponse> => {
    calls.push({ request, routingKey });
    if (request.type === "call" && request.method === "extractFileBatch") {
      const paths = request.paths ?? [];
      return {
        extractionBatch: {
          extractions: paths.map((p) => extractionOf(p)),
          pass1ByLanguage: { python: { ms: 1, files: paths.length } },
        },
      };
    }
    return {};
  };
  return { dispatch, calls };
}

function methodCalls(calls: RecordedDispatch[], method: string): RecordedDispatch[] {
  return calls.filter((c) => c.request.type === "call" && c.request.method === method);
}

function paths(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `src/f${i}.py`);
}

describe("extractionFanoutWorkerCount", () => {
  it("leaves the width at the configured ceiling when the run size is unknown", () => {
    expect(extractionFanoutWorkerCount(undefined, FILES_PER_THREAD, 3)).toBe(3);
    expect(extractionFanoutWorkerCount(0, FILES_PER_THREAD, 3)).toBe(3);
  });

  it("spins no extra thread for a run smaller than one thread's share", () => {
    expect(extractionFanoutWorkerCount(234, FILES_PER_THREAD, 3)).toBe(0);
    expect(extractionFanoutWorkerCount(400, FILES_PER_THREAD, 3)).toBe(0);
  });

  it("never drops below the one thread the run always has", () => {
    expect(extractionFanoutWorkerCount(1, FILES_PER_THREAD, 3)).toBe(0);
  });

  it("widens with the run", () => {
    expect(extractionFanoutWorkerCount(401, FILES_PER_THREAD, 3)).toBe(1);
    expect(extractionFanoutWorkerCount(1000, FILES_PER_THREAD, 3)).toBe(2);
  });

  it("respects the configured ceiling however large the run", () => {
    expect(extractionFanoutWorkerCount(19_000, FILES_PER_THREAD, 3)).toBe(3);
    expect(extractionFanoutWorkerCount(19_000, FILES_PER_THREAD, 0)).toBe(0);
  });

  it("treats a non-positive per-thread share as the bound switched off", () => {
    expect(extractionFanoutWorkerCount(234, 0, 3)).toBe(3);
  });
});

describe("ExtractionFanoutDispatcher — width bound by run size", () => {
  const dispatcher = (recorder: ReturnType<typeof recordingDispatch>) =>
    new ExtractionFanoutDispatcher(recorder.dispatch, {
      workerCount: 3,
      shardSize: 128,
      maxInFlightBatches: 2,
      minPathsToFanOut: 16,
      filesPerThread: FILES_PER_THREAD,
    });

  it("sends a small run's batch whole to the affinity worker", async () => {
    const recorder = recordingDispatch();
    const fanout = dispatcher(recorder);
    fanout.beginRun(COLLECTION, 234);

    await fanout.runFileBatch(baseRequest(paths(40)), COLLECTION);

    expect(methodCalls(recorder.calls, "extractFileBatch")).toHaveLength(0);
    const passthrough = methodCalls(recorder.calls, "runFileBatch");
    expect(passthrough).toHaveLength(1);
    expect(passthrough[0].routingKey).toBe(COLLECTION);
  });

  it("uses the configured width for a run big enough to earn it", async () => {
    const recorder = recordingDispatch();
    const fanout = dispatcher(recorder);
    fanout.beginRun(COLLECTION, 4_000);

    await fanout.runFileBatch(baseRequest(paths(40)), COLLECTION);

    const extracts = methodCalls(recorder.calls, "extractFileBatch");
    expect(extracts).toHaveLength(3);
    expect(extracts.every((c) => c.routingKey === undefined)).toBe(true);
    expect(methodCalls(recorder.calls, "absorbExtractedFiles")).toHaveLength(1);
  });

  it("keeps the configured width when the run never reported its size", async () => {
    const recorder = recordingDispatch();
    const fanout = dispatcher(recorder);
    fanout.beginRun(COLLECTION);

    await fanout.runFileBatch(baseRequest(paths(40)), COLLECTION);

    expect(methodCalls(recorder.calls, "extractFileBatch")).toHaveLength(3);
  });

  it("re-narrows on the next run: width is per run, not per process", async () => {
    const recorder = recordingDispatch();
    const fanout = dispatcher(recorder);

    fanout.beginRun(COLLECTION, 4_000);
    await fanout.runFileBatch(baseRequest(paths(40)), COLLECTION);
    fanout.beginRun(COLLECTION, 234);
    await fanout.runFileBatch(baseRequest(paths(40)), COLLECTION);

    expect(methodCalls(recorder.calls, "extractFileBatch")).toHaveLength(3);
    expect(methodCalls(recorder.calls, "runFileBatch")).toHaveLength(1);
  });
});
