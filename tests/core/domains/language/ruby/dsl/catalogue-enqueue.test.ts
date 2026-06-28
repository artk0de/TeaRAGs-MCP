import { describe, expect, it } from "vitest";

import { enqueueEntrypoint } from "../../../../../../src/core/domains/language/ruby/dsl/index.js";

describe("composed enqueue dispatch", () => {
  it("routes Sidekiq verbs (gem-owned) to #perform", () => {
    for (const v of ["perform_async", "perform_in", "perform_at", "perform_bulk"]) {
      expect(enqueueEntrypoint(v)).toBe("perform");
    }
  });
  it("routes ActiveJob verbs (rails-owned) to #perform", () => {
    expect(enqueueEntrypoint("perform_later")).toBe("perform");
    expect(enqueueEntrypoint("perform_now")).toBe("perform");
  });
  it("returns undefined for a non-enqueue member", () => {
    expect(enqueueEntrypoint("save")).toBeUndefined();
  });
});
