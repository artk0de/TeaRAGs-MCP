/**
 * The one sequence that turns a code file's TEXT into its `FileExtraction`
 * (bd tea-rags-mcp-raohg): parse with the language grammar, ask the native tree
 * whether the file is inert, materialize it, collect symbols, walk.
 *
 * Two entry points run it: `CodegraphFileExtractor#parse` (pass 1, a file read
 * from disk, grammar loaded asynchronously) and `extractFileInMemory` (text the
 * index has not seen, grammar loaded synchronously for the offline harnesses).
 * They differ in how they find the language and load its grammar, never in what
 * happens after — so that part lives here once, and the two cannot drift.
 *
 * It lives in `infra/` beside {@link materializeTree} and
 * {@link fileIsInertForExtraction}, which it composes. `infra` imports nothing
 * above it at runtime, so every collaborator that belongs to a language — the
 * configured parser, the walker, the symbol collector, the composer — arrives
 * injected, and the per-extension table stays the caller's.
 */
import type Parser from "tree-sitter";

import type { FileExtraction } from "../contracts/types/codegraph.js";
import type { CollectSymbolsFn, LanguageWalker, SymbolIdComposer } from "../contracts/types/language.js";
import { fileIsInertForExtraction } from "./extraction-fast-path.js";
import { materializeTree } from "./materialize.js";

/** The language collaborators one extraction runs with, all resolved by the caller. */
export interface CodeFileExtractionCollaborators {
  /** A parser already configured with the file's grammar. */
  parser: Pick<Parser, "parse">;
  walker: LanguageWalker;
  collectSymbols: CollectSymbolsFn;
  composer: SymbolIdComposer;
}

/** One file to extract: its text, the language it is walked as, and the run's gating context. */
export interface CodeFileExtractionRequest {
  relPath: string;
  text: string;
  language: string;
  /** Joiner for fully-qualified symbol ids (`.` / `::`), per the caller's language row. */
  scopeSeparator: string;
  /** Whether duplicate symbol ids in one file get `~N` suffixes instead of being deduped. */
  disambiguateOverloads: boolean;
  /** The run's Gemfile; undefined walks the FULL DSL catalogue. */
  gemfileContent?: string;
  /** The run's declared dependencies; undefined means no manifest, so every vocabulary stays active. */
  declaredDependencies?: ReadonlySet<string>;
}

/**
 * Parse and walk `request.text`. A file bearing none of the walker's
 * `extractionBearingNodeTypes` yields the empty extraction without being
 * materialized. Throws whatever the parser, collector or walker throws — the
 * caller decides whether one file's failure is fatal.
 */
export function extractCodeFileFromText(
  collaborators: CodeFileExtractionCollaborators,
  request: CodeFileExtractionRequest,
): FileExtraction {
  const { parser, walker, collectSymbols, composer } = collaborators;
  const { relPath, text, language, gemfileContent } = request;
  const nativeTree = parser.parse(text);
  // Ask the NATIVE tree before materializing it — the most expensive thing
  // pass 1 does on generated data tables (bd tea-rags-mcp-1v12o.2.4).
  if (fileIsInertForExtraction(nativeTree.rootNode, walker.extractionBearingNodeTypes)) {
    return { relPath, language, imports: [], chunks: [], fileScope: [] };
  }
  // collectSymbols and the walk both see the deterministic plain-JS tree, as at
  // the chunker boundary (rdv7d).
  const tree = { rootNode: materializeTree(nativeTree.rootNode, text) };
  const chunks = collectSymbols(
    tree,
    // Gem-gated declares (bd tea-rags-mcp-o5kwh): the Ruby nameOf gates
    // class-body macro DECLARES to the run's gems; other languages ignore it.
    (node) => walker.nameOf(node, gemfileContent),
    request.scopeSeparator,
    request.disambiguateOverloads,
    composer,
  );
  return walker.walk({
    tree,
    code: text,
    relPath,
    language,
    chunks,
    gemfileContent,
    declaredDependencies: request.declaredDependencies,
  });
}
