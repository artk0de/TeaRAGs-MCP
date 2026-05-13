import { describe, expect, it } from "vitest";

import {
  CollectionRegistry,
  loadRegistryFile,
  ProjectNameNotUniqueError,
  RegistryFileCorruptedError,
  RegistryWriteError,
  saveRegistryFile,
} from "../../../../src/core/infra/registry/index.js";

describe("infra/registry barrel", () => {
  it("re-exports all public API surface", () => {
    expect(CollectionRegistry).toBeDefined();
    expect(ProjectNameNotUniqueError).toBeDefined();
    expect(RegistryFileCorruptedError).toBeDefined();
    expect(RegistryWriteError).toBeDefined();
    expect(typeof loadRegistryFile).toBe("function");
    expect(typeof saveRegistryFile).toBe("function");
  });
});
