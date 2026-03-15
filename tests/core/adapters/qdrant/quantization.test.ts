import { beforeEach, describe, expect, it, vi } from "vitest";

import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";

// Mock the Qdrant client
vi.mock("@qdrant/js-client-rest", () => {
  const createCollection = vi.fn().mockResolvedValue(true);
  function MockQdrantClient() {
    this.createCollection = createCollection;
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
});
