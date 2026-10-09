/**
 * `RelativePathExactCapability` (bd tea-rags-mcp-ejio7): the ONE place that
 * decides whether a collection's path-membership filters may use a keyword
 * MatchAny on `relativePathExact`. Yes only when the collection's schema
 * version is at least the v20 backfill's — otherwise the key may be missing on
 * some points and a keyword filter would silently miss them.
 */

import { describe, expect, it, vi } from "vitest";

import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import { RelativePathExactCapability } from "../../../../src/core/adapters/qdrant/relative-path-exact-capability.js";

function capability(versions: Record<string, number | undefined>, aliases: Record<string, string> = {}) {
  const readSchemaVersion = vi.fn(async (physical: string) => versions[physical]);
  const resolvePhysical = vi.fn(async (name: string) => aliases[name] ?? name);
  return { gate: new RelativePathExactCapability({ readSchemaVersion, resolvePhysical }), readSchemaVersion };
}

describe("RelativePathExactCapability#isServed", () => {
  it("serves a collection stamped at v20 or later", async () => {
    const { gate } = capability({ c20: 20, c21: 21 });
    expect(await gate.isServed("c20")).toBe(true);
    expect(await gate.isServed("c21")).toBe(true);
  });

  it("does not serve a collection below v20, or one with no schema metadata", async () => {
    const { gate } = capability({ c19: 19, bare: undefined });
    expect(await gate.isServed("c19")).toBe(false);
    expect(await gate.isServed("bare")).toBe(false);
  });

  it("reads the version of the PHYSICAL collection the alias points at", async () => {
    const { gate, readSchemaVersion } = capability({ code_x_v2: 20 }, { code_x: "code_x_v2" });
    expect(await gate.isServed("code_x")).toBe(true);
    expect(readSchemaVersion).toHaveBeenCalledWith("code_x_v2");
  });

  it("remembers a served physical collection: the version is read once", async () => {
    const { gate, readSchemaVersion } = capability({ c: 20 });
    await gate.isServed("c");
    await gate.isServed("c");
    expect(readSchemaVersion).toHaveBeenCalledTimes(1);
  });

  it("re-reads an unserved collection, so a migration that completes later is picked up", async () => {
    const versions: Record<string, number> = { c: 19 };
    const { gate } = capability(versions);
    expect(await gate.isServed("c")).toBe(false);
    versions.c = 20;
    expect(await gate.isServed("c")).toBe(true);
  });

  it("does not carry an alias's answer over to the collection it is switched to", async () => {
    const aliases: Record<string, string> = { code_x: "code_x_v1" };
    const { gate } = capability({ code_x_v1: 20, code_x_v2: 19 }, aliases);
    expect(await gate.isServed("code_x")).toBe(true);
    aliases.code_x = "code_x_v2";
    expect(await gate.isServed("code_x")).toBe(false);
  });

  it("answers no — never throws — when the alias list or the metadata point cannot be read", async () => {
    const failingVersion = new RelativePathExactCapability({
      resolvePhysical: async (name) => name,
      readSchemaVersion: async () => {
        throw new Error("qdrant down");
      },
    });
    const failingAliases = new RelativePathExactCapability({
      resolvePhysical: async () => {
        throw new Error("qdrant down");
      },
      readSchemaVersion: async () => 20,
    });
    expect(await failingVersion.isServed("c")).toBe(false);
    expect(await failingAliases.isServed("c")).toBe(false);
  });
});

describe("QdrantManager#servesRelativePathExact", () => {
  function managerOver(schemaVersion: number | undefined) {
    const manager = new QdrantManager("http://127.0.0.1:6333");
    const client = {
      getAliases: vi.fn(async () => ({ aliases: [{ alias_name: "code_x", collection_name: "code_x_v3" }] })),
      retrieve: vi.fn(async () =>
        schemaVersion === undefined ? [] : [{ id: "m", payload: { _type: "schema_metadata", schemaVersion } }],
      ),
    };
    (manager as unknown as { client: unknown }).client = client;
    return { manager, client };
  }

  it("reads the schema metadata point of the alias's physical collection", async () => {
    const { manager, client } = managerOver(20);
    expect(await manager.servesRelativePathExact("code_x")).toBe(true);
    expect(client.retrieve).toHaveBeenCalledWith("code_x_v3", expect.anything());
  });

  it("answers no below v20 and without a metadata point", async () => {
    expect(await managerOver(19).manager.servesRelativePathExact("code_x")).toBe(false);
    expect(await managerOver(undefined).manager.servesRelativePathExact("code_x")).toBe(false);
  });
});
