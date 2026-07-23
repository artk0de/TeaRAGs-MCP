import { describe, expect, it } from "vitest";

import { INLINE_TYPE_SOURCES } from "../../../../../../../src/core/domains/language/ruby/walker/type-sources/index.js";

describe("INLINE_TYPE_SOURCES", () => {
  it("registers yard + associations + ast adapters as a typed array (source-precedence order)", () => {
    expect(INLINE_TYPE_SOURCES.map((s) => s.name)).toEqual(["yard", "associations", "ast"]);
  });
});
