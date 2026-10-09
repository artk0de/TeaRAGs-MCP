import { describe, expect, it, vi } from "vitest";

import { payloadMatchesFilter } from "../../../../../../src/core/adapters/qdrant/filters/payload-match.js";
import { SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS } from "../../../../../../src/core/adapters/qdrant/schema-manager.js";
import { RELATIVE_PATH_EXACT_SCHEMA_VERSION } from "../../../../../../src/core/contracts/relative-path-exact.js";
import { SchemaV20RelativePathExactKeyword } from "../../../../../../src/core/domains/maintenance/migration/schema_migrations/schema-v20-relative-path-exact-keyword.js";
import type { IndexStore } from "../../../../../../src/core/domains/maintenance/migration/types.js";

type StoredPoint = { id: string; payload: Record<string, unknown> };

/**
 * An index store over an in-memory collection. `scrollPayloadPages` pages in
 * id order through the points its filter admits, returning only the asked
 * keys, and re-reads the live payload per page — so a write made between pages
 * is visible to the next one, as it is on Qdrant. `failOnWrite` makes the Nth
 * `batchSetPayload` call throw, standing in for a crash mid-backfill.
 * `falseCandidates` are ids the scroll admits although their live payload
 * already carries the twin — what Qdrant 1.18.2 does after a `set_payload`
 * sweep, when the missing-twin filter's `is_empty` admits unvacuumed dead
 * versions and the scroll hands back the live point.
 */
