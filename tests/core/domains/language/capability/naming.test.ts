import { describe, expect, it } from "vitest";

import type { IdentifierCasing, IdentifierRole } from "../../../../../src/core/contracts/types/language.js";
import { LanguageFactory } from "../../../../../src/core/domains/language/factory.js";

/**
 * Each language's identifier casing per role, as its community style guide
 * states it (bd tea-rags-mcp-4p3sb.18). The FIRST casing of a role is the
 * canonical one the naming lexicon renders a name in; the rest are accepted.
 */
const EXPECTED_NAMING: Record<string, Record<IdentifierRole, readonly IdentifierCasing[]>> = {
  ruby: {
    type: ["pascal"],
    module: ["pascal"],
    method: ["snake"],
    param: ["snake"],
    local: ["snake"],
    field: ["snake"],
    constant: ["screamingSnake", "pascal"],
  },
  python: {
    type: ["pascal"],
    module: ["snake"],
    method: ["snake"],
    param: ["snake"],
    local: ["snake"],
    field: ["snake"],
    constant: ["screamingSnake"],
  },
  typescript: {
    type: ["pascal"],
    module: ["camel", "pascal"],
    method: ["camel"],
    param: ["camel"],
    local: ["camel"],
    field: ["camel"],
    constant: ["camel", "screamingSnake"],
  },
  javascript: {
    type: ["pascal"],
    module: ["camel", "pascal"],
    method: ["camel"],
    param: ["camel"],
    local: ["camel"],
    field: ["camel"],
    constant: ["camel", "screamingSnake"],
  },
  go: {
    type: ["pascal", "camel"],
    module: ["snake"],
    method: ["camel", "pascal"],
    param: ["camel"],
    local: ["camel"],
    field: ["camel", "pascal"],
    constant: ["camel", "pascal"],
  },
  java: {
    type: ["pascal"],
    module: ["snake"],
    method: ["camel"],
    param: ["camel"],
    local: ["camel"],
    field: ["camel"],
    constant: ["screamingSnake"],
  },
  rust: {
    type: ["pascal"],
    module: ["snake"],
    method: ["snake"],
    param: ["snake"],
    local: ["snake"],
    field: ["snake"],
    constant: ["screamingSnake"],
  },
  swift: {
    type: ["pascal"],
    module: ["pascal"],
    method: ["camel"],
    param: ["camel"],
    local: ["camel"],
    field: ["camel"],
    constant: ["camel"],
  },
  bash: {
    type: ["snake"],
    module: ["snake"],
    method: ["snake"],
    param: ["snake"],
    local: ["snake"],
    field: ["snake"],
    constant: ["screamingSnake"],
  },
};

describe("LanguageCapability.naming", () => {
  const capabilities = new LanguageFactory().capabilities();

  it.each(Object.entries(EXPECTED_NAMING))("%s declares its community casing per role", (language, expected) => {
    expect(capabilities.get(language)?.naming).toEqual(expected);
  });

  it("is absent for a language without identifiers", () => {
    expect(capabilities.get("markdown")?.naming).toBeUndefined();
  });
});
