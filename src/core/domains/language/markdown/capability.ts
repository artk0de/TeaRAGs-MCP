import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "markdown",
  ast: { tier: "full", engine: "MarkdownChunker (ToC + smart chunking)" },
  tests: { tier: "na", detection: "doc-only", tech: "—" },
  codegraph: { tier: "none", tech: "no call graph" },
  notes:
    "Doc-only: heading/section chunking with a navigable ToC (heading + body); a section is a coherent, complete unit for docs. No code symbols, so no call graph.",
};