function storeHolding(points: StoredPoint[], options: { failOnWrite?: number; falseCandidates?: string[] } = {}) {
  const inventory = new Map<string, string>();
  let writes = 0;
  const pageRequests: { payloadInclude: string[]; filter?: Record<string, unknown>; pageSize?: number }[] = [];
  const store = {
    inventory,
    pageRequests,
    getSchemaVersion: vi.fn().mockResolvedValue(19),
    ensureIndex: vi.fn(async (_c: string, field: string, type: string) => {
      if (inventory.has(field)) return false;
      inventory.set(field, type);
      return true;
    }),
    storeSchemaVersion: vi.fn().mockResolvedValue(undefined),
    hasPayloadIndex: vi.fn(async (_c: string, field: string) => inventory.has(field)),
    getCollectionInfo: vi.fn().mockResolvedValue({ hybridEnabled: false, vectorSize: 384 }),
    updateSparseConfig: vi.fn().mockResolvedValue(undefined),
    deletePointsByFilter: vi.fn().mockResolvedValue(undefined),
    scrollPayloadPages: vi.fn(async function* (
      _c: string,
      request: { payloadInclude: string[]; filter?: Record<string, unknown>; pageSize?: number },
    ) {
      pageRequests.push(request);
      const pageSize = request.pageSize ?? 1000;
      const sorted = [...points].sort((a, b) => a.id.localeCompare(b.id));
      let afterId: string | undefined;
      for (;;) {
        const page = sorted
          .filter((p) => afterId === undefined || p.id > afterId)
          .filter(
            (p) =>
              request.filter === undefined ||
              payloadMatchesFilter(p.payload, request.filter) ||
              (options.falseCandidates ?? []).includes(p.id),
          )
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
      async (_c: string, ops: { payload: Record<string, unknown>; points: (string | number)[] }[]) => {
        writes++;
        if (options.failOnWrite === writes) throw new Error("connection reset");
        for (const op of ops) {
          for (const id of op.points) {
            const point = points.find((p) => p.id === id);
            if (point) Object.assign(point.payload, op.payload);
          }
        }
      },
    ),
  } satisfies IndexStore & Record<string, unknown>;
  return store;
}

const COLLECTION = "code_test";

const chunk = (id: string, relativePath: string): StoredPoint => ({
  id,
  payload: { relativePath, content: `body of ${id}`, startLine: 1 },
});

/**
 * bd tea-rags-mcp-ejio7 — `relativePath` carries a TEXT index, so an exact
 * path-membership filter cannot be one MatchAny on it. v20 gives every
 * existing point a keyword-indexed twin, `relativePathExact`, so the
 * membership consumers can switch once the collection is stamped at v20.
 */
describe("SchemaV20RelativePathExactKeyword", () => {
  it("declares the version the membership gate reads, and a matching name", () => {
    const migration = new SchemaV20RelativePathExactKeyword(COLLECTION, storeHolding([]));
    expect(migration.version).toBe(RELATIVE_PATH_EXACT_SCHEMA_VERSION);
    expect(migration.version).toBe(20);
    expect(migration.name).toBe("schema-v20-relative-path-exact-keyword");
  });

  it("backfills relativePathExact on every point that has a relativePath, then keyword-indexes it", async () => {
    const points = [chunk("a1", "src/a.ts"), chunk("a2", "src/a.ts"), chunk("b1", "src/b.ts")];
    const store = storeHolding(points);

    const result = await new SchemaV20RelativePathExactKeyword(COLLECTION, store).apply();

    for (const point of points) expect(point.payload.relativePathExact).toBe(point.payload.relativePath);
    expect(store.inventory.get("relativePathExact")).toBe("keyword");
    expect(store.ensureIndex).toHaveBeenCalledWith(COLLECTION, "relativePathExact", "keyword");
    expect(result.applied).toEqual(["relativePathExact backfilled on 3 points", "relativePathExact:keyword"]);
  });

  it("groups each page's point ids by path: one set_payload operation per distinct path", async () => {
    const store = storeHolding([chunk("a1", "src/a.ts"), chunk("a2", "src/a.ts"), chunk("b1", "src/b.ts")]);

    await new SchemaV20RelativePathExactKeyword(COLLECTION, store).apply();

    expect(store.batchSetPayload).toHaveBeenCalledTimes(1);
    expect(store.batchSetPayload.mock.calls[0][1]).toEqual([
      { payload: { relativePathExact: "src/a.ts" }, points: ["a1", "a2"] },
      { payload: { relativePathExact: "src/b.ts" }, points: ["b1"] },
    ]);
  });

  it("reads only relativePath and its twin — never content — and asks only for points that still lack the key", async () => {
    const store = storeHolding([chunk("a1", "src/a.ts")]);

    await new SchemaV20RelativePathExactKeyword(COLLECTION, store).apply();

    expect(store.pageRequests).toHaveLength(1);
    const [request] = store.pageRequests;
    expect(request.payloadInclude).toEqual(["relativePath", "relativePathExact"]);
    expect(request.filter).toBeDefined();
    const filter = request.filter as Record<string, unknown>;
    expect(payloadMatchesFilter({ relativePath: "x.ts" }, filter)).toBe(true);
    expect(payloadMatchesFilter({ relativePath: "x.ts", relativePathExact: "x.ts" }, filter)).toBe(false);
    expect(payloadMatchesFilter({ _type: "schema_metadata" }, filter)).toBe(false);
  });

  it("pages through a collection larger than one page with bounded pages and bounded writes", async () => {
    const points = Array.from({ length: 2_500 }, (_, i) => chunk(`p${String(i).padStart(5, "0")}`, `src/f${i % 7}.ts`));
    const store = storeHolding(points);

    const result = await new SchemaV20RelativePathExactKeyword(COLLECTION, store).apply();

    expect(store.pageRequests[0].pageSize).toBeLessThanOrEqual(1_000);
    expect(store.batchSetPayload).toHaveBeenCalledTimes(3);
    for (const call of store.batchSetPayload.mock.calls) {
      const ids = call[1].flatMap((op) => op.points);
      expect(ids.length).toBeLessThanOrEqual(1_000);
    }
    expect(points.every((p) => p.payload.relativePathExact === p.payload.relativePath)).toBe(true);
    expect(result.applied[0]).toBe("relativePathExact backfilled on 2500 points");
  });

  it("skips points without a relativePath: the schema metadata point, documents", async () => {
    const metadata: StoredPoint = { id: "m", payload: { _type: "schema_metadata", schemaVersion: 19 } };
    const doc: StoredPoint = { id: "d", payload: { content: "a document", relativePath: "" } };
    const store = storeHolding([metadata, doc, chunk("a1", "src/a.ts")]);

    await new SchemaV20RelativePathExactKeyword(COLLECTION, store).apply();

    expect(metadata.payload).not.toHaveProperty("relativePathExact");
    expect(doc.payload).not.toHaveProperty("relativePathExact");
    expect(store.batchSetPayload.mock.calls.flatMap((call) => call[1].flatMap((op) => op.points))).toEqual(["a1"]);
  });

  it("is idempotent — a second pass writes nothing and creates no index", async () => {
    const store = storeHolding([chunk("a1", "src/a.ts"), chunk("b1", "src/b.ts")]);
    const migration = new SchemaV20RelativePathExactKeyword(COLLECTION, store);

    await migration.apply();
    store.batchSetPayload.mockClear();
    store.ensureIndex.mockClear();
    const second = await migration.apply();

    expect(store.batchSetPayload).not.toHaveBeenCalled();
    await expect(store.ensureIndex.mock.results[0].value).resolves.toBe(false);
    expect(second.applied).toEqual(["relativePathExact backfilled on 0 points", "relativePathExact:keyword"]);
  });

  it("resumes after a crash mid-backfill: the re-run completes exactly the points the first run left", async () => {
    const points = Array.from({ length: 2_500 }, (_, i) => chunk(`p${String(i).padStart(5, "0")}`, `src/f${i}.ts`));
    const store = storeHolding(points, { failOnWrite: 2 });
    const migration = new SchemaV20RelativePathExactKeyword(COLLECTION, store);

    await expect(migration.apply()).rejects.toThrow("connection reset");
    expect(store.inventory.has("relativePathExact")).toBe(false);
    const done = points.filter((p) => p.payload.relativePathExact !== undefined).length;
    expect(done).toBe(1_000);

    const resumed = await migration.apply();

    expect(points.every((p) => p.payload.relativePathExact === p.payload.relativePath)).toBe(true);
    expect(resumed.applied[0]).toBe("relativePathExact backfilled on 1500 points");
    expect(store.inventory.get("relativePathExact")).toBe("keyword");
  });

  it("never rewrites a candidate whose live payload already carries the twin (unvacuumed dead versions)", async () => {
    const done = [chunk("a1", "src/a.ts"), chunk("a2", "src/a.ts")];
    for (const point of done) point.payload.relativePathExact = point.payload.relativePath;
    const left = chunk("b1", "src/b.ts");
    const store = storeHolding([...done, left], { falseCandidates: ["a1", "a2"] });

    const result = await new SchemaV20RelativePathExactKeyword(COLLECTION, store).apply();

    expect(store.batchSetPayload.mock.calls.flatMap((call) => call[1].flatMap((op) => op.points))).toEqual(["b1"]);
    expect(left.payload.relativePathExact).toBe("src/b.ts");
    expect(result.applied[0]).toBe("relativePathExact backfilled on 1 points");
  });

  it("names relativePathExact among the schema-managed index keys, so v16 never drops it", () => {
    expect(SCHEMA_MANAGED_PAYLOAD_INDEX_KEYS).toContain("relativePathExact");
  });
});
