/**
 * The dispatch protocol of per-language affinity (bd tea-rags-mcp-sgo8v),
 * against a fake pool — these pin WHAT each partition's worker is asked to do
 * and in which order; `language-affinity-parity.test.ts` pins that doing it
 * reproduces the single-worker graph.
 *
 *   - file batches: parse anywhere, then absorb EVERY record on EVERY
 *     partition, in admission order per partition, each told which records it
 *     owns;
 *   - finalize: `resolve` on every partition, and `readBack` only once all of
 *     them resolved — the barrier the collection-global products need;
 *   - the deferred chunk pass: each file's chunks to the partition that walked
 *     it;
 *   - release: every partition's provider instance.
 */
import { describe, expect, it } from "vitest";

import type { FileExtraction } from "../../../../../../../src/core/contracts/types/codegraph.js";
import type { ChunkLookupEntry } from "../../../../../../../src/core/contracts/types/provider.js";
import { ExtractionFanoutDispatcher } from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/extraction-fanout.js";
import { LanguageAffinityDispatcher } from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/language-affinity-dispatch.js";
import {
  planLanguageAffinity,
  type LanguageAffinityPlan,
} from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/executor/language-affinity-plan.js";
import type {
  EnrichmentCallRequest,
  EnrichmentReleaseRequest,
  EnrichmentWorkerRequest,
  EnrichmentWorkerResponse,
} from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/infra/worker-protocol.js";

const COLLECTION = "code_mixed_v2";
const BY_EXTENSION = { ".ts": "typescript", ".rb": "ruby", ".js": "javascript" };

function languageOf(relPath: string): string {
  if (relPath.endsWith(".ts")) return "typescript";
  if (relPath.endsWith(".rb")) return "ruby";
  return "javascript";
}

function mixedPaths(ts: number, rb: number, js = 0): string[] {
  return [
    ...Array.from({ length: ts }, (_, i) => `web/t${i}.ts`),
    ...Array.from({ length: rb }, (_, i) => `app/r${i}.rb`),
    ...Array.from({ length: js }, (_, i) => `legacy/j${i}.js`),
  ];
}

function mixedPlan(): LanguageAffinityPlan {
  const plan = planLanguageAffinity({
    collectionName: COLLECTION,
    runRelPaths: mixedPaths(30, 20, 5),
    partitionByExtension: BY_EXTENSION,
    minFilesPerPartition: 10,
    maxPartitions: 2,
  });
  if (!plan) throw new Error("fixture plan must split");
  return plan;
}

function call(
  method: EnrichmentCallRequest["method"],
  extra: Partial<EnrichmentCallRequest> = {},
): EnrichmentCallRequest {
  return {
    type: "call",
    providerModulePath: "/build/provider.js",
    providerFactoryExport: "createProvider",
    serializableConfig: {},
    collectionName: COLLECTION,
    method,
    root: "/repo",
    ...extra,
  };
}

interface RecordedDispatch {
  request: EnrichmentWorkerRequest;
  routingKey: string | undefined;
}

function extractionOf(relPath: string): FileExtraction {
  return { relPath, language: languageOf(relPath), imports: [], chunks: [], fileScope: [] };
}

/** Fake pool: extraction answers one record per path; `respond` overrides the rest. */
function fakePool(
  respond: (recorded: RecordedDispatch) => Promise<EnrichmentWorkerResponse> | EnrichmentWorkerResponse = () => ({}),
): {
  dispatch: (request: EnrichmentWorkerRequest, routingKey?: string) => Promise<EnrichmentWorkerResponse>;
  calls: RecordedDispatch[];
} {
  const calls: RecordedDispatch[] = [];
  const dispatch = async (request: EnrichmentWorkerRequest, routingKey?: string): Promise<EnrichmentWorkerResponse> => {
    const recorded = { request, routingKey };
    calls.push(recorded);
    if (request.type === "call" && request.method === "extractFileBatch") {
      const paths = request.paths ?? [];
      const telemetry: Record<string, { ms: number; files: number }> = {};
      for (const p of paths) {
        const language = languageOf(p);
        telemetry[language] = { ms: 7, files: (telemetry[language]?.files ?? 0) + 1 };
      }
      return { extractionBatch: { extractions: paths.map(extractionOf), pass1ByLanguage: telemetry } };
    }
    return respond(recorded);
  };
  return { dispatch, calls };
}

