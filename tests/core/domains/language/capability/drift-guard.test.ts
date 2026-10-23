import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { spliceReadme } from "../../../../../scripts/gen-language-compatibility.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";

const RULE_PATH = ".claude-plugin/tea-rags/rules/language-compatibility.md";
const README_PATH = "README.md";

/**
 * Locks the committed README block to the capability descriptors (Prettier-formatted,
 * exactly as `npm run gen:lang-compat` writes them). If a descriptor changes
 * without regenerating, these fail — run `npm run gen:lang-compat`.
 */
describe("language-compatibility drift guard", () => {
  const caps = new LanguageFactory().capabilities();

  it("ships no rule-file copy — agents read tea-rags://guide/language-capability, rendered live", () => {
    expect(existsSync(RULE_PATH)).toBe(false);
  });

  it("README spoiler block is up-to-date (run `npm run gen:lang-compat` if this fails)", async () => {
    const readme = readFileSync(README_PATH, "utf8");
    expect(readme).toBe(await spliceReadme(readme, caps, README_PATH));
  });
});
