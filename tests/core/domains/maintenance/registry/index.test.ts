import { describe, expect, it } from "vitest";

import { CollectionRegistry, loadRegistryFile, saveRegistryFile } from "../../../../../src/core/domains/maintenance/registry/index.js";

describe("maintenance/registry barrel", () => {
  it("re-exports all public API surface", () => {
    expect(CollectionRegistry).toBeDefined();
    expect(typeof loadRegistryFile).toBe("function");
    expect(typeof saveRegistryFile).toBe("function");
  });
});
