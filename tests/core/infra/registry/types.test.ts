import { describe, expect, it } from "vitest";

import { RegistryFileCorruptedError, RegistryWriteError } from "../../../../src/core/infra/registry/errors.js";
import type {
  CollectionEntry,
  ProjectInfo,
  RecordEntryInput,
  RegistryFileV1,
} from "../../../../src/core/infra/registry/types.js";

describe("registry types", () => {
  it("CollectionEntry has every required field", () => {
    const entry: CollectionEntry = {
      collectionName: "code_abc123",
      path: "/some/path",
      name: null,
      embeddingModel: "Xenova/all-MiniLM-L6-v2",
      embeddingDimensions: 384,
      qdrantUrl: "http://localhost:6333",
      indexedAt: "2026-05-12T14:21:08.231Z",
      teaRagsVersion: "0.42.1",
      chunksCount: 12345,
    };
    expect(entry.collectionName).toBe("code_abc123");
    expect(entry.name).toBeNull();
  });

  it("RegistryFileV1 maps collectionName → entry under version 1", () => {
    const file: RegistryFileV1 = {
      version: 1,
      collections: {
        code_abc123: {
          collectionName: "code_abc123",
          path: "/some/path",
          name: "alpha",
          embeddingModel: "m",
          embeddingDimensions: 1,
          qdrantUrl: "u",
          indexedAt: "t",
          teaRagsVersion: "v",
          chunksCount: 0,
        },
      },
    };
    expect(file.version).toBe(1);
    expect(file.collections.code_abc123?.name).toBe("alpha");
  });

  it("RecordEntryInput is CollectionEntry without name (sticky preserved by registry)", () => {
    const input: RecordEntryInput = {
      collectionName: "code_x",
      path: "/x",
      embeddingModel: "m",
      embeddingDimensions: 1,
      qdrantUrl: "u",
      indexedAt: "t",
      teaRagsVersion: "v",
      chunksCount: 0,
    };
    // @ts-expect-error — name should not be present on RecordEntryInput
    input.name = "should-not-compile";
    expect(input.collectionName).toBe("code_x");
  });

  it("ProjectInfo equals CollectionEntry wire shape", () => {
    const info: ProjectInfo = {
      collectionName: "code_x",
      path: "/x",
      name: "x",
      embeddingModel: "m",
      embeddingDimensions: 1,
      qdrantUrl: "u",
      indexedAt: "t",
      teaRagsVersion: "v",
      chunksCount: 0,
    };
    expect(info.name).toBe("x");
  });
});

describe("registry errors", () => {
  it("RegistryFileCorruptedError carries path and reason in message", () => {
    const err = new RegistryFileCorruptedError("/data/registry.json", "JSON parse failed");
    expect(err.name).toBe("RegistryFileCorruptedError");
    expect(err.message).toContain("/data/registry.json");
    expect(err.message).toContain("JSON parse failed");
    expect(err.code).toBe("INFRA_REGISTRY_FILE_CORRUPTED");
  });

  it("RegistryWriteError carries path and cause", () => {
    const cause = new Error("EACCES");
    const err = new RegistryWriteError("/data/registry.json", cause);
    expect(err.name).toBe("RegistryWriteError");
    expect(err.message).toContain("/data/registry.json");
    expect(err.cause).toBe(cause);
    expect(err.code).toBe("INFRA_REGISTRY_WRITE_FAILED");
  });
});
