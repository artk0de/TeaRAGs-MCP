import { describe, expect, it } from "vitest";

import {
  checkSchemaDrift,
  formatSchemaDriftWarning,
} from "../../../../../src/core/domains/maintenance/drift/schema-drift.js";

describe("checkSchemaDrift", () => {
  it("returns null when no cached keys", () => {
    expect(checkSchemaDrift(undefined, ["a"])).toBeNull();
  });

  it("returns null when no drift", () => {
    expect(checkSchemaDrift(["a", "b"], ["a", "b"])).toBeNull();
  });

  it("detects added fields", () => {
    const drift = checkSchemaDrift(["a"], ["a", "b"]);
    expect(drift).toEqual({ added: ["b"], removed: [] });
  });

  it("detects removed fields", () => {
    const drift = checkSchemaDrift(["a", "b"], ["a"]);
    expect(drift).toEqual({ added: [], removed: ["b"] });
  });

  it("detects both added and removed", () => {
    const drift = checkSchemaDrift(["a", "b"], ["b", "c"]);
    expect(drift).toEqual({ added: ["c"], removed: ["a"] });
  });
});

describe("formatSchemaDriftWarning", () => {
  it("formats added fields", () => {
    const msg = formatSchemaDriftWarning({ added: ["x"], removed: [] });
    expect(msg).toContain("New fields: x");
    expect(msg).not.toContain("Removed fields");
  });

  it("formats removed fields", () => {
    const msg = formatSchemaDriftWarning({ added: [], removed: ["y"] });
    expect(msg).toContain("Removed fields: y");
    expect(msg).not.toContain("New fields");
  });

  it("formats both added and removed", () => {
    const msg = formatSchemaDriftWarning({ added: ["x"], removed: ["y"] });
    expect(msg).toContain("New fields: x");
    expect(msg).toContain("Removed fields: y");
    expect(msg).toContain("forceReindex=true");
  });
});
