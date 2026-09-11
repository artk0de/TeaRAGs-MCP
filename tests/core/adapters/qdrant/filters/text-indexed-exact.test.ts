/**
 * bd tea-rags-mcp-ivp12 — exact matching on a TEXT-indexed key.
 *
 * The invariant under test is a PAIR: the indexed `text` condition supplies the
 * candidates, the `value` condition makes the answer exact. Either half alone is
 * wrong — `text` alone matches any path whose tokens are a superset, `value`
 * alone is unindexed and scans the whole collection.
 */

import { describe, expect, it } from "vitest";

import {
  anyOfOnTextIndexed,
  exactMatchOnTextIndexed,
  TEXT_INDEXED_KEYS,
} from "../../../../../src/core/adapters/qdrant/filters/text-indexed-exact.js";

describe("TEXT_INDEXED_KEYS", () => {
  it("names the payload keys whose Qdrant index is text", () => {
    // Membership follows the INDEX TYPE, not today's callers: nothing matches
    // `parentSymbolId` exactly yet, and it belongs on the list anyway so the
    // guard test sees the first one that does.
    expect([...TEXT_INDEXED_KEYS]).toEqual(["relativePath", "symbolId", "parentSymbolId"]);
  });
});

describe("exactMatchOnTextIndexed", () => {
  it("pairs an indexed text condition with the exact value condition, text first", () => {
    expect(exactMatchOnTextIndexed("relativePath", "src/core/indexing.ts")).toEqual([
      { key: "relativePath", match: { text: "src/core/indexing.ts" } },
      { key: "relativePath", match: { value: "src/core/indexing.ts" } },
    ]);
  });

  it("defaults the text token to the value itself", () => {
    const [text, value] = exactMatchOnTextIndexed("relativePath", "a/b.ts");
    expect(text.match.text).toBe("a/b.ts");
    expect(value.match.value).toBe("a/b.ts");
  });

  it("takes an explicit text token, so a symbolId can ride its one reliable token", () => {
    expect(exactMatchOnTextIndexed("symbolId", "CodegraphPayloadHealer#heal", "heal")).toEqual([
      { key: "symbolId", match: { text: "heal" } },
      { key: "symbolId", match: { value: "CodegraphPayloadHealer#heal" } },
    ]);
  });
});

describe("anyOfOnTextIndexed", () => {
  it("is a should of per-value exact pairs, never one MatchAny", () => {
    expect(anyOfOnTextIndexed("relativePath", ["a.ts", "b.ts"])).toEqual({
      should: [
        {
          must: [
            { key: "relativePath", match: { text: "a.ts" } },
            { key: "relativePath", match: { value: "a.ts" } },
          ],
        },
        {
          must: [
            { key: "relativePath", match: { text: "b.ts" } },
            { key: "relativePath", match: { value: "b.ts" } },
          ],
        },
      ],
    });
  });

  it("derives each text token through the supplied tokenOf", () => {
    const filter = anyOfOnTextIndexed("symbolId", ["Foo#bar", "Baz.qux"], (id) => id.split(/[#.]/).pop() ?? id);
    expect(filter.should.map((clause) => clause.must[0].match.text)).toEqual(["bar", "qux"]);
    expect(filter.should.map((clause) => clause.must[1].match.value)).toEqual(["Foo#bar", "Baz.qux"]);
  });

  it("yields an empty should for an empty value set", () => {
    expect(anyOfOnTextIndexed("relativePath", [])).toEqual({ should: [] });
  });
});
