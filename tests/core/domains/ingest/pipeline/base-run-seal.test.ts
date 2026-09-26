/**
 * BaseIndexingPipeline.sealRun / completePipeline — the one closing skeleton
 * both pipelines share (bd tea-rags-mcp-7njy).
 *
 * The order is the invariant: promote the collection (alias) BEFORE the
 * completion marker, persist run state after it, record the registry entry
 * last. A promote failure must leave no marker behind — otherwise the
 * collection is marked complete while the alias still points at the previous
 * version (operations/CLAUDE.md).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { fixturePhysicalCollectionName } from "../../../__helpers__/collection-identity.js";
import {
  BaseIndexingPipeline,
  type EnrichmentStatusResult,
  type IndexingRunSealSpec,
  type ProcessingContext,
} from "../../../../../src/core/domains/ingest/pipeline/base.js";
import type * as IndexingMarkerModule from "../../../../../src/core/domains/ingest/pipeline/indexing-marker.js";
import type { ChunkLookupEntry } from "../../../../../src/core/types.js";

const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock("../../../../../src/core/domains/ingest/pipeline/indexing-marker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof IndexingMarkerModule>();
  return {
    ...actual,
    storeIndexingMarker: vi.fn(
      async (_q: unknown, _e: unknown, name: string, complete: boolean, modelInfo?: unknown) => {
        calls.push(`marker:${name}:${complete}:${modelInfo === undefined ? "-" : "model"}`);
      },
    ),
  };
});

class SealProbePipeline extends BaseIndexingPipeline {
  constructor() {
    super({} as never, {} as never, {} as never, {} as never, { snapshotDir: "/tmp" } as never);
  }

  async seal(spec: IndexingRunSealSpec): Promise<void> {
    await this.sealRun(spec);
  }

  async complete(spec: IndexingRunSealSpec, onFlushed?: () => void): Promise<EnrichmentStatusResult> {
    return this.completePipeline({} as ProcessingContext, new Map<string, ChunkLookupEntry[]>(), spec, onFlushed);
  }

  protected override async finalizeProcessing(): Promise<() => EnrichmentStatusResult> {
    calls.push("flush");
    return () => {
      calls.push("status");
      return { status: "completed" };
    };
  }

  protected override async recordRegistryEntry(collectionName: string, absolutePath: string): Promise<void> {
    calls.push(`registry:${collectionName}:${absolutePath}`);
  }
}

const target = fixturePhysicalCollectionName("code_abc_v2");

function sealSpec(overrides: Partial<IndexingRunSealSpec> = {}): IndexingRunSealSpec {
  return {
    targetCollection: target,
    collectionAlias: "code_abc",
    absolutePath: "/repo",
    persist: async () => {
      calls.push("persist");
    },
    ...overrides,
  };
}

describe("BaseIndexingPipeline.sealRun", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("promotes before the marker, persists after it, and records the registry last", async () => {
    await new SealProbePipeline().seal(
      sealSpec({
        promote: async () => {
          calls.push("promote");
        },
      }),
    );

    expect(calls).toEqual(["promote", "marker:code_abc_v2:true:-", "persist", "registry:code_abc:/repo"]);
  });

  it("runs without a promote step, marking the physical target and registering the alias", async () => {
    await new SealProbePipeline().seal(sealSpec());

    expect(calls).toEqual(["marker:code_abc_v2:true:-", "persist", "registry:code_abc:/repo"]);
  });

  it("carries the resolved model info onto the completion marker", async () => {
    await new SealProbePipeline().seal(sealSpec({ modelInfo: { model: "m", contextLength: 512, dimensions: 384 } }));

    expect(calls[0]).toBe("marker:code_abc_v2:true:model");
  });

  it("writes no marker, no run state and no registry entry when promotion fails", async () => {
    const failure = new Error("alias switch failed");

    await expect(
      new SealProbePipeline().seal(
        sealSpec({
          promote: async () => {
            throw failure;
          },
        }),
      ),
    ).rejects.toBe(failure);

    expect(calls).toEqual([]);
  });
});

describe("BaseIndexingPipeline.completePipeline", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("flushes, runs the flushed hook, seals, then reads the enrichment status", async () => {
    const result = await new SealProbePipeline().complete(sealSpec(), () => {
      calls.push("flushed");
    });

    expect(result).toEqual({ status: "completed" });
    expect(calls).toEqual([
      "flush",
      "flushed",
      "marker:code_abc_v2:true:-",
      "persist",
      "registry:code_abc:/repo",
      "status",
    ]);
  });
});
