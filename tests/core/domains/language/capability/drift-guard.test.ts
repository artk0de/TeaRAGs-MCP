import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { renderRuleFile, spliceReadme } from "../../../../../scripts/gen-language-compatibility.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";

const RULE_PATH = ".claude-plugin/tea-rags/rules/language-compatibility.md";
const README_PATH = "README.md";

/**
 * Locks the committed artifacts to the capability descriptors (Prettier-formatted,
 * exactly as `npm run gen:lang-compat` writes them). If a descriptor changes
 * without regenerating, these fail — run `npm run gen:lang-compat`.
 */
describe("language-compatibility drift guard", () => {
  const caps = new LanguageFactory().capabilities();

  it("rule file is up-to-date (run `npm run gen:lang-compat` if this fails)", async () => {
    expect(readFileSync(RULE_PATH, "utf8")).toBe(await renderRuleFile(caps, RULE_PATH));
  });

  it("README spoiler block is up-to-date (run `npm run gen:lang-compat` if this fails)", async () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toBe(await spliceReadme(readme, caps, README_PATH));
  });
});
