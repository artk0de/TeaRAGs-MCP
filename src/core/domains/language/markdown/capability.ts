import type { LanguageCapability } from "../../../contracts/types/language.js";

export const capability: LanguageCapability = {
  language: "markdown",
  ast: { tier: "partial", engine: "MarkdownChunker (remark)" },
  tests: { tier: "na", detection: "doc-only", tech: "—" },
  codegraph: { tier: "none", tech: "no call graph" },
  notes: "Doc-only: section-level chunking (heading + body); fine for docs, no code symbols.",
};
