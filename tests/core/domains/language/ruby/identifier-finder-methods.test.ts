import { describe, expect, it } from "vitest";

import { RUBY_IDENTIFIER_FINDER_METHODS } from "../../../../../src/core/domains/language/ruby/identifier-finder-methods.js";
import { RubyLanguage } from "../../../../../src/core/domains/language/ruby/index.js";

/**
 * bd tea-rags-mcp-4p3sb.9 — the ActiveRecord finders that return an instance of
 * their receiver constant are Ruby knowledge, so the vocabulary lives here and
 * the codegraph row builder reads it through `LanguageProvider`.
 */
describe("RUBY_IDENTIFIER_FINDER_METHODS", () => {
  it("lists the finders whose result is an instance of the receiver constant", () => {
    expect(RUBY_IDENTIFIER_FINDER_METHODS).toEqual([
      "find",
      "find!",
      "find_by",
      "find_by!",
      "first",
      "last",
      "take",
      "create",
      "create!",
      "find_or_create_by",
      "find_or_initialize_by",
    ]);
  });

  it("is what RubyLanguage publishes as its identifier finder vocabulary", () => {
    expect(new RubyLanguage().identifierFinderMethods).toBe(RUBY_IDENTIFIER_FINDER_METHODS);
  });
});
