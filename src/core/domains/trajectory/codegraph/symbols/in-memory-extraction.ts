/**
 * One file's `FileExtraction` from its TEXT rather than from disk — for callers
 * that hold content the index has not seen (a naming review over a diff, bd
 * tea-rags-mcp-fdef2) and for the offline harnesses (`scripts/`), whose walks
 * are synchronous.
 *
 * It resolves the file the way `CodegraphFileExtractor#parse` does — the
 * {@link CODEGRAPH_LANGUAGES} row, the language's walker, the kernel's grammar
 * (loaded synchronously here) — and then hands off to the same
 * `extractCodeFileFromText` core, so the inert-file gate, materialization,
 * `collectSymbols` and the walk cannot drift between the two (bd
 * tea-rags-mcp-raohg). It lives beside the extractor because the extension
 * table and grammar loading are this trajectory's, and `domains/language` may
 * not import them; the walker, symbol collector and composer arrive injected
 * for the same reason the extractor's do — `trajectory` may not import
 * `domains/language`.
 */

import Parser from "tree-sitter";

import type { FileExtraction } from "../../../../contracts/types/codegraph.js";
import { extractCodeFileFromText } from "../../../../infra/code-file-extraction.js";
import {
  CODEGRAPH_LANGUAGES,
  extensionOf,
  loadCodegraphGrammarSync,
  type CodegraphFileExtractorDeps,
} from "./file-extractor.js";

/** The injected language collaborators — the extractor's, minus its run-scoped state. */
export type InMemoryExtractionDeps = Pick<
  CodegraphFileExtractorDeps,
  "languageFactory" | "collectSymbols" | "composer"
>;

/** The run-level context pass 1 hands every walk; absent means the walker's full catalogue. */
export interface InMemoryExtractionContext {
  gemfileContent?: string;
  declaredDependencies?: ReadonlySet<string>;
}

/**
 * Parse and walk `text` as the file at `relPath`. `null` when no codegraph
 * language walks the path's extension, or its language has no walker. Throws
 * what parsing throws — `GrammarPackageNotInstalledError` for a language whose
 * grammar is missing — so the caller decides whether one file's failure is
 * fatal.
 */
export function extractFileInMemory(
  deps: InMemoryExtractionDeps,
  relPath: string,
  text: string,
  context: InMemoryExtractionContext = {},
): FileExtraction | null {
  const extension = extensionOf(relPath);
  const config = CODEGRAPH_LANGUAGES[extension];
  if (!config) return null;
  const { walker } = deps.languageFactory.create(config.language);
  if (!walker) return null;

  const parser = new Parser();
  parser.setLanguage(loadCodegraphGrammarSync(deps.languageFactory, extension));
  return extractCodeFileFromText(
    { parser, walker, collectSymbols: deps.collectSymbols, composer: deps.composer },
    {
      relPath,
      text,
      language: config.language,
      scopeSeparator: config.scopeSeparator,
      disambiguateOverloads: config.disambiguateOverloads ?? false,
      gemfileContent: context.gemfileContent,
      declaredDependencies: context.declaredDependencies,
    },
  );
}
