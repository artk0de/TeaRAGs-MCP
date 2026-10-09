/**
 * `RelativePathExactCapability` (bd tea-rags-mcp-ejio7): the ONE place that
 * decides whether a collection's path-membership filters may use a keyword
 * MatchAny on `relativePathExact`. Yes only when the collection's schema
 * version is at least the v20 backfill's — otherwise the key may be missing on
 * some points and a keyword filter would silently miss them — and at or above
 * it, only after healing any point an older build wrote without the key.
 */

import { describe, expect, it, vi } from "vitest";

import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import { payloadMatchesFilter } from "../../../../src/core/adapters/qdrant/filters/payload-match.js";
import { RelativePathExactCapability } from "../../../../src/core/adapters/qdrant/relative-path-exact-capability.js";

type StoredPoint = { id: string; payload: Record<string, unknown> };

/**
 * The backfill store over an in-memory collection: `scrollPayloadPages` pages
 * in id order through the points its filter admits, carrying only the asked
 * keys; `batchSetPayload` merges into the live payload. `failWrites` makes
 * every write throw.
 */
function backfillStoreOver(points: StoredPoint[], options: { failWrites?: boolean } = {}) {
  const pageSizes: (number | undefined)[] = [];
  const store = {
    pageSizes,
    scrollPayloadPages: vi.fn(async function* (
      _collection: string,
      request: { payloadInclude: string[]; filter?: Record<string, unknown>; pageSize?: number },
    ) {
      const pageSize = request.pageSize ?? 1000;
      const sorted = [...points].sort((a, b) => a.id.localeCompare(b.id));
      let afterId: string | undefined;
      for (;;) {
        pageSizes.push(request.pageSize);
        const page = sorted
          .filter((p) => afterId === undefined || p.id > afterId)
          .filter((p) => request.filter === undefined || payloadMatchesFilter(p.payload, request.filter))
          .slice(0, pageSize);
        if (page.length === 0) return;
        afterId = page[page.length - 1].id;
        yield page.map((p) => ({
          id: p.id,
          payload: Object.fromEntries(Object.entries(p.payload).filter(([k]) => request.payloadInclude.includes(k))),
        }));
      }
    }),
    batchSetPayload: vi.fn(
      async (_collection: string, ops: { payload: Record<string, unknown>; points: (string | number)[] }[]) => {
        if (options.failWrites) throw new Error("qdrant down");
        for (const op of ops) {
          for (const id of op.points) {
            const point = points.find((p) => p.id === id);
            if (point) Object.assign(point.payload, op.payload);
          }
        }
      },
    ),
  };
  return store;
}

const twinned = (id: string, path: string): StoredPoint => ({
  id,
  payload: { relativePath: path, relativePathExact: path },
});
// What a build older than ejio7 writes into a v20 collection: no twin.
const oldBuildPoint = (id: string, path: string): StoredPoint => ({ id, payload: { relativePath: path } });

function capability(
  versions: Record<string, number | undefined>,
  aliases: Record<string, string> = {},
  points: StoredPoint[] = [],
  storeOptions: { failWrites?: boolean } = {},
) {
  const readSchemaVersion = vi.fn(async (physical: string) => versions[physical]);
  const resolvePhysical = vi.fn(async (name: string) => aliases[name] ?? name);
  const backfillStore = backfillStoreOver(points, storeOptions);
  return {
    gate: new RelativePathExactCapability({ readSchemaVersion, resolvePhysical, backfillStore }),
    readSchemaVersion,
    backfillStore,
  };
}

