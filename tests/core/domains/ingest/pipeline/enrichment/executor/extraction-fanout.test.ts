/**
 * ExtractionFanoutDispatcher — the split/gather half of pass-1 fan-out
 * (bd tea-rags-mcp pass1-fanout).
 *
 * The dispatcher owns everything the pool cannot: which paths still need a
 * parse this run, how they are cut into extract messages, how many of those
 * units may be in flight at once, and the order the affinity worker absorbs
 * them in. The pool underneath is faked here — these tests pin the protocol
 * the dispatcher emits, not the threading.
 */
import { describe, expect, it, vi } from "vitest";

import type { FileExtraction } from "../../../../../../../src/core/contracts/types/codegraph.js";
import { ExtractionFanoutDispatcher } from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/extraction-fanout.js";
import type {
  EnrichmentCallRequest,
  EnrichmentWorkerRequest,
  EnrichmentWorkerResponse,
} from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/infra/worker-protocol.js";

const COLLECTION = "code_test";

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

function extractionOf(relPath: string, language = "typescript"): FileExtraction {
  return { relPath, language, imports: [], chunks: [], fileScope: [] };
}

interface RecordedDispatch {
  request: EnrichmentWorkerRequest;
  routingKey: string | undefined;
}

/**
 * Fake pool: records every dispatch and answers extract requests with one
 * extraction per requested path. `hold` lets a test freeze a dispatch to
 * observe ordering / in-flight bounds.
 */
function recordingDispatch(hold?: (recorded: RecordedDispatch) => Promise<void>): {
  dispatch: (request: EnrichmentWorkerRequest, routingKey?: string) => Promise<EnrichmentWorkerResponse>;
  calls: RecordedDispatch[];
} {
  const calls: RecordedDispatch[] = [];
  const dispatch = async (request: EnrichmentWorkerRequest, routingKey?: string): Promise<EnrichmentWorkerResponse> => {
    const recorded: RecordedDispatch = { request, routingKey };
    calls.push(recorded);
    if (hold) await hold(recorded);
    if (request.type === "call" && request.method === "extractFileBatch") {
      const paths = request.paths ?? [];
      return {
        extractionBatch: {
          extractions: paths.map((p) => extractionOf(p)),
          pass1ByLanguage: { typescript: { ms: 10, files: paths.length } },
        },
      };
    }
    return {};
  };
  return { dispatch, calls };
}

function extractCalls(calls: RecordedDispatch[]): EnrichmentCallRequest[] {
  return calls
    .map((c) => c.request)
    .filter((r): r is EnrichmentCallRequest => r.type === "call" && r.method === "extractFileBatch");
}

function absorbCalls(calls: RecordedDispatch[]): EnrichmentCallRequest[] {
  return calls
    .map((c) => c.request)
    .filter((r): r is EnrichmentCallRequest => r.type === "call" && r.method === "absorbExtractedFiles");
}

