/**
 * bd tea-rags-mcp-39xca.12 — one definition of "service point".
 *
 * Every code collection carries two points that are not chunks: the indexing
 * marker and the schema metadata point. Status, metrics, stats and the
 * enrichment recompute all have to leave them out of what they count, and they
 * agree only while they leave out the same set.
 */

import { describe, expect, it } from "vitest";

import { ENRICHMENT_SCAN_INDEXES } from "../../../../src/core/adapters/qdrant/schema-manager.js";
import {
  chunkPointsFilter,
  isServicePointPayload,
  SERVICE_POINT_TYPES,
  servicePointExclusions,
  withServicePointExclusions,
} from "../../../../src/core/adapters/qdrant/service-points.js";

describe("service points — the one definition", () => {
  it("recognises the indexing marker and the schema metadata point by _type", () => {
    expect(isServicePointPayload({ _type: "indexing_metadata", indexingComplete: true })).toBe(true);
    expect(isServicePointPayload({ _type: "schema_metadata", schemaVersion: 14, indexes: [] })).toBe(true);
  });

  it("treats a chunk payload, an empty payload and a missing payload as not a service point", () => {
    expect(isServicePointPayload({ relativePath: "src/a.ts", chunkType: "function" })).toBe(false);
    expect(isServicePointPayload({})).toBe(false);
    expect(isServicePointPayload(undefined)).toBe(false);
    expect(isServicePointPayload(null)).toBe(false);
  });

  it("excludes exactly the service-point types from the chunk filter", () => {
    const excluded = chunkPointsFilter().must_not.map((condition) =>
      "value" in condition.match ? condition.match.value : undefined,
    );

    expect([...excluded].sort()).toEqual([...SERVICE_POINT_TYPES].sort());
  });

  it("filters only on indexed keys, so a filtered count never degrades into a payload scan", () => {
    const indexed = new Set(ENRICHMENT_SCAN_INDEXES.map(({ path }) => path));

    for (const condition of servicePointExclusions()) {
      expect(indexed).toContain(condition.key);
    }
  });

  it("hands every caller its own condition list", () => {
    const first = servicePointExclusions();
    first.push({ key: "relativePath", match: { value: "x" } });

    expect(servicePointExclusions()).toHaveLength(SERVICE_POINT_TYPES.length);
  });
});

/**
 * bd tea-rags-mcp-xi2r9 (live probe): in a small collection the two service
 * points ranked 3rd and 5th in semantic_search, hybrid_search and find_similar
 * — every ranked query, because no ranked query excluded them. The exclusion is
 * applied once, in `QdrantSearchExecutor`, through this function.
 */
describe("withServicePointExclusions — the ranked-query filter", () => {
  const exclusions = () => servicePointExclusions();

  it("should turn an absent or empty filter into the exclusion alone", () => {
    expect(withServicePointExclusions(undefined)).toEqual({ must_not: exclusions() });
    expect(withServicePointExclusions({})).toEqual({ must_not: exclusions() });
  });

  it("should append to a Qdrant filter's must_not and keep its must and should", () => {
    const must = [{ key: "language", match: { value: "typescript" } }];
    const should = [{ key: "chunkType", match: { value: "function" } }];
    const mustNot = [{ key: "isTest", match: { value: true } }];

    expect(withServicePointExclusions({ must, should, must_not: mustNot })).toEqual({
      must,
      should,
      must_not: [...mustNot, ...exclusions()],
    });
  });

  it("should expand the flat key/value form as the executor reads it", () => {
    expect(withServicePointExclusions({ language: "ruby" })).toEqual({
      must: [{ key: "language", match: { value: "ruby" } }],
      must_not: exclusions(),
    });
  });

  it("should not mutate the caller's filter", () => {
    const filter = { must_not: [{ key: "isTest", match: { value: true } }] };

    withServicePointExclusions(filter);

    expect(filter.must_not).toHaveLength(1);
  });
});
