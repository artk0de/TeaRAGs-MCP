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
  it("instanceReturning covers the full AR single-record finder surface (mn00t audit)", () => {
    for (const verb of [
      "find_or_create_by",
      "find_or_create_by!",
      "find_or_initialize_by",
      "create_or_find_by",
      "create_or_find_by!",
      "find_sole_by",
      "sole",
      "take!",
      "first!",
      "last!",
      "new",
    ]) {
      expect(RUBY_INSTANCE_RETURNING.has(verb), verb).toBe(true);
    }
  });
  it("relationReturning covers the full AR::QueryMethods chaining surface (mn00t audit)", () => {
    for (const verb of [
      "left_joins",
      "left_outer_joins",
      "or",
      "and",
      "merge",
      "rewhere",
      "reselect",
      "regroup",
      "unscoped",
      "only",
      "excluding",
      "without",
      "in_order_of",
      "strict_loading",
      "from",
      "extending",
      "annotate",
      "optimizer_hints",
    ]) {
      expect(RUBY_RELATION_RETURNING.has(verb), verb).toBe(true);
    }
  });
});
