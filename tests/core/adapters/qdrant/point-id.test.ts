/**
 * `toQdrantPointId` — the id a point is stored under (bd tea-rags-mcp-xi2r9).
 *
 * Qdrant accepts only UUIDs and unsigned integers, so ingest's `chunk_<hex>`
 * ids are mapped before every write. A reader that hands out ids for rows it
 * built itself (the working-tree overlay) must map them the same way, or the
 * id it returns addresses no point — `find_similar` answered such an id with
 * a 400 Bad Request.
 */
import { describe, expect, it } from "vitest";

import { toQdrantPointId } from "../../../../src/core/adapters/qdrant/point-id.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("toQdrantPointId", () => {
  it("should map a chunk id to a deterministic UUID", () => {
    const id = toQdrantPointId("chunk_e61bd876bd62659c");

    expect(id).toMatch(UUID);
    expect(toQdrantPointId("chunk_e61bd876bd62659c")).toBe(id);
    expect(toQdrantPointId("chunk_e61bd876bd62659d")).not.toBe(id);
  });

  it("should pass a UUID and a number through unchanged", () => {
    expect(toQdrantPointId("20054299-0bf6-2a2a-065d-fde15c6f8718")).toBe("20054299-0bf6-2a2a-065d-fde15c6f8718");
    expect(toQdrantPointId(42)).toBe(42);
  });

  it("should be idempotent, so an already-mapped id is never mapped twice", () => {
    const once = toQdrantPointId("chunk_0000000000000000");

    expect(toQdrantPointId(once)).toBe(once);
  });
});
