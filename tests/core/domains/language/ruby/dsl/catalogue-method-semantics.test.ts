import { describe, expect, it } from "vitest";

import {
  RUBY_INSTANCE_RETURNING,
  RUBY_RELATION_RETURNING,
} from "../../../../../../src/core/domains/language/ruby/dsl/index.js";

describe("composed method-semantics facets", () => {
  it("instanceReturning unions ruby-core {new} with AR factories/finders", () => {
    expect(RUBY_INSTANCE_RETURNING.has("new")).toBe(true);
    expect(RUBY_INSTANCE_RETURNING.has("create!")).toBe(true);
    expect(RUBY_INSTANCE_RETURNING.has("find")).toBe(true);
    expect(RUBY_INSTANCE_RETURNING.has("where")).toBe(false);
  });
  it("relationReturning owns the AR query verbs", () => {
    expect(RUBY_RELATION_RETURNING.has("where")).toBe(true);
    expect(RUBY_RELATION_RETURNING.has("new")).toBe(false);
  });
});
