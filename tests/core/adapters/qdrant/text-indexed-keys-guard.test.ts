/**
 * bd tea-rags-mcp-ivp12 — the two guards that keep exact matching on a
 * TEXT-indexed payload key from silently degrading into a full collection scan.
 *
 * Qdrant keeps ONE index per payload key. `relativePath` and `symbolId` carry a
 * `text` index, and a text index does not serve `match.value` / `match.any`:
 * the planner falls back to reading the payload of every point. Measured on the
 * live self-index (22,415 points): a bare `relativePath` `match.value` cost
 * 677–1002 ms, a `should` of 50 of them 33,597 ms. The text+value pair that
 * `exactMatchOnTextIndexed` builds costs 1.7–2.0 ms for the same exact answer.
 *
 * Neither guard can be satisfied by a comment: (a) pins what the schema
 * actually creates, (b) pins that no source file builds the degraded condition
 * by hand.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { TEXT_INDEXED_KEYS } from "../../../../src/core/adapters/qdrant/filters/text-indexed-exact.js";
import { SchemaManager } from "../../../../src/core/adapters/qdrant/schema-manager.js";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../src");

/** The one file allowed to name a text-indexed key beside `match: { value }`. */
const HELPER_SOURCE = join(SRC_DIR, "core/adapters/qdrant/filters/text-indexed-exact.ts");

/**
 * `key: "<text-indexed key>"` immediately followed by the degraded predicate,
 * with every run of whitespace collapsed first so the two-line shape
 * (`key:` on one line, `match:` on the next) is caught alongside the one-line
 * one.
 */
const DEGRADED_MATCH = new RegExp(`key: "(${TEXT_INDEXED_KEYS.join("|")})", match: \\{ (value|any)\\b`, "g");

function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

function findDegradedMatches(): string[] {
  const offenders: string[] = [];
  for (const file of listSourceFiles(SRC_DIR)) {
    if (file === HELPER_SOURCE) continue;
    const normalized = readFileSync(file, "utf8").replace(/\s+/g, " ");
    for (const hit of normalized.matchAll(DEGRADED_MATCH)) {
      offenders.push(`${relative(SRC_DIR, file)}: ${hit[0]}`);
    }
  }
  return offenders;
}

describe("exact matching on a text-indexed key goes through the helper", () => {
  it("finds no bare match.value / match.any on a text-indexed key anywhere in src", () => {
    // The message is the point: a failure names the file and the condition, so
    // the fix (route it through `exactMatchOnTextIndexed`) needs no archaeology.
    expect(findDegradedMatches()).toEqual([]);
  });
});

describe("SchemaManager.initializeSchema index types for text-indexed keys", () => {
  const qdrant = {
    getCollectionInfo: vi.fn(),
    createPayloadIndex: vi.fn(),
    addPoints: vi.fn(),
    addPointsWithSparse: vi.fn(),
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    qdrant.getCollectionInfo.mockResolvedValue({ vectorSize: 768, hybridEnabled: false });
    qdrant.createPayloadIndex.mockResolvedValue(undefined);
    qdrant.addPoints.mockResolvedValue(undefined);
    await new SchemaManager(qdrant as never, 15).initializeSchema("fresh");
  });

  it("creates a text index for every text-indexed key", () => {
    for (const key of TEXT_INDEXED_KEYS) {
      expect(qdrant.createPayloadIndex).toHaveBeenCalledWith("fresh", key, "text");
    }
  });

  it("creates no keyword index on a text-indexed key", () => {
    // A keyword index created here is DEAD: the text index on the same key
    // replaces it, and the only thing it leaves behind is the belief that
    // `match.value` is served.
    for (const key of TEXT_INDEXED_KEYS) {
      expect(qdrant.createPayloadIndex).not.toHaveBeenCalledWith("fresh", key, "keyword");
    }
  });
});