function calls(recorded: RecordedDispatch[], method: EnrichmentCallRequest["method"]): RecordedDispatch[] {
  return recorded.filter((r) => r.request.type === "call" && r.request.method === method);
}

function fanoutOver(
  dispatch: (request: EnrichmentWorkerRequest, routingKey?: string) => Promise<EnrichmentWorkerResponse>,
): ExtractionFanoutDispatcher {
  return new ExtractionFanoutDispatcher(dispatch, {
    workerCount: 2,
    shardSize: 128,
    maxInFlightBatches: 2,
    minPathsToFanOut: 16,
  });
}

describe("ExtractionFanoutDispatcher — partitioned file batches", () => {
  it("parses with no routing key, then absorbs every record on every partition, owning its own", async () => {
    const plan = mixedPlan();
    const { dispatch, calls: recorded } = fakePool();
    const batch = mixedPaths(12, 10, 2);

    await fanoutOver(dispatch).runPartitionedFileBatch(call("runFileBatch", { paths: batch }), plan);

    for (const extract of calls(recorded, "extractFileBatch")) expect(extract.routingKey).toBeUndefined();
    const absorbs = calls(recorded, "absorbExtractedFiles");
    expect(absorbs.map((a) => a.routingKey).sort()).toEqual(plan.partitions.map((p) => p.routingKey).sort());
    for (const absorb of absorbs) {
      const request = absorb.request as EnrichmentCallRequest;
      const partition = plan.partitions.find((p) => p.routingKey === absorb.routingKey);
      expect(request.affinityPartition).toBe(partition?.label);
      // Every record, in the batch's own order — the order a single worker
      // would have absorbed them in, so last-write-wins maps agree.
      expect(request.extractions?.map((e) => e.relPath)).toEqual(batch);
      expect(request.absorbRoles).toEqual(batch.map((p) => (plan.partitionOfPath(p) === partition ? "own" : "mirror")));
    }
  });

  it("splits even a batch too small to fan out — the records are what every partition needs", async () => {
    const plan = mixedPlan();
    const { dispatch, calls: recorded } = fakePool();

    await fanoutOver(dispatch).runPartitionedFileBatch(call("runFileBatch", { paths: mixedPaths(2, 1) }), plan);

    expect(calls(recorded, "runFileBatch")).toHaveLength(0);
    expect(calls(recorded, "extractFileBatch").length).toBeGreaterThan(0);
    expect(calls(recorded, "absorbExtractedFiles")).toHaveLength(plan.partitions.length);
  });

  it("hands each partition only its own languages' pass-1 attribution", async () => {
    const plan = mixedPlan();
    const { dispatch, calls: recorded } = fakePool();

    await fanoutOver(dispatch).runPartitionedFileBatch(call("runFileBatch", { paths: mixedPaths(12, 10, 2) }), plan);

    for (const absorb of calls(recorded, "absorbExtractedFiles")) {
      const request = absorb.request as EnrichmentCallRequest;
      const partition = plan.partitions.find((p) => p.label === request.affinityPartition);
      expect(Object.keys(request.pass1ByLanguage ?? {}).sort()).toEqual([...(partition?.languages ?? [])].sort());
    }
  });

  it("orders absorbs per partition, and never makes one partition wait for another", async () => {
    const plan = mixedPlan();
    const [lead, rest] = plan.partitions;
    let releaseLeadFirst!: () => void;
    const leadFirstHeld = new Promise<void>((resolveHeld) => {
      releaseLeadFirst = resolveHeld;
    });
    const absorbOrder: string[] = [];
    let leadAbsorbs = 0;
    const { dispatch } = fakePool(async ({ request, routingKey }) => {
      if (request.type !== "call" || request.method !== "absorbExtractedFiles") return {};
      const unit = request.extractions?.[0]?.relPath ?? "";
      if (routingKey === lead.routingKey && leadAbsorbs++ === 0) await leadFirstHeld;
      absorbOrder.push(`${routingKey === lead.routingKey ? "lead" : "rest"}:${unit}`);
      return {};
    });
    const fanout = fanoutOver(dispatch);

    const first = fanout.runPartitionedFileBatch(call("runFileBatch", { paths: ["web/a.ts", "app/a.rb"] }), plan);
    const second = fanout.runPartitionedFileBatch(call("runFileBatch", { paths: ["web/b.ts", "app/b.rb"] }), plan);
    // While the lead partition is stuck on the first unit, the rest partition
    // absorbs both — it owes the lead nothing.
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    expect(absorbOrder).toEqual(["rest:web/a.ts", "rest:web/b.ts"]);
    releaseLeadFirst();
    await Promise.all([first, second]);

    expect(absorbOrder.filter((e) => e.startsWith("lead:"))).toEqual(["lead:web/a.ts", "lead:web/b.ts"]);
    expect(rest.routingKey).not.toBe(lead.routingKey);
  });

  // One partition's absorb failing must not let the unit give its slot and its
  // chain places back while a sibling partition is still absorbing: the next
  // unit would then parse while this one's records are still resident
  // (`maxInFlightBatches`) and absorb on the slow partition ahead of it.
  it("holds the slot and every partition's place until all absorbs settled, then surfaces the failure", async () => {
    const plan = mixedPlan();
    const [lead, rest] = plan.partitions;
    let releaseRestFirst!: () => void;
    const restFirstHeld = new Promise<void>((resolveHeld) => {
      releaseRestFirst = resolveHeld;
    });
    const events: string[] = [];
    let restAbsorbs = 0;
    const { dispatch } = fakePool(async ({ request, routingKey }) => {
      if (request.type !== "call" || request.method !== "absorbExtractedFiles") return {};
      const unit = request.extractions?.[0]?.relPath ?? "";
      if (routingKey === lead.routingKey && unit === "web/a.ts") throw new Error("lead absorb failed");
      if (routingKey === rest.routingKey && restAbsorbs++ === 0) await restFirstHeld;
      events.push(`${routingKey === lead.routingKey ? "lead" : "rest"}:${unit}`);
      return {};
    });
    const fanout = new ExtractionFanoutDispatcher(
      async (request, routingKey) => {
        if (request.type === "call" && request.method === "extractFileBatch") {
          for (const path of request.paths ?? []) events.push(`extract:${path}`);
        }
        return dispatch(request, routingKey);
      },
      { workerCount: 2, shardSize: 128, maxInFlightBatches: 1, minPathsToFanOut: 16 },
    );

    let firstSettled = false;
    const first = fanout
      .runPartitionedFileBatch(call("runFileBatch", { paths: ["web/a.ts", "app/a.rb"] }), plan)
      .finally(() => {
        firstSettled = true;
      });
    const second = fanout.runPartitionedFileBatch(call("runFileBatch", { paths: ["web/b.ts", "app/b.rb"] }), plan);
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));

    // The lead partition failed, the rest partition is still absorbing unit 1:
    // unit 1 has not settled, and unit 2 has not even been parsed.
    expect(firstSettled).toBe(false);
    expect(events.filter((e) => e.includes("/b."))).toEqual([]);

    releaseRestFirst();
    await expect(first).rejects.toThrow("lead absorb failed");
    await second;
    const unitTwoStarts = events.findIndex((e) => e.includes("/b."));
    expect(events.indexOf("rest:web/a.ts")).toBeLessThan(unitTwoStarts);
    expect(events.filter((e) => e.startsWith("rest:"))).toEqual(["rest:web/a.ts", "rest:web/b.ts"]);
  });

  it("parses a path once per run whichever partitions it feeds", async () => {
    const plan = mixedPlan();
    const { dispatch, calls: recorded } = fakePool();
    const fanout = fanoutOver(dispatch);

    await fanout.runPartitionedFileBatch(call("runFileBatch", { paths: mixedPaths(3, 3) }), plan);
    await fanout.runPartitionedFileBatch(call("runFileBatch", { paths: mixedPaths(3, 3) }), plan);

    const parsed = calls(recorded, "extractFileBatch").flatMap((c) => (c.request as EnrichmentCallRequest).paths ?? []);
    expect(parsed.sort()).toEqual(mixedPaths(3, 3).sort());
  });
});

