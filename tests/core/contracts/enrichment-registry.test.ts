import { describe, expect, it } from "vitest";

import { EnrichmentRegistry } from "../../../src/core/contracts/enrichment-registry.js";
import type { EnrichmentProvider } from "../../../src/core/contracts/types/provider.js";

function mockProvider(key: string): EnrichmentProvider {
  return {
    key,
    resolveRoot: (p: string) => p,
    buildFileSignals: async () => new Map(),
    buildChunkSignals: async () => new Map(),
  };
}

describe("EnrichmentRegistry", () => {
  it("starts empty", () => {
    const registry = new EnrichmentRegistry();
    expect(registry.getAll()).toHaveLength(0);
  });

  it("registers and returns providers", () => {
    const registry = new EnrichmentRegistry();
    registry.register(mockProvider("git"));
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.getAll()[0].key).toBe("git");
  });

  it("has() checks by key", () => {
    const registry = new EnrichmentRegistry();
    expect(registry.has("git")).toBe(false);
    registry.register(mockProvider("git"));
    expect(registry.has("git")).toBe(true);
  });

  it("supports multiple providers", () => {
    const registry = new EnrichmentRegistry();
    registry.register(mockProvider("git"));
    registry.register(mockProvider("custom"));
    expect(registry.getAll()).toHaveLength(2);
  });
});
