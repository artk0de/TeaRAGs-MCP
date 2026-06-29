import { describe, expect, it } from "vitest";

import { renderReadme } from "../../../../../src/core/domains/language/capability/readme.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";

describe("renderReadme", () => {
  const out = renderReadme(new LanguageFactory().capabilities());

  it("emits the section heading wrapped in a details spoiler", () => {
    expect(out).toContain("## Languages Compatibilities");
    expect(out).toContain("<details>");
    expect(out).toContain("<summary>");
    expect(out).toContain("</details>");
  });

  it("brackets the inline HTML with an MD033 disable/enable pair", () => {
    expect(out).toContain("markdownlint-disable MD033");
    expect(out).toContain("markdownlint-enable MD033");
  });

  it("includes the human-facing resolution tech", () => {
    expect(out).toContain("8-strategy chain + ConeDispatch");
  });

  it("spells out Ruby typing tiers for humans", () => {
    expect(out).toContain("YARD maximum");
    expect(out).toContain("RBS/Sorbet TBD");
  });

  it("lists the unsupported fallback languages", () => {
    expect(out).toContain("sql");
    expect(out).toContain("CharacterChunker");
  });
});
