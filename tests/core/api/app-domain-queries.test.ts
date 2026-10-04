/**
 * App-level tests for the two domain runtime queries the interface surfaces by
 * Uniform Access (bd tea-rags-mcp-89k7k.9): language-capability resolution
 * (`domains/language/capability`) and the collection build-lease predicate
 * (`domains/ingest/infra`, reached through `ProjectRegistryOps`, the registry's
 * collection-claimed oracle). The App methods must behave exactly as the free
 * domain functions did — same params, same returns — which is what retiring
 * the api/public barrel VALUE re-exports promised consumers.
 *
 * The lease assertions mirror
 * `tests/core/domains/ingest/infra/collection-build-lease.test.ts`; the
 * capability assertions mirror
 * `tests/core/domains/language/capability/resolve.test.ts`. A wired App with a
 * real `ProjectRegistryOps` stands in for bootstrap — mock-free delegation.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "../../../src/core/adapters/embeddings/base.js";
import type { QdrantManager } from "../../../src/core/adapters/qdrant/client.js";
import { createApp, type AppDeps, type ExploreFacade, type IngestFacade } from "../../../src/core/api/index.js";
import { ProjectRegistryOps } from "../../../src/core/api/internal/ops/project-registry-ops.js";
import type { Reranker } from "../../../src/core/domains/explore/reranker.js";
import { UNSUPPORTED_FALLBACK } from "../../../src/core/domains/language/capability/fallback.js";
import { LanguageFactory } from "../../../src/core/domains/language/factory.js";
import type { IndexDriftReporter } from "../../../src/core/domains/maintenance/drift/index.js";
import { CollectionRegistry } from "../../../src/core/domains/maintenance/registry/index.js";

const registryDir = mkdtempSync(join(tmpdir(), "app-domain-queries-"));
afterAll(() => {
  rmSync(registryDir, { recursive: true, force: true });
});

/** Wired the way the composition does — a real ProjectRegistryOps over a temp registry. */
function makeApp() {
  const deps: AppDeps = {
    qdrant: {} as QdrantManager,
    embeddings: {} as EmbeddingProvider,
    explore: {} as ExploreFacade,
    ingest: {} as IngestFacade,
    reranker: {
      getDescriptorInfo: vi.fn().mockReturnValue([]),
      getPresetNames: vi.fn().mockReturnValue([]),
      getPresetDetails: vi.fn().mockReturnValue([]),
      getPayloadSignals: vi.fn().mockReturnValue([]),
    } as unknown as Reranker,
    driftReporter: {} as IndexDriftReporter,
    projectRegistryOps: new ProjectRegistryOps({ registry: new CollectionRegistry(registryDir) }),
    quantizationScalar: true,
    turboQuant: true,
  };
  return createApp(deps);
}

/** A marker reader: collection → `__indexing_metadata__` payload; absent ⇒ no marker. */
function markerReader(markers: Record<string, Record<string, unknown>>): Pick<QdrantManager, "getPoint"> {
  return {
    getPoint: vi
      .fn()
      .mockImplementation(async (collection: string) =>
        Promise.resolve(markers[collection] ? { payload: markers[collection] } : null),
      ),
  };
}

const minutesAgo = (n: number) => new Date(Date.now() - n * 60 * 1000).toISOString();
const liveMarker = () => ({ indexingComplete: false, startedAt: minutesAgo(2), lastHeartbeat: minutesAgo(1) });

describe("App.resolveLanguageCapabilities", () => {
  it("returns the native descriptor for every supported language, read from LanguageFactory.capabilities()", () => {
    const app = makeApp();
    const native = new LanguageFactory().capabilities();
    const languages = [...native.keys()];
    const resolved = app.resolveLanguageCapabilities(languages);
    for (const language of languages) {
      expect(resolved.get(language)).toBe(native.get(language));
    }
  });

  it("maps a language with no native provider onto the unsupported-fallback descriptor", () => {
    const app = makeApp();
    const [fallback] = UNSUPPORTED_FALLBACK;
    const resolved = app.resolveLanguageCapabilities(["kotlin"]).get("kotlin");
    expect(resolved).toEqual({ ...fallback, language: "kotlin" });
  });

  it("carries exactly the requested languages", () => {
    const app = makeApp();
    const resolved = app.resolveLanguageCapabilities(["typescript", "sql"]);
    expect([...resolved.keys()]).toEqual(["typescript", "sql"]);
  });
});

describe("App.isCollectionBuildInFlight", () => {
  it("reports a fresh in-progress marker as a live build", async () => {
    const app = makeApp();
    const reader = markerReader({ code_abc_v7: liveMarker() });

    expect(await app.isCollectionBuildInFlight(reader, "code_abc_v7")).toBe(true);
  });

  it("reports an absent, completed or stale marker as no live build", async () => {
    const app = makeApp();
    const reader = markerReader({
      code_abc_v8: { indexingComplete: true, completedAt: minutesAgo(1) },
      code_abc_v9: { indexingComplete: false, startedAt: minutesAgo(30), lastHeartbeat: minutesAgo(11) },
    });

    expect(await app.isCollectionBuildInFlight(reader, "code_abc_v7")).toBe(false);
    expect(await app.isCollectionBuildInFlight(reader, "code_abc_v8")).toBe(false);
    expect(await app.isCollectionBuildInFlight(reader, "code_abc_v9")).toBe(false);
  });

  it("answers no when the marker read throws", async () => {
    const app = makeApp();
    const reader = {
      getPoint: vi.fn().mockRejectedValueOnce(new Error("qdrant down")),
    } as unknown as Pick<QdrantManager, "getPoint">;

    expect(await app.isCollectionBuildInFlight(reader, "code_abc_v7")).toBe(false);
  });

  it("honours deadWriterEvidenceUpTo the way the domain predicate does", async () => {
    const app = makeApp();
    // Heartbeat looks fresh, but the caller proved that writer dead before now.
    const reader = markerReader({ code_abc_v7: liveMarker() });

    expect(await app.isCollectionBuildInFlight(reader, "code_abc_v7", { deadWriterEvidenceUpTo: Date.now() })).toBe(
      false,
    );
  });
});
