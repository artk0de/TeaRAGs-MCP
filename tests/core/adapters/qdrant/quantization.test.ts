import { beforeEach, describe, expect, it, vi } from "vitest";

import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";

// Mock the Qdrant client
vi.mock("@qdrant/js-client-rest", () => {
  const createCollection = vi.fn().mockResolvedValue(true);
  const updateCollection = vi.fn().mockResolvedValue(true);
  function MockQdrantClient() {
    this.createCollection = createCollection;
    this.updateCollection = updateCollection;
  }
  return { QdrantClient: MockQdrantClient };
});

describe("QdrantManager.createCollection — quantization", () => {
  let manager: QdrantManager;
  let mockClient: { createCollection: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new QdrantManager("http://localhost:6333");
    mockClient = (manager as any).client;
  });

  it("includes scalar quantization config when quantizationScalar=true", async () => {
    await manager.createCollection("test-col", 384, "Cosine", false, true);

    expect(mockClient.createCollection).toHaveBeenCalledWith("test-col", {
      vectors: { size: 384, distance: "Cosine" },
      quantization_config: {
        scalar: { type: "int8", always_ram: true },
      },
    });
  });

  it("includes scalar quantization with sparse vectors", async () => {
    await manager.createCollection("test-col", 384, "Cosine", true, true);

    expect(mockClient.createCollection).toHaveBeenCalledWith("test-col", {
      vectors: { dense: { size: 384, distance: "Cosine" } },
      sparse_vectors: { text: { modifier: "idf" } },
      quantization_config: {
        scalar: { type: "int8", always_ram: true },
      },
    });
  });

  it("omits quantization config when quantizationScalar=false", async () => {
    await manager.createCollection("test-col", 384, "Cosine", false, false);

    expect(mockClient.createCollection).toHaveBeenCalledWith("test-col", {
      vectors: { size: 384, distance: "Cosine" },
    });
  });

  it("omits quantization config by default (no 5th arg)", async () => {
    await manager.createCollection("test-col", 384, "Cosine", false);

    const callArgs = mockClient.createCollection.mock.calls[0];
    const config = callArgs[1];
    expect(config).not.toHaveProperty("quantization_config");
  });

  it("emits turbo quantization_config when turboQuant=true", async () => {
    await manager.createCollection("test-col", 384, "Cosine", false, false, true);

    const config = mockClient.createCollection.mock.calls.at(-1)[1];
    expect(config.quantization_config).toEqual({
      turbo: { bits: "bits4", always_ram: true },
    });
  });

  it("turboQuant takes precedence over quantizationScalar", async () => {
    await manager.createCollection("test-col", 384, "Cosine", false, true, true);

    const config = mockClient.createCollection.mock.calls.at(-1)[1];
    expect(config.quantization_config).toEqual({
      turbo: { bits: "bits4", always_ram: true },
    });
  });
});

describe("QdrantManager.createCollection — strict mode", () => {
  let manager: QdrantManager;
  let mockClient: { createCollection: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new QdrantManager("http://localhost:6333");
    mockClient = (manager as any).client;
  });

  it("emits strict_mode_config when strictMode sets a memory percent", async () => {
    await manager.createCollection("c", 384, "Cosine", false, false, false, {
      maxResidentMemoryPercent: 90,
    });

    const config = mockClient.createCollection.mock.calls.at(-1)[1];
    expect(config.strict_mode_config).toEqual({ enabled: true, max_resident_memory_percent: 90 });
  });

  it("emits strict_mode_config when strictMode sets a search batch cap", async () => {
    await manager.createCollection("c", 384, "Cosine", false, false, false, {
      searchMaxBatchsize: 256,
    });

    const config = mockClient.createCollection.mock.calls.at(-1)[1];
    expect(config.strict_mode_config).toEqual({ enabled: true, search_max_batchsize: 256 });
  });

  it("emits both strict-mode fields together", async () => {
    await manager.createCollection("c", 384, "Cosine", false, false, false, {
      maxResidentMemoryPercent: 80,
      searchMaxBatchsize: 128,
    });

    const config = mockClient.createCollection.mock.calls.at(-1)[1];
    expect(config.strict_mode_config).toEqual({
      enabled: true,
      max_resident_memory_percent: 80,
      search_max_batchsize: 128,
    });
  });

  it("omits strict_mode_config when strictMode is undefined", async () => {
    await manager.createCollection("c", 384, "Cosine", false, false, false);

    const config = mockClient.createCollection.mock.calls.at(-1)[1];
    expect(config.strict_mode_config).toBeUndefined();
  });

  it("omits strict_mode_config when strictMode has no set fields", async () => {
    await manager.createCollection("c", 384, "Cosine", false, false, false, {});

    const config = mockClient.createCollection.mock.calls.at(-1)[1];
    expect(config.strict_mode_config).toBeUndefined();
  });
});