describe("LanguageAffinityDispatcher — finalize barrier", () => {
  it("reads back only after EVERY partition resolved; the completion owner alone recomputes", async () => {
    const plan = mixedPlan();
    const [lead] = plan.partitions;
    let releaseLead!: () => void;
    const leadHeld = new Promise<void>((resolveHeld) => {
      releaseLead = resolveHeld;
    });
    const { dispatch, calls: recorded } = fakePool(async ({ request, routingKey }) => {
      if (request.type !== "call") return {};
      const stage = (request.options as { finalizeStage?: string } | undefined)?.finalizeStage;
      if (stage === "resolve" && routingKey === lead.routingKey) await leadHeld;
      if (stage === "readBack") {
        const own = request.affinityPartition ?? "";
        return { fileOverlay: new Map([[`${own}.file`, { fanIn: 1 }]]) };
      }
      return { fileOverlay: new Map() };
    });
    const dispatcher = new LanguageAffinityDispatcher(dispatch);

    const finalize = dispatcher.runFinalize(call("runFinalize", { options: { runCoverage: "wholeCorpus" } }), plan);
    await new Promise((resolveTick) => setTimeout(resolveTick, 20));
    const stagesBeforeLeadResolved = calls(recorded, "runFinalize").map(
      (c) => (c.request as EnrichmentCallRequest).options as { finalizeStage?: string },
    );
    expect(stagesBeforeLeadResolved.every((o) => o.finalizeStage === "resolve")).toBe(true);
    expect(stagesBeforeLeadResolved).toHaveLength(plan.partitions.length);

    releaseLead();
    const response = await finalize;

    const readBacks = calls(recorded, "runFinalize").filter(
      (c) => ((c.request as EnrichmentCallRequest).options as { finalizeStage?: string }).finalizeStage === "readBack",
    );
    expect(readBacks.map((r) => r.routingKey).sort()).toEqual(plan.partitions.map((p) => p.routingKey).sort());
    for (const readBack of readBacks) {
      const request = readBack.request as EnrichmentCallRequest;
      const options = request.options as { ownsCollectionCompletion?: boolean; runCoverage?: string };
      expect(options.ownsCollectionCompletion).toBe(readBack.routingKey === plan.completionOwner.routingKey);
      // The caller's options ride along untouched.
      expect(options.runCoverage).toBe("wholeCorpus");
    }
    expect([...(response.fileOverlay?.keys() ?? [])].sort()).toEqual(
      plan.partitions.map((p) => `${p.label}.file`).sort(),
    );
  });

  it("runs the completion owner's readBack — the metric recompute — with nothing else on the connection", async () => {
    // The recompute drains the edge tables through a streaming read, and a
    // DuckDB stream is invalidated by ANY other statement on its connection:
    // probed, 3000 edges drained alone, 2048 with a concurrent read — silently
    // truncated to the first chunk. Every partition shares one connection.
    const plan = mixedPlan();
    let inFlight = 0;
    let concurrentWithOwnerReadBack = -1;
    const { dispatch } = fakePool(async ({ request, routingKey }) => {
      if (request.type !== "call") return {};
      inFlight += 1;
      const stage = (request.options as { finalizeStage?: string } | undefined)?.finalizeStage;
      if (stage === "readBack" && routingKey === plan.completionOwner.routingKey) {
        concurrentWithOwnerReadBack = inFlight - 1;
      }
      await new Promise((resolveTick) => setTimeout(resolveTick, 5));
      inFlight -= 1;
      return { fileOverlay: new Map() };
    });

    await new LanguageAffinityDispatcher(dispatch).runFinalize(call("runFinalize"), plan);

    expect(concurrentWithOwnerReadBack).toBe(0);
  });

  it("never reads back when a partition failed to resolve, and surfaces that failure after the others settle", async () => {
    const plan = mixedPlan();
    const [lead, rest] = plan.partitions;
    let restSettled = false;
    const { dispatch, calls: recorded } = fakePool(async ({ request, routingKey }) => {
      if (request.type !== "call") return {};
      if (routingKey === lead.routingKey) throw new Error("Worker error: lead resolve failed");
      await new Promise((resolveTick) => setTimeout(resolveTick, 10));
      if (routingKey === rest.routingKey) restSettled = true;
      return { fileOverlay: new Map() };
    });

    await expect(new LanguageAffinityDispatcher(dispatch).runFinalize(call("runFinalize"), plan)).rejects.toThrow(
      /lead resolve failed/,
    );
    expect(restSettled).toBe(true);
    const stages = calls(recorded, "runFinalize").map(
      (c) => ((c.request as EnrichmentCallRequest).options as { finalizeStage?: string }).finalizeStage,
    );
    expect(stages).not.toContain("readBack");
  });
});

