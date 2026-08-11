import { describe, expect, it } from "vitest";

import { normalizeLanguageSelector, selectLanguages } from "../../../src/core/contracts/language-selector.js";

describe("normalizeLanguageSelector", () => {
  it("lowercases so the flag accepts the name as it is written in prose", () => {
    expect(normalizeLanguageSelector("TypeScript")).toBe("typescript");
  });

  it("trims surrounding space left by a comma-separated list", () => {
    expect(normalizeLanguageSelector("  ruby ")).toBe("ruby");
  });
});

describe("selectLanguages", () => {
  const indexed = ["typescript", "markdown", "ruby"];

  it("matches an indexed language", () => {
    expect(selectLanguages(indexed, ["ruby"])).toEqual({ matched: ["ruby"], unknown: [] });
  });

  it("keeps the order of the indexed set rather than the order typed", () => {
    // Stable output makes the resulting Qdrant filter and the log line
    // reproducible regardless of how the operator ordered the flag.
    expect(selectLanguages(indexed, ["ruby", "typescript"]).matched).toEqual(["typescript", "ruby"]);
  });

  it("de-duplicates a language named twice", () => {
    expect(selectLanguages(indexed, ["ruby", "ruby"]).matched).toEqual(["ruby"]);
  });

  it("matches case-insensitively", () => {
    expect(selectLanguages(indexed, ["TypeScript"]).matched).toEqual(["typescript"]);
  });

  it("reports a language absent from the index instead of dropping it", () => {
    // Silently selecting zero points is indistinguishable from a successful
    // run once it finishes, so an unknown selector has to reach the caller.
    expect(selectLanguages(indexed, ["ruby", "cobol"])).toEqual({ matched: ["ruby"], unknown: ["cobol"] });
  });

  it("does NOT prefix-match, unlike provider selectors", () => {
    // `codegraph` selecting `codegraph.symbols` is right for a dotted provider
    // namespace. Languages are flat: `type` must not select `typescript`.
    expect(selectLanguages(indexed, ["type"])).toEqual({ matched: [], unknown: ["type"] });
  });

  it("treats an empty request as selecting nothing, not everything", () => {
    expect(selectLanguages(indexed, [])).toEqual({ matched: [], unknown: [] });
  });
});
