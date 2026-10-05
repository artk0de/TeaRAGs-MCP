/**
 * The chunker worker's codegraph half (yl9tv): turn the tree a file was
 * chunked with into the `FileExtraction` the codegraph provider's cross-pass
 * spill is fed from, so a full index does not parse every code file twice.
 *
 * Kept out of `worker.ts` because that file is a thread entry point with side
 * effects at import; this is the part a test has to be able to call.
 */

import type { MaterializedTree } from "../../../../../contracts/types/ast.js";
import type { FileExtraction } from "../../../../../contracts/types/codegraph.js";
import type {
  CollectSymbolsFn,
  DeclaredDependenciesByLanguage,
  LanguageFactoryDescriptor,
  SymbolIdComposer,
} from "../../../../../contracts/types/language.js";
import type { TreeSitterChunker } from "../tree-sitter.js";

/**
 * In-thread chunker engine: the `TreeSitterChunker` plus the language
 * capabilities needed to emit a codegraph `FileExtraction` from the SAME parse
 * (yl9tv). `languageFactory.create(lang)` yields the walker + kernel config;
 * `collectSymbols` + `composer` compose the symbol ranges the walker consumes.
 */
export interface ChunkerEngine {
  chunker: TreeSitterChunker;
  languageFactory: LanguageFactoryDescriptor;
  composer: SymbolIdComposer;
  collectSymbols: CollectSymbolsFn;
  /** The project's declared dependencies per language (bd tea-rags-mcp-w205u.1,
   *  m99j1.1.8), read ONCE per worker at engine build. A walk carries its file's
   *  language's entry; no entry ⇒ every vocabulary active. */
  declaredDependencies?: DeclaredDependenciesByLanguage;
}

/** The file one extraction is for — the fields of a worker request it reads. */
export interface CrossPassExtractionRequest {
  filePath: string;
  code: string;
  language: string;
}

/**
 * Walk `chunkTree`'s file with its language walker, or `undefined` when the
 * language has none (documentation, unsupported).
 *
 * The walk runs on {@link TreeSitterChunker.walkTreeFor}, which answers the
 * chunk tree itself: the chunker and the codegraph walk both parse under the
 * grammar the file's EXTENSION selects, so `.tsx` chunks and walks under `tsx`.
 * When the chunker still parsed `.tsx` under the `typescript` grammar, walking
 * its tree lost ~72% of taxdome's `.tsx` call sites to JSX parse errors (bd
 * tea-rags-mcp-vqdi6).
 */
export async function extractFromChunkerParse(
  engine: ChunkerEngine,
  request: CrossPassExtractionRequest,
  chunkTree: MaterializedTree,
): Promise<FileExtraction | undefined> {
  const provider = engine.languageFactory.create(request.language);
  const { walker, kernel } = provider;
  if (!walker) return undefined;
  const declaredDependencies = engine.declaredDependencies?.get(request.language);
  const tree = await engine.chunker.walkTreeFor(request.code, request.filePath, request.language, chunkTree);
  const symbolRanges = engine.collectSymbols(
    tree,
    // Gem-gated declares at cross-pass extraction (bd tea-rags-mcp-o5kwh):
    // bind the language's declared set so the Ruby nameOf gates class-body
    // macro DECLARES to this project's gems. undefined -> FULL catalogue.
    (node) => walker.nameOf(node, declaredDependencies),
    kernel.scopeSeparator ?? ".",
    kernel.disambiguateOverloads ?? false,
    engine.composer,
  );
  return walker.walk({
    tree,
    code: request.code,
    relPath: request.filePath,
    language: request.language,
    chunks: symbolRanges,
    // Dependency-gated framework vocabularies and gem-gated DSL grammar
    // (bd tea-rags-mcp-w205u.1, adx5p.1b).
    declaredDependencies,
  });
}
