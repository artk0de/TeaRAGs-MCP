/**
 * `RelativePathExactCapability` (bd tea-rags-mcp-ejio7): the ONE place that
 * decides whether a collection's path-membership filters may use a keyword
 * MatchAny on `relativePathExact`. Yes only when the collection's schema
 * version is at least the v20 backfill's — otherwise the key may be missing on
 * some points and a keyword filter would silently miss them — and at or above
 * it, only after healing any point an older build wrote without the key.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import { QdrantManager } from "../../../../src/core/adapters/qdrant/client.js";
import { payloadMatchesFilter } from "../../../../src/core/adapters/qdrant/filters/payload-match.js";
import { RelativePathExactCapability } from "../../../../src/core/adapters/qdrant/relative-path-exact-capability.js";

type StoredPoint = { id: string; payload: Record<string, unknown> };

/**
 * Whether a filter admits a point by the ABSENCE of a value — `is_empty` under
 * `must`/`should`, or a value match under `must_not`. On Qdrant 1.18.2 such a
 * condition also admits the unvacuumed dead versions `set_payload` leaves
 * behind (it is copy-on-write); presence conditions do not.
 */
function admitsByAbsence(filter: Record<string, unknown> | undefined): boolean {
  if (!filter) return false;
  const conditions = (clause: string) =>
    Array.isArray(filter[clause]) ? (filter[clause] as Record<string, unknown>[]) : [];
  return (
    [...conditions("must"), ...conditions("should")].some((c) => "is_empty" in c) ||
    conditions("must_not").some((c) => "match" in c)
  );
}

/**
 * The backfill store over an in-memory collection that models Qdrant 1.18.2
 * after a `set_payload` sweep: `deadVersions` are older payload versions of
 * live points, not yet vacuumed.
 *
 * - `countPoints` is exact over live points, plus the dead versions an
 *   absence condition admits.
 * - `scrollPayloadPages` pages in id order through the live points the filter
 *   admits, plus — under an absence condition — the LIVE point of every dead
 *   version it admits: the scroll hands back the live payload, which may
 *   already carry the key (a false candidate).
 * - `batchSetPayload` merges into the live payload. `failWrites` / `failCounts`
 *   make those calls throw.
 */
