/**
 * `payloadMatchesFilter` (bd tea-rags-mcp-xi2r9.4): the request filter applied
 * to a row Qdrant never stored — a working-tree delta row — with Qdrant's
 * semantics. A condition it cannot evaluate never admits the row.
 */

import { describe, expect, it } from "vitest";

import { payloadMatchesFilter } from "../../../../../src/core/adapters/qdrant/filters/payload-match.js";
import { anyOfOnTextIndexed } from "../../../../../src/core/adapters/qdrant/filters/text-indexed-exact.js";

const ROW = {
  relativePath: "src/core/foo-bar.ts",
  language: "typescript",
  chunkType: "function",
  symbolId: "Foo#bar",
  tags: ["x", "y"],
  git: { file: { ageDays: 10 } },
  empty: [],
  nothing: null,
};

describe("payloadMatchesFilter", () => {
  it("matches value, any and except", () => {
    expect(payloadMatchesFilter(ROW, { must: [{ key: "language", match: { value: "typescript" } }] })).toBe(true);
    expect(payloadMatchesFilter(ROW, { must: [{ key: "language", match: { value: "python" } }] })).toBe(false);
    expect(payloadMatchesFilter(ROW, { must: [{ key: "chunkType", match: { any: ["class", "function"] } }] })).toBe(
      true,
    );
    expect(payloadMatchesFilter(ROW, { must: [{ key: "tags", match: { value: "y" } }] })).toBe(true);
    expect(payloadMatchesFilter(ROW, { must: [{ key: "chunkType", match: { except: ["function"] } }] })).toBe(false);
  });

  it("matches text on the word tokens of the stored value", () => {
    expect(payloadMatchesFilter(ROW, { must: [{ key: "relativePath", match: { text: "core/foo" } }] })).toBe(true);
    expect(payloadMatchesFilter(ROW, { must: [{ key: "relativePath", match: { text: "baz" } }] })).toBe(false);
  });

  it("matches ranges on nested keys and fails them on a missing key", () => {
    expect(payloadMatchesFilter(ROW, { must: [{ key: "git.file.ageDays", range: { gte: 5, lt: 11 } }] })).toBe(true);
    expect(payloadMatchesFilter(ROW, { must: [{ key: "git.file.ageDays", range: { gt: 10 } }] })).toBe(false);
    expect(payloadMatchesFilter(ROW, { must: [{ key: "git.file.commitCount", range: { gte: 0 } }] })).toBe(false);
  });

  it("treats missing, null and [] as empty", () => {
    for (const key of ["missing", "nothing", "empty"]) {
      expect(payloadMatchesFilter(ROW, { must: [{ is_empty: { key } }] })).toBe(true);
    }
    expect(payloadMatchesFilter(ROW, { must: [{ is_empty: { key: "language" } }] })).toBe(false);
  });

  it("composes must, should and must_not recursively", () => {
    expect(
      payloadMatchesFilter(ROW, {
        must: [
          {
            should: [
              { key: "language", match: { value: "python" } },
              { key: "symbolId", match: { value: "Foo#bar" } },
            ],
          },
        ],
        must_not: [{ key: "chunkType", match: { value: "class" } }],
      }),
    ).toBe(true);
    expect(payloadMatchesFilter(ROW, { must_not: [{ key: "language", match: { value: "typescript" } }] })).toBe(false);
    expect(payloadMatchesFilter(ROW, { should: [{ key: "language", match: { value: "python" } }] })).toBe(false);
  });

  it("evaluates the text-indexed membership shape", () => {
    const filter = { must_not: [anyOfOnTextIndexed("relativePath", ["src/core/foo-bar.ts", "src/other.ts"])] };
    expect(payloadMatchesFilter(ROW, filter)).toBe(false);
    expect(payloadMatchesFilter({ ...ROW, relativePath: "src/core/foo.ts" }, filter)).toBe(true);
  });

  it("accepts Qdrant's flat key→value form", () => {
    expect(payloadMatchesFilter(ROW, { language: "typescript" })).toBe(true);
    expect(payloadMatchesFilter(ROW, { language: "python" })).toBe(false);
  });

  it("never admits a row on a condition it cannot evaluate, even under must_not", () => {
    expect(payloadMatchesFilter(ROW, { must: [{ has_id: [1] }] })).toBe(false);
    expect(payloadMatchesFilter(ROW, { must_not: [{ has_id: [1] }] })).toBe(false);
  });
});
