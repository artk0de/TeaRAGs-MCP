import { describe, expect, it } from "vitest";

import { INLINE_TYPE_SOURCES } from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/index.js";

describe("INLINE_TYPE_SOURCES", () => {
  it("registers yard + associations + draper + body-last-expr + ast adapters as a typed array (source-precedence order)", () => {
    // draper (decorated-model convention, adx5p.9) ranks with the other
    // macro-declared conventions: below an explicit annotation, above any
    // body/AST inference. Mirrors DEFAULT_SOURCE_ORDER in type-fact-store.ts.
    expect(INLINE_TYPE_SOURCES.map((s) => s.name)).toEqual([
      "yard",
      "associations",
      "draper",
      "body-last-expr",
      "ast",
    ]);
  });
});