describe("RelativePathExactCapability#isServed", () => {
  it("serves a collection stamped at v20 or later", async () => {
    const { gate } = capability({ c20: 20, c21: 21 });
    expect(await gate.isServed("c20")).toBe(true);
    expect(await gate.isServed("c21")).toBe(true);
  });

  it("does not serve a collection below v20, or one with no schema metadata", async () => {
    const { gate, backfillStore } = capability({ c19: 19, bare: undefined }, {}, [oldBuildPoint("1", "a.ts")]);
    expect(await gate.isServed("c19")).toBe(false);
    expect(await gate.isServed("bare")).toBe(false);
    // Below v20 the migration owns the backfill; the gate does not race it.
    expect(backfillStore.scrollPayloadPages).not.toHaveBeenCalled();
  });

  it("reads the version of the PHYSICAL collection the alias points at", async () => {
    const { gate, readSchemaVersion } = capability({ code_x_v2: 20 }, { code_x: "code_x_v2" });
    expect(await gate.isServed("code_x")).toBe(true);
    expect(readSchemaVersion).toHaveBeenCalledWith("code_x_v2");
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
    const backfillStore = backfillStoreOver([]);
    const failingVersion = new RelativePathExactCapability({
      resolvePhysical: async (name) => name,
      readSchemaVersion: async () => {
        throw new Error("qdrant down");
      },
      backfillStore,
    });
    const failingAliases = new RelativePathExactCapability({
      resolvePhysical: async () => {
        throw new Error("qdrant down");
      },
      readSchemaVersion: async () => 20,
      backfillStore,
    });
    expect(await failingVersion.isServed("c")).toBe(false);
    expect(await failingAliases.isServed("c")).toBe(false);
  });

  // bd tea-rags-mcp-ejio7 — a build older than the twin writes into a v20
  // collection without `relativePathExact`; a keyword filter would miss those
  // points, so the gate heals them before it answers yes.
  describe("self-heal of points an older build wrote", () => {
    it("costs one single-point probe when no point lacks the twin, and writes nothing", async () => {
      const { gate, backfillStore } = capability({ c: 20 }, {}, [twinned("1", "a.ts"), twinned("2", "b.ts")]);
      expect(await gate.isServed("c")).toBe(true);
      expect(backfillStore.pageSizes).toEqual([1]);
      expect(backfillStore.batchSetPayload).not.toHaveBeenCalled();
    });

    it("backfills every point that has a path but lacks the twin, then serves", async () => {
      const points = [
        twinned("1", "a.ts"),
        oldBuildPoint("2", "b.ts"),
        oldBuildPoint("3", "b.ts"),
        oldBuildPoint("4", "c.ts"),
        { id: "meta", payload: { _type: "schema_metadata" } },
      ];
      const { gate } = capability({ c: 20 }, {}, points);
      expect(await gate.isServed("c")).toBe(true);
      for (const point of points.filter((p) => typeof p.payload.relativePath === "string")) {
        expect(point.payload.relativePathExact).toBe(point.payload.relativePath);
      }
      expect(points.find((p) => p.id === "meta")?.payload).toEqual({ _type: "schema_metadata" });
    });

    it("answers no — never throws — when the backfill cannot write", async () => {
      const { gate } = capability({ c: 20 }, {}, [oldBuildPoint("1", "a.ts")], { failWrites: true });
      expect(await gate.isServed("c")).toBe(false);
    });

    it("re-checks on every call, so points an older build writes after a yes are healed too", async () => {
      const points = [twinned("1", "a.ts")];
      const { gate, readSchemaVersion } = capability({ c: 20 }, {}, points);
      expect(await gate.isServed("c")).toBe(true);
      points.push(oldBuildPoint("2", "b.ts"));
      expect(await gate.isServed("c")).toBe(true);
      expect(points[1].payload.relativePathExact).toBe("b.ts");
      expect(readSchemaVersion).toHaveBeenCalledTimes(2);
    });

    it("coalesces concurrent callers on one physical collection into one check", async () => {
      const { gate, backfillStore } = capability({ code_x_v1: 20 }, { code_x: "code_x_v1" }, [
        oldBuildPoint("1", "a.ts"),
      ]);
      const answers = await Promise.all([gate.isServed("code_x"), gate.isServed("code_x_v1"), gate.isServed("code_x")]);
      expect(answers).toEqual([true, true, true]);
      expect(backfillStore.batchSetPayload).toHaveBeenCalledTimes(1);
      // probe + one backfill walk, not three of each
      expect(backfillStore.scrollPayloadPages).toHaveBeenCalledTimes(2);
    });
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
      scroll: vi.fn(async () => ({ points: [], next_page_offset: null })),
    };
    (manager as unknown as { client: unknown }).client = client;
    return { manager, client };
  }

  it("reads the schema metadata point of the alias's physical collection", async () => {
    const { manager, client } = managerOver(20);
    expect(await manager.servesRelativePathExact("code_x")).toBe(true);
    expect(client.retrieve).toHaveBeenCalledWith("code_x_v3", expect.anything());
  });

  it("probes the physical collection for points lacking the twin, one point at a time", async () => {
    const { manager, client } = managerOver(20);
    await manager.servesRelativePathExact("code_x");
    expect(client.scroll).toHaveBeenCalledWith(
      "code_x_v3",
      expect.objectContaining({
        limit: 1,
        filter: {
          must: [{ is_empty: { key: "relativePathExact" } }],
          must_not: [{ is_empty: { key: "relativePath" } }],
        },
      }),
    );
  });

  it("answers no below v20 and without a metadata point", async () => {
    expect(await managerOver(19).manager.servesRelativePathExact("code_x")).toBe(false);
    expect(await managerOver(undefined).manager.servesRelativePathExact("code_x")).toBe(false);
  });
});
