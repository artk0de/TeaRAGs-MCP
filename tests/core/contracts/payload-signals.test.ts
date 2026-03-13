import { describe, expect, it } from "vitest";

import { BASE_PAYLOAD_SIGNALS } from "../../../src/core/domains/trajectory/static/payload-signals.js";

describe("BASE_PAYLOAD_SIGNALS", () => {
  it("includes relativePath", () => {
    expect(BASE_PAYLOAD_SIGNALS.find((s) => s.key === "relativePath")).toBeDefined();
  });

  it("includes language", () => {
    expect(BASE_PAYLOAD_SIGNALS.find((s) => s.key === "language")).toBeDefined();
  });

  it("includes isDocumentation", () => {
    expect(BASE_PAYLOAD_SIGNALS.find((s) => s.key === "isDocumentation")).toBeDefined();
  });

  it("all entries have key, type, description", () => {
    for (const signal of BASE_PAYLOAD_SIGNALS) {
      expect(signal.key).toBeTruthy();
      expect(signal.type).toBeTruthy();
      expect(signal.description).toBeTruthy();
    }
  });
});
