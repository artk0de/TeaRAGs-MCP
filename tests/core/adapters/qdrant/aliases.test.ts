import { beforeEach, describe, expect, it, vi } from "vitest";

import { QdrantAliasManager } from "../../../../src/core/adapters/qdrant/aliases.js";
import { QdrantConnection } from "../../../../src/core/adapters/qdrant/connection.js";
import { AliasOperationError, QdrantUnavailableError } from "../../../../src/core/adapters/qdrant/errors.js";

function createMockClient() {
  return {
    updateCollectionAliases: vi.fn().mockResolvedValue({}),
    getAliases: vi.fn().mockResolvedValue({ aliases: [] }),
  };
}

type MockClient = ReturnType<typeof createMockClient>;

/** A real connection whose REST client is the mock — alias ops run through its `call` guard. */
function connectionFor(client: MockClient): QdrantConnection {
  const connection = new QdrantConnection("http://127.0.0.1:6333");
  connection.client = client as never;
  return connection;
}

function staleSocketReset(): TypeError {
  return Object.assign(new TypeError("fetch failed"), {
    cause: Object.assign(new Error("other side closed"), { code: "UND_ERR_SOCKET" }),
  });
}

describe("QdrantAliasManager", () => {
  let client: MockClient;
  let aliases: QdrantAliasManager;

  beforeEach(() => {
    client = createMockClient();
    aliases = new QdrantAliasManager(connectionFor(client));
  });

  describe("createAlias", () => {
    it("should call updateCollectionAliases with create_alias action", async () => {
      await aliases.createAlias("my_alias", "my_collection");

      expect(client.updateCollectionAliases).toHaveBeenCalledWith({
        actions: [
          {
            create_alias: {
              alias_name: "my_alias",
              collection_name: "my_collection",
            },
          },
        ],
      });
    });

    it("should throw AliasOperationError on failure", async () => {
      client.updateCollectionAliases.mockRejectedValue(new Error("connection refused"));

      await expect(aliases.createAlias("a", "c")).rejects.toThrow(AliasOperationError);
      await expect(aliases.createAlias("a", "c")).rejects.toThrow(/createAlias/);
    });

    it("should handle non-Error thrown values", async () => {
      client.updateCollectionAliases.mockRejectedValue("string error");

      const err = await aliases.createAlias("a", "c").catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AliasOperationError);
      expect((err as AliasOperationError).cause).toBeUndefined();
    });
  });

  describe("switchAlias", () => {
    it("should atomically delete old and create new alias", async () => {
      await aliases.switchAlias("my_alias", "old_collection", "new_collection");

      expect(client.updateCollectionAliases).toHaveBeenCalledWith({
        actions: [
          {
            delete_alias: {
              alias_name: "my_alias",
            },
          },
          {
            create_alias: {
              alias_name: "my_alias",
              collection_name: "new_collection",
            },
          },
        ],
      });
    });

    it("should throw AliasOperationError on failure", async () => {
      client.updateCollectionAliases.mockRejectedValue(new Error("not found"));

      await expect(aliases.switchAlias("a", "old", "new")).rejects.toThrow(AliasOperationError);
      await expect(aliases.switchAlias("a", "old", "new")).rejects.toThrow(/switchAlias/);
    });
  });

  describe("deleteAlias", () => {
    it("should call updateCollectionAliases with delete_alias action", async () => {
      await aliases.deleteAlias("my_alias");

      expect(client.updateCollectionAliases).toHaveBeenCalledWith({
        actions: [
          {
            delete_alias: {
              alias_name: "my_alias",
            },
          },
        ],
      });
    });

    it("should throw AliasOperationError on failure", async () => {
      client.updateCollectionAliases.mockRejectedValue(new Error("timeout"));

      await expect(aliases.deleteAlias("a")).rejects.toThrow(AliasOperationError);
      await expect(aliases.deleteAlias("a")).rejects.toThrow(/deleteAlias/);
    });
  });

  describe("isAlias", () => {
    it("should return true when alias exists in getAliases result", async () => {
      client.getAliases.mockResolvedValue({
        aliases: [
          { alias_name: "my_alias", collection_name: "coll_1" },
          { alias_name: "other", collection_name: "coll_2" },
        ],
      });

      expect(await aliases.isAlias("my_alias")).toBe(true);
    });

    it("should return false when alias does not exist", async () => {
      client.getAliases.mockResolvedValue({
        aliases: [{ alias_name: "other", collection_name: "coll_1" }],
      });

      expect(await aliases.isAlias("my_alias")).toBe(false);
    });

    it("should return false when no aliases exist", async () => {
      client.getAliases.mockResolvedValue({ aliases: [] });

      expect(await aliases.isAlias("my_alias")).toBe(false);
    });

    it("should throw AliasOperationError on failure", async () => {
      client.getAliases.mockRejectedValue(new Error("server error"));

      await expect(aliases.isAlias("a")).rejects.toThrow(AliasOperationError);
      await expect(aliases.isAlias("a")).rejects.toThrow(/isAlias/);
    });
  });

  describe("listAliases", () => {
    it("should return mapped array from getAliases", async () => {
      client.getAliases.mockResolvedValue({
        aliases: [
          { alias_name: "alias_1", collection_name: "coll_a" },
          { alias_name: "alias_2", collection_name: "coll_b" },
        ],
      });

      const result = await aliases.listAliases();

      expect(result).toEqual([
        { aliasName: "alias_1", collectionName: "coll_a" },
        { aliasName: "alias_2", collectionName: "coll_b" },
      ]);
    });

    it("should return empty array when no aliases exist", async () => {
      client.getAliases.mockResolvedValue({ aliases: [] });

      expect(await aliases.listAliases()).toEqual([]);
    });

    it("should throw AliasOperationError on failure", async () => {
      client.getAliases.mockRejectedValue(new Error("network error"));

      await expect(aliases.listAliases()).rejects.toThrow(AliasOperationError);
      await expect(aliases.listAliases()).rejects.toThrow(/listAliases/);
    });
  });

  describe("resolveActive", () => {
    it("resolves an alias to its target collection", async () => {
      client.getAliases.mockResolvedValue({
        aliases: [{ alias_name: "code_x", collection_name: "code_x_v4" }],
      });
      expect(await aliases.resolveActive("code_x")).toBe("code_x_v4");
    });

    it("returns the name verbatim when it is not an alias (already a concrete collection)", async () => {
      client.getAliases.mockResolvedValue({
        aliases: [{ alias_name: "code_x", collection_name: "code_x_v4" }],
      });
      expect(await aliases.resolveActive("code_x_v4")).toBe("code_x_v4");
      expect(await aliases.resolveActive("unknown")).toBe("unknown");
    });
  });

  describe("connection guard", () => {
    it("listAliases survives a stale keep-alive socket reset via the connection's retry", async () => {
      client.getAliases
        .mockRejectedValueOnce(staleSocketReset())
        .mockResolvedValueOnce({ aliases: [{ alias_name: "code_x", collection_name: "code_x_v4" }] });

      expect(await aliases.listAliases()).toEqual([{ aliasName: "code_x", collectionName: "code_x_v4" }]);
      expect(client.getAliases).toHaveBeenCalledTimes(2);
    });

    it("updateCollectionAliases survives a stale keep-alive socket reset via the connection's retry", async () => {
      client.updateCollectionAliases.mockRejectedValueOnce(staleSocketReset()).mockResolvedValueOnce({});

      await aliases.switchAlias("code_x", "code_x_v3", "code_x_v4");
      expect(client.updateCollectionAliases).toHaveBeenCalledTimes(2);
    });

    it("reads the connection's client at call time, so a reconnect-swapped client is used", async () => {
      const connection = connectionFor(client);
      const manager = new QdrantAliasManager(connection);
      const swapped = createMockClient();
      swapped.getAliases.mockResolvedValue({ aliases: [{ alias_name: "a", collection_name: "a_v2" }] });
      connection.client = swapped as never;

      expect(await manager.isAlias("a")).toBe(true);
      expect(client.getAliases).not.toHaveBeenCalled();
    });

    it("keeps the typed connection failure as the cause when the retry fails too", async () => {
      client.getAliases.mockRejectedValue(staleSocketReset());

      const err = await aliases.listAliases().catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AliasOperationError);
      expect((err as AliasOperationError).cause).toBeInstanceOf(QdrantUnavailableError);
    });
  });
});
