/**
 * `invokeEnrichmentMethod` — what an enrichment worker does with one `call`
 * envelope once it holds the provider. Driven with a plain provider object (the
 * `EnrichmentProvider` port), asserting what each method hands the provider and
 * what the worker answers — the contract the main-thread executor relies on.
 */

import { describe, expect, it } from "vitest";

import type { EnrichmentProvider } from "../../../../../../../src/core/contracts/types/provider.js";
import {
  enrichmentProviderCacheKey,
  invokeEnrichmentMethod,
} from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/infra/worker-invoke.js";
import type { EnrichmentCallRequest } from "../../../../../../../src/core/domains/ingest/pipeline/enrichment/infra/worker-protocol.js";

interface Recorded {
  method: string;
  root: string;
  args: unknown[];
}

function provider(over: Partial<EnrichmentProvider> = {}): { provider: EnrichmentProvider; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const record =
    (method: string, answer: unknown) =>
    async (root: string, ...args: unknown[]): Promise<never> => {
      calls.push({ method, root, args });
      return answer as never;
    };
  const base = {
    key: "fake",
    buildFileSignals: record("buildFileSignals", new Map([["a.ts", { fromBuild: true }]])),
    buildChunkSignals: record("buildChunkSignals", new Map([["a.ts", new Map()]])),
  };
  return { provider: { ...base, ...over } as unknown as EnrichmentProvider, calls };
}

function request(
  method: EnrichmentCallRequest["method"],
  over: Partial<EnrichmentCallRequest> = {},
): EnrichmentCallRequest {
  return {
    type: "call",
    providerModulePath: "/abs/provider.js",
    providerFactoryExport: "create",
    serializableConfig: {},
    method,
    root: "/repo",
    ...over,
  };
}

describe("invokeEnrichmentMethod", () => {
  it("runFileBatch builds file signals for exactly the envelope's paths when the provider cannot stream", async () => {
    const { provider: p, calls } = provider();

    const response = await invokeEnrichmentMethod(
      p,
      request("runFileBatch", { paths: ["a.ts", "b.ts"], options: { timeoutMs: 5 } as never }),
    );

    expect(calls).toEqual([
      { method: "buildFileSignals", root: "/repo", args: [{ timeoutMs: 5, paths: ["a.ts", "b.ts"] }] },
    ]);
    expect(response.fileOverlay).toEqual(new Map([["a.ts", { fromBuild: true }]]));
  });

  it("runFileBatch prefers the provider's streaming path, and an envelope without paths is an empty batch", async () => {
    const streamed = new Map([["s.ts", { streamed: true }]]);
    const calls: Recorded[] = [];
    const { provider: p } = provider({
      streamFileBatch: async (root: string, paths: string[]) => {
        calls.push({ method: "streamFileBatch", root, args: [paths] });
        return streamed;
      },
    });

    const response = await invokeEnrichmentMethod(p, request("runFileBatch"));

    expect(calls).toEqual([{ method: "streamFileBatch", root: "/repo", args: [[]] }]);
    expect(response.fileOverlay).toBe(streamed);
  });

  it("runFileSignalsRecovery always rebuilds through buildFileSignals, even for a streaming provider", async () => {
    const { provider: p, calls } = provider({
      streamFileBatch: async () => {
        throw new Error("recovery must not stream");
      },
    });

    const response = await invokeEnrichmentMethod(p, request("runFileSignalsRecovery", { paths: ["x.ts"] }));

    expect(calls.map((c) => [c.method, c.args])).toEqual([["buildFileSignals", [{ paths: ["x.ts"] }]]]);
    expect(response.fileOverlay?.size).toBe(1);
  });

  it("runChunkBatch drops the main-thread semaphore that cannot survive postMessage, keeping every other option", async () => {
    const { provider: p, calls } = provider();
    const chunkMap = new Map([["a.ts", [{ chunkId: "c1", startLine: 1, endLine: 3 }]]]) as never;

    const response = await invokeEnrichmentMethod(
      p,
      request("runChunkBatch", {
        chunkMap,
        options: { chunkConcurrency: 4, concurrencySemaphore: { permits: 2 } } as never,
      }),
    );

    expect(calls).toEqual([{ method: "buildChunkSignals", root: "/repo", args: [chunkMap, { chunkConcurrency: 4 }] }]);
    expect(response.chunkOverlay?.has("a.ts")).toBe(true);
  });

  it("runChunkBatch without a chunk map or options passes an empty map and no options", async () => {
    const { provider: p, calls } = provider();

    await invokeEnrichmentMethod(p, request("runChunkBatch"));

    expect(calls).toEqual([{ method: "buildChunkSignals", root: "/repo", args: [new Map(), undefined] }]);
  });

  it("runFinalize answers an empty overlay for a provider with nothing to finalize", async () => {
    const { provider: p, calls } = provider();

    const response = await invokeEnrichmentMethod(p, request("runFinalize"));

    expect(response).toEqual({ fileOverlay: new Map() });
    expect(calls).toEqual([]);
  });

  it("runFinalize returns what the provider's finalize pass produced", async () => {
    const finalized = new Map([["f.ts", { final: 1 }]]);
    const { provider: p } = provider({
      finalizeSignals: async () => finalized,
    });

    expect((await invokeEnrichmentMethod(p, request("runFinalize"))).fileOverlay).toBe(finalized);
  });

  it("extractFileBatch on a provider without the fan-out answers an empty extraction batch", async () => {
    const { provider: p } = provider();

    const response = await invokeEnrichmentMethod(p, request("extractFileBatch", { paths: ["a.ts"] }));

    expect(response).toEqual({ extractionBatch: { extractions: [], pass1ByLanguage: {} } });
  });

  it("absorbExtractedFiles refuses a provider that cannot absorb, instead of silently dropping the run's extractions", async () => {
    const { provider: p } = provider();

    await expect(invokeEnrichmentMethod(p, request("absorbExtractedFiles", { extractions: [] }))).rejects.toThrow(
      /no absorbExtractedFiles/,
    );
  });

  it("absorbExtractedFiles hands the provider the extractions with their pass-1 attribution and roles", async () => {
    const seen: unknown[] = [];
    const { provider: p } = provider({
      absorbExtractedFiles: async (_root: string, extractions: unknown, options: unknown) => {
        seen.push(extractions, options);
      },
    });

    const response = await invokeEnrichmentMethod(
      p,
      request("absorbExtractedFiles", { pass1ByLanguage: {}, absorbRoles: ["owner"] as never }),
    );

    expect(seen).toEqual([[], { pass1ByLanguage: {}, absorbRoles: ["owner"] }]);
    expect(response).toEqual({ fileOverlay: new Map() });
  });
});

describe("enrichmentProviderCacheKey", () => {
  it("separates language partitions of one collection, and gives stateless calls the empty slots", () => {
    const ts = enrichmentProviderCacheKey("/p.js", "code_a", "typescript");
    const rb = enrichmentProviderCacheKey("/p.js", "code_a", "ruby");

    expect(ts).not.toBe(rb);
    expect(enrichmentProviderCacheKey("/p.js")).toBe("/p.js::::");
  });
});
