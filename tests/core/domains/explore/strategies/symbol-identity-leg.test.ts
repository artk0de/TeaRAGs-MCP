import { describe, expect, it } from "vitest";

import {
  buildSymbolIdentityFilter,
  isSymbolIdentifierQuery,
} from "../../../../../src/core/domains/explore/strategies/symbol-identity-leg.js";

describe("isSymbolIdentifierQuery", () => {
  it.each([
    "Foo",
    "Acme::User",
    "Platform::Async::Operation::Worker",
    "Outer.Nested",
    "Reranker#rerank",
    "Reranker.create",
    "valid?",
    "save!",
    "Foo#updated=",
    "__init__",
    "$scope",
    "  Reranker#rerank  ",
  ])("accepts the single code identifier %j", (query) => {
    expect(isSymbolIdentifierQuery(query)).toBe(true);
  });

  it.each([
    "how does indexing work",
    "foo bar",
    "",
    "   ",
    "Foo::",
    "::Foo",
    "Foo..bar",
    "Foo#",
    "a-b",
    "src/a/b",
    "valid?!",
    "1Foo",
    "a=b",
    "Foo#<=>",
  ])("rejects %j", (query) => {
    expect(isSymbolIdentifierQuery(query)).toBe(false);
  });

  it("rejects an absent query", () => {
    expect(isSymbolIdentifierQuery(undefined)).toBe(false);
  });
});

describe("buildSymbolIdentityFilter", () => {
  it("matches the symbol EXACTLY on parentSymbolId OR symbolId, each index-served by its last-segment token", () => {
    expect(buildSymbolIdentityFilter("Platform::Async::Operation::Worker")).toEqual({
      should: [
        {
          must: [
            { key: "parentSymbolId", match: { text: "Worker" } },
            { key: "parentSymbolId", match: { value: "Platform::Async::Operation::Worker" } },
          ],
        },
        {
          must: [
            { key: "symbolId", match: { text: "Worker" } },
            { key: "symbolId", match: { value: "Platform::Async::Operation::Worker" } },
          ],
        },
      ],
    });
  });

  it("strips a method-name suffix from the text token but keeps it in the exact value", () => {
    expect(buildSymbolIdentityFilter("valid?")).toEqual({
      should: [
        {
          must: [
            { key: "parentSymbolId", match: { text: "valid" } },
            { key: "parentSymbolId", match: { value: "valid?" } },
          ],
        },
        {
          must: [
            { key: "symbolId", match: { text: "valid" } },
            { key: "symbolId", match: { value: "valid?" } },
          ],
        },
      ],
    });
  });

  it("matches on the trimmed identifier", () => {
    const filter = buildSymbolIdentityFilter("  Reranker#rerank ") as { should: { must: unknown[] }[] };
    expect(filter.should[1].must).toEqual([
      { key: "symbolId", match: { text: "rerank" } },
      { key: "symbolId", match: { value: "Reranker#rerank" } },
    ]);
  });
});
