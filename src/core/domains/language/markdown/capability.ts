import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "markdown",
  ast: { tier: "full", engine: "MarkdownChunker (ToC + smart chunking)" },
  tests: { tier: "na", detection: "doc-only", tech: "—" },
  codegraph: { tier: "none", tech: "no call graph" },
  // No grammarPackage: MarkdownChunker parses without a tree-sitter grammar, so
  // that axis is genuinely absent rather than unknown. `walker` /
  // `codegraphSchema` are declared and simply never move — a doc-only language
  // still has to make the decision explicitly, same reason `signalFloors`
  // declares `{}` rather than omitting the entry.
  versions: { chunking: 1, walker: 1, codegraphSchema: 1 },
  notes:
    "Doc-only: heading/section chunking with a navigable ToC (heading + body); a section is a coherent, complete unit for docs. No code symbols, so no call graph.",
};
