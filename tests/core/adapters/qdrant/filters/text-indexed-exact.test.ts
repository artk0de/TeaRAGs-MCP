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

  /**
   * An operator-named symbol has no token at all. The `word` tokenizer keeps
   * runs of alphanumerics and drops everything else, so `==`, `<=>`, `[]`, `<<`
   * and `-@` tokenize to NOTHING — and `symbolIdTextToken` reduces `Foo#==` to
   * the empty string outright, because it strips the `=`/`?`/`!` suffixes Ruby
   * setters carry. A zero-token `match: { text }` matches no point, so pairing
   * it would turn "exact" into "nothing": on a Ruby corpus `trace_path` would
   * silently drop every operator-named step it asked to hydrate.
   *
   * The only correct answer there is the unindexed `value` condition alone.
   * It costs a scan, which is the price of a symbol the index cannot describe.
   */
  it("drops the text half when the token holds nothing the tokenizer would store", () => {
    for (const [symbol, token] of [
      ["Foo#==", ""],
      ["Foo#!", ""],
      ["Foo#<=>", "<=>"],
      ["Foo#[]", "[]"],
      ["Foo#<<", "<<"],
      ["Foo#-@", "-@"],
    ] as const) {
      expect(exactMatchOnTextIndexed("symbolId", symbol, token)).toEqual([
        { key: "symbolId", match: { value: symbol } },
      ]);
    }
  });

  it("keeps the pair when the token holds any alphanumeric at all", () => {
    // `each_with_index` style names, and a token that is mostly punctuation but
    // not entirely: one storable run is enough for the text index to serve it.
    expect(exactMatchOnTextIndexed("symbolId", "Foo#bar", "bar")).toHaveLength(2);
    expect(exactMatchOnTextIndexed("symbolId", "Foo#coerce!", "coerce")).toHaveLength(2);
    expect(exactMatchOnTextIndexed("symbolId", "Foo#[]=x1", "[]=x1")).toHaveLength(2);
  });

  it("drops the text half for a path that is pure punctuation too", () => {
    // The rule is about the TOKEN, not about which key it belongs to.
    expect(exactMatchOnTextIndexed("relativePath", "---", "---")).toEqual([
      { key: "relativePath", match: { value: "---" } },
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
    expect(filter).toEqual({
      should: [
        {
          must: [
            { key: "symbolId", match: { text: "bar" } },
            { key: "symbolId", match: { value: "Foo#bar" } },
          ],
        },
        {
          must: [
            { key: "symbolId", match: { text: "qux" } },
            { key: "symbolId", match: { value: "Baz.qux" } },
          ],
        },
      ],
    });
  });

  // Per VALUE, not per call: one operator-named symbol in a trace_path hydration
  // must not cost the other branches their text condition.
  it("decides the shape branch by branch", () => {
    const filter = anyOfOnTextIndexed("symbolId", ["Foo#bar", "Foo#=="], (id) => id.split(/[#.]/).pop() ?? "");
    expect(filter).toEqual({
      should: [
        {
          must: [
            { key: "symbolId", match: { text: "bar" } },
            { key: "symbolId", match: { value: "Foo#bar" } },
          ],
        },
        { must: [{ key: "symbolId", match: { value: "Foo#==" } }] },
      ],
    });
  });

  // An empty `should` is not "match nothing" to Qdrant — it is "no condition",
  // i.e. match EVERYTHING. Returning one would hand a delete-by-filter the whole
  // collection. Every caller already early-returns on an empty set, so this
  // fires only on a caller bug (plain Error per .claude/rules/typed-errors.md).
  it("refuses an empty value set rather than returning a filter that matches everything", () => {
    expect(() => anyOfOnTextIndexed("relativePath", [])).toThrow(/empty/i);
  });
});