function paths(count: number, prefix = "src/f"): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i}.ts`);
}

describe("ExtractionFanoutDispatcher — split", () => {
  it("cuts a batch into one shard per extraction worker, dispatched with NO routingKey", async () => {
    const { dispatch, calls } = recordingDispatch();
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 3,
      shardSize: 128,
      maxInFlightBatches: 2,
      minPathsToFanOut: 4,
    });

    await fanout.runFileBatch(baseRequest(paths(30)), COLLECTION);

    const extracts = extractCalls(calls);
    expect(extracts).toHaveLength(3);
    expect(extracts.map((r) => r.paths?.length)).toEqual([10, 10, 10]);
    // Extraction is stateless work — pinning it would put it back on the one
    // busy worker this whole mechanism exists to unload.
    for (const call of calls.filter((c) => (c.request as EnrichmentCallRequest).method === "extractFileBatch")) {
      expect(call.routingKey).toBeUndefined();
    }
  });

  it("caps a shard at shardSize so one message never carries an unbounded frame", async () => {
    const { dispatch, calls } = recordingDispatch();
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 3,
      shardSize: 16,
      maxInFlightBatches: 2,
      minPathsToFanOut: 4,
    });

    await fanout.runFileBatch(baseRequest(paths(100)), COLLECTION);

    const extracts = extractCalls(calls);
    expect(extracts.length).toBeGreaterThan(3);
    for (const request of extracts) expect(request.paths?.length).toBeLessThanOrEqual(16);
    expect(extracts.flatMap((r) => r.paths ?? [])).toHaveLength(100);
  });

  it("absorbs on the affinity worker, in the batch's own path order", async () => {
    const { dispatch, calls } = recordingDispatch();
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 4,
      shardSize: 128,
      maxInFlightBatches: 2,
      minPathsToFanOut: 4,
    });

    const batch = paths(20);
    await fanout.runFileBatch(baseRequest(batch), COLLECTION);

    const absorbs = absorbCalls(calls);
    expect(absorbs).toHaveLength(1);
    expect(absorbs[0].extractions?.map((e) => e.relPath)).toEqual(batch);
    const absorbDispatch = calls.find((c) => (c.request as EnrichmentCallRequest).method === "absorbExtractedFiles");
    expect(absorbDispatch?.routingKey).toBe(COLLECTION);
  });

  it("keeps absorb-only options off the extraction shards", async () => {
    const { dispatch, calls } = recordingDispatch();
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 3,
      shardSize: 128,
      maxInFlightBatches: 2,
      minPathsToFanOut: 4,
    });
    const contentHashes = new Map(paths(30).map((p) => [p, "sha"]));

    await fanout.runFileBatch({ ...baseRequest(paths(30)), options: { contentHashes } }, COLLECTION);

    // The hash map is one entry per repository file — cloning it into every
    // shard of every batch would cost more than the parse it rides along with.
    for (const request of extractCalls(calls)) expect(request.options).toBeUndefined();
    expect(absorbCalls(calls)[0].options?.contentHashes).toBe(contentHashes);
  });

  it("sends the batch straight to the affinity worker when it is too small to split", async () => {
    const { dispatch, calls } = recordingDispatch();
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 3,
      shardSize: 128,
      maxInFlightBatches: 2,
      minPathsToFanOut: 8,
    });

    await fanout.runFileBatch(baseRequest(paths(5)), COLLECTION);

    expect(extractCalls(calls)).toHaveLength(0);
    expect(absorbCalls(calls)).toHaveLength(0);
    expect(calls).toHaveLength(1);
    const [only] = calls;
    expect((only.request as EnrichmentCallRequest).method).toBe("runFileBatch");
    expect(only.routingKey).toBe(COLLECTION);
  });

  it("does not fan out at all when there is no spare worker", async () => {
    const { dispatch, calls } = recordingDispatch();
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 0,
      shardSize: 128,
      maxInFlightBatches: 2,
      minPathsToFanOut: 4,
    });

    await fanout.runFileBatch(baseRequest(paths(50)), COLLECTION);

    expect(extractCalls(calls)).toHaveLength(0);
    expect((calls[0].request as EnrichmentCallRequest).method).toBe("runFileBatch");
  });
});

describe("ExtractionFanoutDispatcher — per-run dedup", () => {
  it("extracts a path once per run even when several batches carry it", async () => {
    const { dispatch, calls } = recordingDispatch();
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 2,
      shardSize: 128,
      maxInFlightBatches: 2,
      minPathsToFanOut: 2,
    });

    await fanout.runFileBatch(baseRequest(["a.ts", "b.ts", "c.ts"]), COLLECTION);
    await fanout.runFileBatch(baseRequest(["b.ts", "c.ts", "d.ts", "e.ts"]), COLLECTION);

    const dispatched = extractCalls(calls).flatMap((r) => r.paths ?? []);
    expect(dispatched.slice().sort()).toEqual(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]);
  });

  it("dispatches nothing for a batch whose paths were all extracted already", async () => {
    const { dispatch, calls } = recordingDispatch();
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 2,
      shardSize: 128,
      maxInFlightBatches: 2,
      minPathsToFanOut: 2,
    });

    await fanout.runFileBatch(baseRequest(["a.ts", "b.ts"]), COLLECTION);
    const before = calls.length;
    await fanout.runFileBatch(baseRequest(["a.ts", "b.ts"]), COLLECTION);

    expect(calls).toHaveLength(before);
  });

  it("forgets the previous run's paths at beginRun", async () => {
    const { dispatch, calls } = recordingDispatch();
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 2,
      shardSize: 128,
      maxInFlightBatches: 2,
      minPathsToFanOut: 2,
    });

    await fanout.runFileBatch(baseRequest(["a.ts", "b.ts"]), COLLECTION);
    fanout.beginRun(COLLECTION);
    await fanout.runFileBatch(baseRequest(["a.ts", "b.ts"]), COLLECTION);

    expect(extractCalls(calls).flatMap((r) => r.paths ?? [])).toEqual(["a.ts", "b.ts", "a.ts", "b.ts"]);
  });

  it("keeps collections apart", async () => {
    const { dispatch, calls } = recordingDispatch();
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 2,
      shardSize: 128,
      maxInFlightBatches: 2,
      minPathsToFanOut: 2,
    });

    await fanout.runFileBatch(baseRequest(["a.ts", "b.ts"]), COLLECTION);
    const other = { ...baseRequest(["a.ts", "b.ts"]), collectionName: "code_other" };
    await fanout.runFileBatch(other, "code_other");

    expect(extractCalls(calls).flatMap((r) => r.paths ?? [])).toEqual(["a.ts", "b.ts", "a.ts", "b.ts"]);
  });
});

describe("ExtractionFanoutDispatcher — ordering and back-pressure", () => {
  it("absorbs batches in the order they were admitted, whatever order extraction finishes in", async () => {
    const gates = new Map<string, () => void>();
    const { dispatch, calls } = recordingDispatch(async (recorded) => {
      const request = recorded.request as EnrichmentCallRequest;
      if (request.method !== "extractFileBatch") return;
      const first = (request.paths ?? [])[0];
      // Batch 1's extraction is held until batch 2's has finished, so a
      // completion-ordered absorb would put batch 2 first.
      if (first === "one-0.ts") {
        await new Promise<void>((resolve) => gates.set("one", resolve));
      }
    });
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 2,
      shardSize: 128,
      maxInFlightBatches: 4,
      minPathsToFanOut: 2,
    });

    const first = fanout.runFileBatch(baseRequest(paths(4, "one-")), COLLECTION);
    const second = fanout.runFileBatch(baseRequest(paths(4, "two-")), COLLECTION);
    // Let the second batch's extraction complete first.
    await vi.waitFor(() => {
      expect(gates.has("one")).toBe(true);
    });
    await vi.waitFor(() => {
      expect(extractCalls(calls).length).toBe(4);
    });
    gates.get("one")?.();
    await Promise.all([first, second]);

    const absorbedFirstPaths = absorbCalls(calls).map((r) => (r.extractions ?? [])[0]?.relPath);
    expect(absorbedFirstPaths).toEqual(["one-0.ts", "two-0.ts"]);
  });

  it("bounds how many batches are extracted at once", async () => {
    let inFlight = 0;
    let peak = 0;
    const release: (() => void)[] = [];
    const { dispatch } = recordingDispatch(async (recorded) => {
      const request = recorded.request as EnrichmentCallRequest;
      if (request.method !== "extractFileBatch") return;
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise<void>((resolve) => release.push(resolve));
      inFlight -= 1;
    });
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 1,
      shardSize: 128,
      maxInFlightBatches: 1,
      minPathsToFanOut: 2,
    });

    const runs = [
      fanout.runFileBatch(baseRequest(paths(2, "a-")), COLLECTION),
      fanout.runFileBatch(baseRequest(paths(2, "b-")), COLLECTION),
      fanout.runFileBatch(baseRequest(paths(2, "c-")), COLLECTION),
    ];
    // Drain: each release lets exactly one held extract finish.
    for (let i = 0; i < 3; i++) {
      await vi.waitFor(() => {
        expect(release.length).toBeGreaterThan(i);
      });
      release[i]();
    }
    await Promise.all(runs);

    expect(peak).toBe(1);
  });
});

describe("ExtractionFanoutDispatcher — telemetry and failures", () => {
  it("merges shard pass-1 telemetry as parallel wall (max ms) with exact file counts", async () => {
    const calls: RecordedDispatch[] = [];
    const dispatch = async (
      request: EnrichmentWorkerRequest,
      routingKey?: string,
    ): Promise<EnrichmentWorkerResponse> => {
      calls.push({ request, routingKey });
      if (request.type === "call" && request.method === "extractFileBatch") {
        const shardPaths = request.paths ?? [];
        return {
          extractionBatch: {
            extractions: shardPaths.map((p) => extractionOf(p, p.startsWith("rb") ? "ruby" : "typescript")),
            pass1ByLanguage: shardPaths[0].startsWith("rb")
              ? { ruby: { ms: 300, files: shardPaths.length } }
              : { typescript: { ms: 100, files: shardPaths.length } },
          },
        };
      }
      return {};
    };
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 2,
      shardSize: 2,
      maxInFlightBatches: 2,
      minPathsToFanOut: 2,
    });

    await fanout.runFileBatch(baseRequest(["ts0.ts", "ts1.ts", "rb0.rb", "rb1.rb"]), COLLECTION);

    const absorb = absorbCalls(calls)[0];
    expect(absorb.pass1ByLanguage).toEqual({
      typescript: { ms: 100, files: 2 },
      ruby: { ms: 300, files: 2 },
    });
  });

  it("surfaces a failing shard instead of absorbing a partial batch", async () => {
    const calls: RecordedDispatch[] = [];
    const dispatch = async (
      request: EnrichmentWorkerRequest,
      routingKey?: string,
    ): Promise<EnrichmentWorkerResponse> => {
      calls.push({ request, routingKey });
      if (request.type === "call" && request.method === "extractFileBatch") {
        return { error: "worker exploded" };
      }
      return {};
    };
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 2,
      shardSize: 128,
      maxInFlightBatches: 2,
      minPathsToFanOut: 2,
    });

    await expect(fanout.runFileBatch(baseRequest(paths(6)), COLLECTION)).rejects.toThrow(/worker exploded/);
    expect(absorbCalls(calls)).toHaveLength(0);
  });

  // bd tea-rags-mcp-sgo8v: a shard whose dispatch REJECTS (a worker that died,
  // not one that answered with an error) must not free the batch's slot while
  // its sibling shards still parse — `maxInFlightBatches` bounds the parses
  // running at once, failing batches included.
  it("holds a failing batch's slot until every one of its shards settled", async () => {
    let releaseSlowShard!: () => void;
    const slowShardHeld = new Promise<void>((resolveHeld) => {
      releaseSlowShard = resolveHeld;
    });
    const extracting: string[] = [];
    const { dispatch } = recordingDispatch(async ({ request }) => {
      if (request.type !== "call" || request.method !== "extractFileBatch") return;
      const first = request.paths?.[0] ?? "";
      extracting.push(first);
      if (first === "a-0.ts") throw new Error("extraction worker died");
      if (first === "a-2.ts") await slowShardHeld;
    });
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 2,
      shardSize: 2,
      maxInFlightBatches: 1,
      minPathsToFanOut: 2,
    });

    let failedSettled = false;
    const failed = fanout.runFileBatch(baseRequest(paths(4, "a-")), COLLECTION).finally(() => {
      failedSettled = true;
    });
    const next = fanout.runFileBatch(baseRequest(paths(4, "b-")), COLLECTION);
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));

    expect(failedSettled).toBe(false);
    expect(extracting.filter((p) => p.startsWith("b-"))).toEqual([]);

    releaseSlowShard();
    await expect(failed).rejects.toThrow("extraction worker died");
    await next;
    expect(extracting.some((p) => p.startsWith("b-"))).toBe(true);
  });

  it("keeps absorbing later batches after one batch failed", async () => {
    let failNext = true;
    const calls: RecordedDispatch[] = [];
    const dispatch = async (
      request: EnrichmentWorkerRequest,
      routingKey?: string,
    ): Promise<EnrichmentWorkerResponse> => {
      calls.push({ request, routingKey });
      if (request.type === "call" && request.method === "extractFileBatch") {
        if (failNext) {
          failNext = false;
          return { error: "transient" };
        }
        const shardPaths = request.paths ?? [];
        return {
          extractionBatch: {
            extractions: shardPaths.map((p) => extractionOf(p)),
            pass1ByLanguage: { typescript: { ms: 1, files: shardPaths.length } },
          },
        };
      }
      return {};
    };
    const fanout = new ExtractionFanoutDispatcher(dispatch, {
      workerCount: 1,
      shardSize: 128,
      maxInFlightBatches: 1,
      minPathsToFanOut: 2,
    });

    await expect(fanout.runFileBatch(baseRequest(paths(4, "bad-")), COLLECTION)).rejects.toThrow();
    await fanout.runFileBatch(baseRequest(paths(4, "good-")), COLLECTION);

    expect(absorbCalls(calls)).toHaveLength(1);
    expect(absorbCalls(calls)[0].extractions?.map((e) => e.relPath)).toEqual(paths(4, "good-"));
  });
});
