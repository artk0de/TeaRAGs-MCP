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

const KEY_ALTERNATION = TEXT_INDEXED_KEYS.join("|");

/**
 * The degraded condition, in both property orders. Every run of whitespace is
 * collapsed before matching, so the two-line shape (`key:` on one line,
 * `match:` on the next) is caught alongside the one-line one, and the spaces
 * inside the braces are optional because the source is not always
 * prettier-formatted when the scan runs.
 *
 * Deliberately NOT one clever regex: a scan that quietly stops matching is the
 * same failure as no scan at all, so each shape is its own readable pattern and
 * {@link findDegradedIn} is exercised against synthetic offenders below.
 */
const DEGRADED_MATCHERS = [
  new RegExp(`key: ?"(?:${KEY_ALTERNATION})", ?match: ?\\{ ?(?:value|any)\\b`, "g"),
  new RegExp(`match: ?\\{ ?(?:value|any)\\b[^{}]*\\}, ?key: ?"(?:${KEY_ALTERNATION})"`, "g"),
];

function listSourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts")) found.push(full);
  }
  return found;
}

/** Every degraded condition in one file's text, whitespace-normalized. */
function findDegradedIn(source: string): string[] {
  const normalized = source.replace(/\s+/g, " ");
  return DEGRADED_MATCHERS.flatMap((matcher) => [...normalized.matchAll(matcher)].map((hit) => hit[0]));
}

function findDegradedMatches(): string[] {
  const offenders: string[] = [];
  for (const file of listSourceFiles(SRC_DIR)) {
    if (file === HELPER_SOURCE) continue;
    for (const hit of findDegradedIn(readFileSync(file, "utf8"))) {
      offenders.push(`${relative(SRC_DIR, file)}: ${hit}`);
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

  // A guard nobody has seen fail is a guard nobody knows works. These are the
  // spellings the same condition takes in real source.
  it("recognizes the degraded condition in every spelling it is written in", () => {
    const offenders = [
      `{ key: "relativePath", match: { value: path } }`,
      `{ key: "relativePath", match: {value: path} }`,
      `{\n  key: "symbolId",\n  match: { value: id },\n}`,
      `{ key: "relativePath", match: { any: paths } }`,
      `{ match: { value: path }, key: "relativePath" }`,
      `{ match: {any: paths}, key: "parentSymbolId" }`,
    ];
    for (const source of offenders) {
      expect(findDegradedIn(source), source).not.toEqual([]);
    }
  });

  it("passes the shapes that are not the degraded condition", () => {
    const allowed = [
      `{ key: "relativePath", match: { text: query } }`,
      `{ key: "language", match: { value: "ruby" } }`,
      `{ key: "fileExtension", match: { any: exts } }`,
      `{ is_empty: { key: "relativePath" } }`,
    ];
    for (const source of allowed) {
      expect(findDegradedIn(source), source).toEqual([]);
    }
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

  // The direction that actually catches drift. Checking only that every listed
  // key gets a text index says nothing about a key given one WITHOUT being
  // listed — and that is exactly what happened to `symbolId` (v8) and
  // `parentSymbolId` (v11/v15): both quietly acquired a text index, neither was
  // named anywhere a caller would look, and every exact match on them scanned
  // the collection for six schema versions with nothing failing.
  it("gives a text index to no key outside TEXT_INDEXED_KEYS", () => {
    const textIndexed = qdrant.createPayloadIndex.mock.calls
      .filter(([, , schema]: [string, string, string]) => schema === "text")
      .map(([, key]: [string, string]) => key);

    expect([...new Set(textIndexed)].sort()).toEqual([...TEXT_INDEXED_KEYS].sort());
  });
});
