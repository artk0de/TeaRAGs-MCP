import { describe, expect, it } from "vitest";

import { RAILS_RUNTIME_BUILTINS } from "../../../../../../src/core/domains/language/ruby/dsl/rails-runtime.js";

describe("RAILS_RUNTIME_BUILTINS", () => {
  it("contains representative controller / ActiveSupport instance helpers", () => {
    for (const m of ["params", "render", "redirect_to", "head", "respond_to", "t", "flash"]) {
      expect(RAILS_RUNTIME_BUILTINS.has(m), m).toBe(true);
    }
  });

  it("does NOT contain DSL macro keywords (catalogue-derived) or project names", () => {
    for (const m of ["has_many", "validates", "create_event", "log"]) {
      expect(RAILS_RUNTIME_BUILTINS.has(m), m).toBe(false);
    }
  });
});
