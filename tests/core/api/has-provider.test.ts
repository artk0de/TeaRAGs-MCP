/**
 * `App.hasProvider(key)` tests — RFC
 * docs/superpowers/specs/2026-05-21-codegraph-provider-gating-design.md.
 *
 * The App interface exposes `hasProvider(key)` so MCP tool registrars can
 * gate their registration on provider availability. Source of truth is
 * `AppDeps.registeredProviderKeys: ReadonlySet<string>` populated by
 * composition from `TrajectoryRegistry.getRegisteredKeys()`.
 */

import { describe, expect, it, vi } from "vitest";

import type { EmbeddingProvider } from "../../../src/core/adapters/embeddings/base.js";
import type { QdrantManager } from "../../../src/core/adapters/qdrant/client.js";
import { createApp, type AppDeps, type ExploreFacade, type IngestFacade } from "../../../src/core/api/index.js";
import type { ProjectRegistryOps } from "../../../src/core/api/internal/ops/project-registry-ops.js";
import type { Reranker } from "../../../src/core/domains/explore/reranker.js";
import type { SchemaDriftMonitor } from "../../../src/core/infra/schema-drift-monitor.js";

function makeDeps(registeredKeys: Iterable<string> = []): AppDeps {
  return {
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
    schemaDriftMonitor: {} as SchemaDriftMonitor,
    projectRegistryOps: {} as ProjectRegistryOps,
    quantizationScalar: true,
    registeredProviderKeys: new Set(registeredKeys),
  };
}

describe("App.hasProvider", () => {
  it("returns true for a registered trajectory key", () => {
    const app = createApp(makeDeps(["git", "static", "codegraph.symbols"]));
    expect(app.hasProvider("codegraph.symbols")).toBe(true);
    expect(app.hasProvider("git")).toBe(true);
    expect(app.hasProvider("static")).toBe(true);
  });

  it("returns false for an unregistered trajectory key", () => {
    const app = createApp(makeDeps(["git", "static"]));
    expect(app.hasProvider("codegraph.symbols")).toBe(false);
    expect(app.hasProvider("future-trajectory")).toBe(false);
  });

  it("returns false when no keys are registered (empty composition)", () => {
    const app = createApp(makeDeps([]));
    expect(app.hasProvider("git")).toBe(false);
    expect(app.hasProvider("codegraph.symbols")).toBe(false);
  });

  it("is synchronous (returns boolean directly, not a Promise)", () => {
    const app = createApp(makeDeps(["git"]));
    const result = app.hasProvider("git");
    expect(typeof result).toBe("boolean");
  });
});
