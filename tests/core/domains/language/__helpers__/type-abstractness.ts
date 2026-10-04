import Parser from "tree-sitter";

import type { TypeAbstractnessCensus } from "../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageProvider } from "../../../../../src/core/contracts/types/language.js";
import { collectSymbols } from "../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../src/core/domains/language/kernel/symbol-id.js";
import { materializeTree } from "../../../../../src/core/infra/materialize.js";

/**
 * The type-abstractness census the COMPOSED walker emits for `src`, through the
 * seam production runs (file-extractor: materialize, `collectSymbols`, then
 * `walker.walk`), so what is asserted is what the codegraph persists.
 */
export function typeAbstractnessOf(
  language: LanguageProvider,
  grammar: unknown,
  src: string,
  relPath: string,
  languageId: string,
): TypeAbstractnessCensus | undefined {
  const { walker } = language;
  if (!walker) throw new TypeError(`typeAbstractnessOf: the ${languageId} provider carries no walker`);
  const parser = new Parser();
  parser.setLanguage(grammar as Parser.Language);
  const rootNode = materializeTree(parser.parse(src).rootNode, src);
  const tree = { rootNode };
  const chunks = collectSymbols(
    tree,
    (node) => walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  return walker.walk({ tree, code: src, relPath, language: languageId, chunks }).typeAbstractness;
}
