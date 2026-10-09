import { describe, expect, it } from "vitest";

import { classifyDirectoryRelation } from "../../../../../../src/core/domains/trajectory/codegraph/component-geometry/index.js";

describe("classifyDirectoryRelation", () => {
  it.each([
    ["a/x.ts", "a/y.ts", "same"],
    ["x.ts", "y.ts", "same"],
    ["a/x.ts", "a/b/y.ts", "descendant"],
    ["x.ts", "a/y.ts", "descendant"],
    ["a/b/x.ts", "a/y.ts", "ancestor"],
    ["a/x.ts", "y.ts", "ancestor"],
    ["a/x.ts", "c/y.ts", "disjoint"],
    ["a/x.ts", "ab/y.ts", "disjoint"],
    ["a/b/x.ts", "a/c/y.ts", "disjoint"],
  ] as const)("%s -> %s is %s", (source, target, relation) => {
    expect(classifyDirectoryRelation(source, target)).toBe(relation);
  });
});
