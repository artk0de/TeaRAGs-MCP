import { describe, expect, it } from "vitest";

import {
  CollectionRegistry,
  loadRegistryFile,
  RegistryFileCorruptedError,
  RegistryNameConflictError,
  RegistryWriteError,
  saveRegistryFile,
} from "../../../../src/core/infra/registry/index.js";

describe("infra/registry barrel", () => {
  it("re-exports all public API surface", () => {
    expect(CollectionRegistry).toBeDefined();
    expect(RegistryFileCorruptedError).toBeDefined();
    expect(RegistryWriteError).toBeDefined();
    expect(RegistryNameConflictError).toBeDefined();
    expect(typeof loadRegistryFile).toBe("function");
    expect(typeof saveRegistryFile).toBe("function");
  });
});
