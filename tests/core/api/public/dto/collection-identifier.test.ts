import { describe, expect, it } from "vitest";

import type { CollectionIdentifier } from "../../../../../src/core/api/public/dto/common.js";
import type { IndexCodebaseInput } from "../../../../../src/core/api/public/dto/ingest.js";

describe("CollectionIdentifier mixin", () => {
  it("permits all three optional fields", () => {
    const a: CollectionIdentifier = { collection: "c" };
    const b: CollectionIdentifier = { project: "p" };
    const c: CollectionIdentifier = { path: "/x" };
    const d: CollectionIdentifier = {};
    expect([a, b, c, d].length).toBe(4);
  });

  it("IndexCodebaseInput inherits project field", () => {
    const input: IndexCodebaseInput = { path: "/x", project: "p" };
    expect(input.project).toBe("p");
  });
});
