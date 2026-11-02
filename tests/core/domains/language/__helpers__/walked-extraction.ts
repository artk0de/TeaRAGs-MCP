import Parser from "tree-sitter";

import { materializeTree } from "../../../../../src/core/adapters/tree-sitter/materialize.js";
import type { FileExtraction } from "../../../../../src/core/contracts/types/codegraph.js";
import type { LanguageProvider } from "../../../../../src/core/contracts/types/language.js";
import { collectSymbols } from "../../../../../src/core/domains/language/kernel/collect-symbols.js";
import { DefaultSymbolIdComposer } from "../../../../../src/core/domains/language/kernel/symbol-id.js";

/** Which tree the walk reads: production materializes, older fixtures hand the native tree. */
export type WalkedTreeForm = "native" | "materialized";

/**
 * The `FileExtraction` the COMPOSED walker emits for `src`, through the seam
 * production runs (materialize, `collectSymbols`, then `walker.walk`), so what
 * is asserted is what the codegraph persists.
 */
export function walkedExtractionOf(
  language: LanguageProvider,
  grammar: unknown,
  request: { src: string; relPath: string; languageId: string; form: WalkedTreeForm },
): FileExtraction {
  const { walker } = language;
  if (!walker) throw new TypeError(`walkedExtractionOf: the ${request.languageId} provider carries no walker`);
  const parser = new Parser();
  parser.setLanguage(grammar as Parser.Language);
  const native = parser.parse(request.src);
  const tree = request.form === "materialized" ? { rootNode: materializeTree(native.rootNode, request.src) } : native;
  const chunks = collectSymbols(
    tree,
    (node) => walker.nameOf(node),
    language.kernel.scopeSeparator ?? ".",
    language.kernel.disambiguateOverloads ?? false,
    new DefaultSymbolIdComposer(),
  );
  return walker.walk({ tree, code: request.src, relPath: request.relPath, language: request.languageId, chunks });
}
