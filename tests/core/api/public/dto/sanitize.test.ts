import { describe, expect, it } from "vitest";

import { stripInternalFields } from "../../../../../src/core/api/public/dto/sanitize.js";

describe("stripInternalFields", () => {
  it("removes headingPath from payload", () => {
    const payload = {
      relativePath: "test.md",
      headingPath: [{ depth: 1, text: "Title" }],
      content: "some content",
    };
    const result = stripInternalFields(payload);
    expect(result).not.toHaveProperty("headingPath");
    expect(result.relativePath).toBe("test.md");
    expect(result.content).toBe("some content");
  });

  it("returns payload unchanged when no internal fields", () => {
    const payload = { relativePath: "test.ts", content: "code" };
    const result = stripInternalFields(payload);
    expect(result).toEqual(payload);
  });

  it("does not mutate original payload", () => {
    const payload = {
      relativePath: "test.md",
      headingPath: [{ depth: 1, text: "Title" }],
    };
    stripInternalFields(payload);
    expect(payload).toHaveProperty("headingPath");
  });

  it("does NOT strip navigation field", () => {
    const payload = {
      relativePath: "src/app.ts",
      headingPath: [{ depth: 1, text: "Title" }],
      navigation: { prevSymbolId: "doc:abc123", nextSymbolId: "App.run" },
      content: "code here",
    };

    const result = stripInternalFields(payload);

    expect(result.navigation).toEqual({
      prevSymbolId: "doc:abc123",
      nextSymbolId: "App.run",
    });
    expect(result.headingPath).toBeUndefined(); // still stripped
  });
});
