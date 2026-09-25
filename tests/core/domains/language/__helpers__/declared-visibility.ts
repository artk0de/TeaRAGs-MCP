import Parser from "tree-sitter";

import type { LanguageProvider } from "../../../../../src/core/contracts/types/language.js";
import { collectSymbols } from "../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../src/core/domains/language/kernel/symbol-id.js";
import { materializeTree } from "../../../../../src/core/infra/materialize.js";

/**
 * `symbolId → visibility` for every chunk the COMPOSED walker emits a
 * visibility for, through the seam production runs (file-extractor: materialize,
 * `collectSymbols(tree, walker.nameOf, …)`, then `walker.walk`), so the join a
 * visibility pass makes against real chunk ranges and ids is what is asserted.
 */
export function declaredVisibilityOf(
  language: LanguageProvider,
  grammar: unknown,
  src: string,
  relPath: string,
  languageId: string,
): Record<string, string> {
  const parser = new Parser();
  parser.setLanguage(grammar as Parser.Language);
  const rootNode = materializeTree(parser.parse(src).rootNode, src);
  const tree = { rootNode };
  const chunks = collectSymbols(
    tree,
    (node) => language.walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  const extraction = language.walker.walk({ tree, code: src, relPath, language: languageId, chunks });
  const out: Record<string, string> = {};
  for (const chunk of extraction.chunks) {
    if (chunk.visibility !== undefined) out[chunk.symbolId] = chunk.visibility;
  }
  return out;
}