describe("LanguageAffinityDispatcher — deferred chunk pass and release", () => {
  it("sends each file's chunks to the partition that walked it, a file of no language to the completion owner", async () => {
    const plan = mixedPlan();
    const { dispatch, calls: recorded } = fakePool(({ request }) => {
      if (request.type !== "call") return {};
      const out = new Map([...(request.chunkMap?.keys() ?? [])].map((p) => [p, new Map([[`${p}#c`, { fanIn: 0 }]])]));
      return { chunkOverlay: out };
    });
    const chunk = (relPath: string): ChunkLookupEntry[] => [{ chunkId: `${relPath}#c`, startLine: 1, endLine: 2 }];
    const chunkMap = new Map(["web/t1.ts", "app/r1.rb", "legacy/j1.js", "README.md"].map((p) => [p, chunk(p)]));

    const response = await new LanguageAffinityDispatcher(dispatch).runChunkBatch(
      call("runChunkBatch", { chunkMap }),
      plan,
    );

    const routed = new Map(
      calls(recorded, "runChunkBatch").map((c) => [
        c.routingKey,
        [...((c.request as EnrichmentCallRequest).chunkMap?.keys() ?? [])].sort(),
      ]),
    );
    expect(routed.get(plan.partitionOfPath("web/t1.ts").routingKey)).toEqual(["web/t1.ts"]);
    expect(routed.get(plan.completionOwner.routingKey)).toEqual(["README.md", "app/r1.rb", "legacy/j1.js"]);
    expect([...(response.chunkOverlay?.keys() ?? [])].sort()).toEqual([...chunkMap.keys()].sort());
  });

  it("releases every partition's provider instance", async () => {
    const plan = mixedPlan();
    const { dispatch, calls: recorded } = fakePool(() => ({ released: true }));

    await new LanguageAffinityDispatcher(dispatch).release("/build/provider.js", COLLECTION, plan);

    const releases = recorded.filter((r) => r.request.type === "release");
    expect(releases.map((r) => r.routingKey).sort()).toEqual(plan.partitions.map((p) => p.routingKey).sort());
    expect(releases.map((r) => (r.request as EnrichmentReleaseRequest).affinityPartition).sort()).toEqual(
      plan.partitions.map((p) => p.label).sort(),
    );
  });
});