function backfillStoreOver(
  points: StoredPoint[],
  options: { failWrites?: boolean; failCounts?: boolean; deadVersions?: StoredPoint[] } = {},
) {
  const pageSizes: (number | undefined)[] = [];
  const deadVersions = options.deadVersions ?? [];
  const matches = (payload: Record<string, unknown>, filter?: Record<string, unknown>) =>
    filter === undefined || payloadMatchesFilter(payload, filter);
  const store = {
    pageSizes,
    countPoints: vi.fn(async (_collection: string, filter?: Record<string, unknown>) => {
      if (options.failCounts) throw new Error("qdrant down");
      const live = points.filter((p) => matches(p.payload, filter)).length;
      const dead = admitsByAbsence(filter) ? deadVersions.filter((p) => matches(p.payload, filter)).length : 0;
      return live + dead;
    }),
    scrollPayloadPages: vi.fn(async function* (
      _collection: string,
      request: { payloadInclude: string[]; filter?: Record<string, unknown>; pageSize?: number },
    ) {
      const pageSize = request.pageSize ?? 1000;
      const admitted = (p: StoredPoint) =>
        matches(p.payload, request.filter) ||
        (admitsByAbsence(request.filter) &&
          deadVersions.some((dead) => dead.id === p.id && matches(dead.payload, request.filter)));
      const sorted = [...points].sort((a, b) => a.id.localeCompare(b.id));
      let afterId: string | undefined;
      for (;;) {
        pageSizes.push(request.pageSize);
        const page = sorted
          .filter((p) => afterId === undefined || p.id > afterId)
          .filter(admitted)
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
// The pre-backfill version of a point the backfill `set_payload`ed, still unvacuumed.
const deadVersionOf = (point: StoredPoint): StoredPoint => ({
  id: point.id,
  payload: { relativePath: point.payload.relativePath },
});

const writtenIds = (store: ReturnType<typeof backfillStoreOver>) =>
  store.batchSetPayload.mock.calls.flatMap((call) => call[1].flatMap((op) => op.points));

function capability(
  versions: Record<string, number | undefined>,
  aliases: Record<string, string> = {},
  points: StoredPoint[] = [],
  storeOptions: { failWrites?: boolean; failCounts?: boolean; deadVersions?: StoredPoint[] } = {},
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
  afterEach(() => {
    vi.useRealTimers();
  });

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
    expect(backfillStore.countPoints).not.toHaveBeenCalled();
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
    it("costs two exact counts and no scroll when no point lacks the twin, and writes nothing", async () => {
      const { gate, backfillStore } = capability({ c: 20 }, {}, [twinned("1", "a.ts"), twinned("2", "b.ts")]);
      expect(await gate.isServed("c")).toBe(true);
      expect(backfillStore.countPoints).toHaveBeenCalledTimes(2);
      expect(backfillStore.scrollPayloadPages).not.toHaveBeenCalled();
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

    it("answers no — never throws — when the probe cannot count, and does not remember the no", async () => {
      const points = [twinned("1", "a.ts")];
      const { gate, backfillStore } = capability({ c: 20 }, {}, points, { failCounts: true });
      expect(await gate.isServed("c")).toBe(false);
      expect(backfillStore.batchSetPayload).not.toHaveBeenCalled();
      expect(await gate.isServed("c")).toBe(false);
      expect(backfillStore.countPoints.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    it("coalesces concurrent callers on one physical collection into one check", async () => {
      const { gate, backfillStore } = capability({ code_x_v1: 20 }, { code_x: "code_x_v1" }, [
        oldBuildPoint("1", "a.ts"),
      ]);
      const answers = await Promise.all([gate.isServed("code_x"), gate.isServed("code_x_v1"), gate.isServed("code_x")]);
      expect(answers).toEqual([true, true, true]);
      expect(backfillStore.batchSetPayload).toHaveBeenCalledTimes(1);
      // one probe (two counts) + one backfill walk, not three of each
      expect(backfillStore.countPoints).toHaveBeenCalledTimes(2);
      expect(backfillStore.scrollPayloadPages).toHaveBeenCalledTimes(1);
    });
  });

  // Measured on code_8b243ffe_v71 (Qdrant 1.18.2, 2026-10-09): right after the
  // v20 backfill `set_payload`ed 45 700 points, an `is_empty` probe counted
  // 29 104 unvacuumed dead versions as "missing the twin" while every live
  // point carried it, so the gate rewrote ~29k correct points per call — and
  // each rewrite left another dead version behind.
  describe("unvacuumed dead versions after set_payload", () => {
    function healedCollectionWithDeadVersions() {
      const points = [twinned("1", "a.ts"), twinned("2", "b.ts"), twinned("3", "c.ts")];
      return { points, deadVersions: points.map(deadVersionOf) };
    }

    it("counts presence, so dead versions never make a healed collection look unhealed", async () => {
      const { points, deadVersions } = healedCollectionWithDeadVersions();
      const { gate, backfillStore } = capability({ c: 20 }, {}, points, { deadVersions });
      expect(await gate.isServed("c")).toBe(true);
      expect(backfillStore.scrollPayloadPages).not.toHaveBeenCalled();
      expect(backfillStore.batchSetPayload).not.toHaveBeenCalled();
    });

    it("writes only the points whose live payload lacks the twin, never a false candidate", async () => {
      const { points, deadVersions } = healedCollectionWithDeadVersions();
      points.push(oldBuildPoint("4", "d.ts"), oldBuildPoint("5", "e.ts"));
      const { gate, backfillStore } = capability({ c: 20 }, {}, points, { deadVersions });
      expect(await gate.isServed("c")).toBe(true);
      expect(writtenIds(backfillStore).sort()).toEqual(["4", "5"]);
      expect(points.every((p) => p.payload.relativePathExact === p.payload.relativePath)).toBe(true);
    });

    it("stops walking the candidates once the counted missing points are written", async () => {
      const points = Array.from({ length: 2_500 }, (_, i) => twinned(`p${String(i).padStart(5, "0")}`, `f${i}.ts`));
      const deadVersions = points.map(deadVersionOf);
      const missing = oldBuildPoint("a-missing", "m.ts"); // sorts before every false candidate
      points.push(missing);
      const { gate, backfillStore } = capability({ c: 20 }, {}, points, { deadVersions });
      expect(await gate.isServed("c")).toBe(true);
      expect(missing.payload.relativePathExact).toBe("m.ts");
      expect(writtenIds(backfillStore)).toEqual(["a-missing"]);
      // the first page held the one missing point; the other two pages of false candidates are never read
      expect(backfillStore.pageSizes).toHaveLength(1);
    });
  });

  describe("yes is remembered per physical collection for a bounded time", () => {
    it("serves a repeat call inside the TTL without probing again", async () => {
      vi.useFakeTimers();
      const { gate, backfillStore, readSchemaVersion } = capability({ c: 20 }, {}, [twinned("1", "a.ts")]);
      expect(await gate.isServed("c")).toBe(true);
      vi.advanceTimersByTime(59_000);
      expect(await gate.isServed("c")).toBe(true);
      expect(readSchemaVersion).toHaveBeenCalledTimes(1);
      expect(backfillStore.countPoints).toHaveBeenCalledTimes(2);
    });

    it("re-probes after the TTL, so points an older build wrote after a yes are healed", async () => {
      vi.useFakeTimers();
      const points = [twinned("1", "a.ts")];
      const { gate, readSchemaVersion } = capability({ c: 20 }, {}, points);
      expect(await gate.isServed("c")).toBe(true);
      points.push(oldBuildPoint("2", "b.ts"));
      vi.advanceTimersByTime(60_001);
      expect(await gate.isServed("c")).toBe(true);
      expect(points[1].payload.relativePathExact).toBe("b.ts");
      expect(readSchemaVersion).toHaveBeenCalledTimes(2);
    });

    it("keys the remembered yes by the PHYSICAL collection, so an alias switch is checked afresh", async () => {
      vi.useFakeTimers();
      const aliases: Record<string, string> = { code_x: "code_x_v1" };
      const { gate } = capability({ code_x_v1: 20, code_x_v2: 19 }, aliases);
      expect(await gate.isServed("code_x")).toBe(true);
      aliases.code_x = "code_x_v2";
      expect(await gate.isServed("code_x")).toBe(false);
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
      count: vi.fn(async () => ({ count: 7 })),
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

  it("probes the physical collection with exact PRESENCE counts, and scrolls nothing when they agree", async () => {
    const { manager, client } = managerOver(20);
    await manager.servesRelativePathExact("code_x");
    expect(client.count).toHaveBeenCalledWith("code_x_v3", {
      exact: true,
      filter: { must_not: [{ is_empty: { key: "relativePath" } }] },
    });
    expect(client.count).toHaveBeenCalledWith("code_x_v3", {
      exact: true,
      filter: { must_not: [{ is_empty: { key: "relativePath" } }, { is_empty: { key: "relativePathExact" } }] },
    });
    expect(client.scroll).not.toHaveBeenCalled();
  });

  it("answers no below v20 and without a metadata point", async () => {
    expect(await managerOver(19).manager.servesRelativePathExact("code_x")).toBe(false);
    expect(await managerOver(undefined).manager.servesRelativePathExact("code_x")).toBe(false);
  });
});
