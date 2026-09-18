import { describe, expect, it, vi } from "vitest";

import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import { QdrantOperationError, QdrantUnavailableError } from "../../../../src/core/adapters/qdrant/errors.js";

const mockClient = {
  getCollection: vi.fn(),
  deletePayloadIndex: vi.fn(),
};

vi.mock("@qdrant/js-client-rest", () => ({
  QdrantClient: vi.fn().mockImplementation(function () {
    return mockClient;
  }),
}));

function manager(): QdrantManager {
  mockClient.getCollection.mockReset();
  mockClient.deletePayloadIndex.mockReset().mockResolvedValue({});
  return new QdrantManager("http://localhost:6333");
}

describe("QdrantManager#listPayloadIndexes", () => {
  it("returns every payload field index with its data type and indexed point count", async () => {
    const qdrant = manager();
    mockClient.getCollection.mockResolvedValue({
      payload_schema: {
        relativePath: { data_type: "text", points: 24622 },
        "git.file.skippedAs": { data_type: "keyword", points: 0 },
        "git.file.fanIn": { data_type: "float", points: 0 },
      },
    });

    const indexes = await qdrant.listPayloadIndexes("code_x");

    expect(mockClient.getCollection).toHaveBeenCalledWith("code_x");
    expect(indexes).toEqual([
      { field: "relativePath", dataType: "text", points: 24622 },
      { field: "git.file.skippedAs", dataType: "keyword", points: 0 },
      { field: "git.file.fanIn", dataType: "float", points: 0 },
    ]);
  });

  it("returns no indexes for a collection whose schema carries none", async () => {
    const qdrant = manager();
    mockClient.getCollection.mockResolvedValue({});

    expect(await qdrant.listPayloadIndexes("code_x")).toEqual([]);
  });

  // hasPayloadIndex answers `false` on any failure. A listing must not: a caller
  // deciding which indexes to drop would read "unreadable" as "none exist".
  it("fails loudly instead of reporting an unreadable schema as empty", async () => {
    const qdrant = manager();
    mockClient.getCollection.mockRejectedValue(new Error("Collection code_x not found"));

    await expect(qdrant.listPayloadIndexes("code_x")).rejects.toBeInstanceOf(QdrantOperationError);
  });
});

describe("QdrantManager#deletePayloadIndex", () => {
  it("drops the field index and waits for Qdrant to apply it", async () => {
    const qdrant = manager();

    await qdrant.deletePayloadIndex("code_x", "git.chunk.pageRank");

    expect(mockClient.deletePayloadIndex).toHaveBeenCalledWith("code_x", "git.chunk.pageRank", { wait: true });
  });

  it("surfaces a rejected drop as a typed Qdrant operation error", async () => {
    const qdrant = manager();
    mockClient.deletePayloadIndex.mockRejectedValue(new Error("Bad Request"));

    await expect(qdrant.deletePayloadIndex("code_x", "git.chunk.pageRank")).rejects.toBeInstanceOf(
      QdrantOperationError,
    );
  });

  it("keeps a connection failure typed as unavailability, not as an operation error", async () => {
    const qdrant = manager();
    mockClient.deletePayloadIndex.mockRejectedValue(new TypeError("fetch failed"));

    await expect(qdrant.deletePayloadIndex("code_x", "git.chunk.pageRank")).rejects.toBeInstanceOf(
      QdrantUnavailableError,
    );
  });
});
