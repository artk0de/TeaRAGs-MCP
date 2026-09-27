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
  /** Raw Gemfile for the run (adx5p.1b) — passed to the walker so cross-pass
   *  extraction gates DSL grammar to this project's gems. */
  gemfileContent?: string;
  /** The project's declared dependencies (bd tea-rags-mcp-w205u.1), walked ONCE
   *  per worker at engine build. Same purpose as `gemfileContent`, the other
   *  direction of the same gate; undefined ⇒ every vocabulary active. */
  declaredDependencies?: ReadonlySet<string>;
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
 * The walk runs on {@link TreeSitterChunker.walkTreeFor}, not on `chunkTree`
 * itself: the chunker parses every file of a language with ONE grammar, while
 * the codegraph walk takes the grammar the file's EXTENSION selects — the two
 * differ for `.tsx`, which chunks under the `typescript` grammar and walks
 * under `tsx` (bd tea-rags-mcp-vqdi6). Walking the chunk tree there lost ~72%
 * of taxdome's `.tsx` call sites to JSX parse errors, on the full-index path
 * only, since a recompute re-parses through the codegraph provider's own
 * extractor.
 */
export async function extractFromChunkerParse(
  engine: ChunkerEngine,
  request: CrossPassExtractionRequest,
  chunkTree: MaterializedTree,
): Promise<FileExtraction | undefined> {
  const provider = engine.languageFactory.create(request.language);
  const { walker, kernel } = provider;
  if (!walker) return undefined;
  const tree = await engine.chunker.walkTreeFor(request.code, request.filePath, request.language, chunkTree);
  const symbolRanges = engine.collectSymbols(
    tree,
    // Gem-gated declares at cross-pass extraction (bd tea-rags-mcp-o5kwh):
    // bind the run's Gemfile so the Ruby nameOf gates class-body macro
    // DECLARES to this project's gems. undefined -> FULL catalogue.
    (node) => walker.nameOf(node, engine.gemfileContent),
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
    // Gem-gated DSL grammar at cross-pass extraction (adx5p.1b).
    gemfileContent: engine.gemfileContent,
    // Dependency-gated framework vocabularies (bd tea-rags-mcp-w205u.1).
    declaredDependencies: engine.declaredDependencies,
  });
}
