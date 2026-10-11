import { describe, expect, it } from "vitest";

import {
  IDENTIFIER_DECLARATION_KINDS,
  VALUE_IDENTIFIER_DECLARATION_KINDS,
} from "../../../../src/core/contracts/types/codegraph.js";

describe("VALUE_IDENTIFIER_DECLARATION_KINDS", () => {
  it("holds every declared identifier kind except the method-result `return`", () => {
    expect([...VALUE_IDENTIFIER_DECLARATION_KINDS]).toEqual(["param", "local", "field", "constant"]);
    expect(IDENTIFIER_DECLARATION_KINDS).toContain("return");
    expect(VALUE_IDENTIFIER_DECLARATION_KINDS).not.toContain("return");
  });
});
