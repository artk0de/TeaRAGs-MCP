/**
 * The declarations of one changed file, read from its working-tree TEXT for the
 * naming review over a diff (bd tea-rags-mcp-fdef2, spec §6.2) — nothing is
 * indexed. Value names come from the same identifier-row builder the codegraph
 * sink persists `cg_identifiers` with; type and constant names from the
 * walker's `typeDeclarations` channel (spec §1b).
 *
 * Every walk gets the run-level context the index-time extraction hands its
 * walks (`CodegraphRunState#loadGemfile` / `#loadDeclaredDependencies`): the
 * working tree's `Gemfile` and the dependencies its manifests declare, read once
 * per review — so a Ruby DSL vocabulary is gated the way the indexed rows were.
 *
 * Lives in `api/internal` because it bridges the language domain (walker,
 * symbol collector, composer) and the codegraph trajectory (in-memory
 * extraction, row builder); `NamingLexiconOps` receives it as a dependency and
 * imports neither.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { IdentifierRow, TypeDeclarationFact } from "../../../contracts/types/codegraph.js";
import type { LanguageFactoryDescriptor } from "../../../contracts/types/language.js";
import { collectSymbols, DefaultSymbolIdComposer } from "../../../domains/language/index.js";
import {
  buildIdentifierRows,
  collectIdentifierFinderVocabulary,
  extractFileInMemory,
  isConstructorSymbol,
  type IdentifierFinderVocabulary,
  type InMemoryExtractionContext,
} from "../../../domains/trajectory/codegraph/index.js";
import { collectDependencyManifestSources, readDeclaredDependencies } from "../../../infra/dependency-manifests.js";

/** One file's declarations, as the review judges them. */
export interface NamingReviewFileDeclarations {
  /** The file's codegraph language — the casing and descriptor its drafts are judged in. */
  language: string;
  /** Value declarations, one per `cg_identifiers` row the file would persist. */
  values: readonly IdentifierRow[];
  /** Type and constant declarations, re-openings included (the review drops them). */
  types: readonly TypeDeclarationFact[];
  /** The line range of every chunk the walk emitted — where a declaration's enclosing code is read from. */
  chunks: readonly { startLine: number; endLine: number }[];
  /**
   * Every method and function the file declares, constructors excluded — a
   * name the review judges only through its `return` row, so one without that
   * row (no known return type) is reported as not judged (bd tea-rags-mcp-y33ee).
   */
  callables: readonly NamingReviewCallable[];
}

/**
 * One method / function declaration: its symbols, member name and first line.
 * One declaration can carry several symbols — a Ruby `module_function` method
 * is both `M#x` and `M.x`.
 */
export interface NamingReviewCallable {
  symbolIds: readonly string[];
  name: string;
  line: number;
  kind: "method" | "function";
}

/**
 * One review's extractor. `null` when no codegraph language walks the path;
 * throws what parsing throws (a missing grammar), so the caller decides what
 * one file's failure costs.
 */
export type NamingReviewFileExtractor = (relPath: string, text: string) => NamingReviewFileDeclarations | null;

/** Builds one review's extractor over a working tree. */
export interface NamingReviewExtractor {
  forWorkingTree: (repoRoot: string) => NamingReviewFileExtractor;
}

/** The extractor over the configured languages; the finder vocabulary and manifest sources are collected once. */
export function createNamingReviewExtractor(languageFactory: LanguageFactoryDescriptor): NamingReviewExtractor {
  const composer = new DefaultSymbolIdComposer();
  let finders: IdentifierFinderVocabulary | undefined;
  let manifestSources: ReturnType<typeof collectDependencyManifestSources> | undefined;
  return {
    forWorkingTree: (repoRoot) => {
      let context: InMemoryExtractionContext | undefined;
      return (relPath, text) => {
        context ??= workingTreeContext(
          repoRoot,
          (manifestSources ??= collectDependencyManifestSources(languageFactory)),
        );
        const extraction = extractFileInMemory({ languageFactory, collectSymbols, composer }, relPath, text, context);
        if (extraction === null) return null;
        finders ??= collectIdentifierFinderVocabulary(languageFactory);
        return {
          language: extraction.language,
          values: buildIdentifierRows(extraction, finders),
          types: extraction.typeDeclarations ?? [],
          chunks: extraction.chunks.flatMap((chunk) =>
            chunk.startLine !== undefined && chunk.endLine !== undefined
              ? [{ startLine: chunk.startLine, endLine: chunk.endLine }]
              : [],
          ),
          callables: callablesOf(extraction.language, extraction.chunks),
        };
      };
    },
  };
}

/**
 * Methods and functions, one per declaration: a split method's parts collapse
 * to its first line, the symbols one declaration carries to one entry;
 * constructors dropped.
 */
function callablesOf(
  language: string,
  chunks: readonly { symbolId: string; startLine?: number; symbolKind?: string }[],
): NamingReviewCallable[] {
  const firstLine = new Map<string, { line: number; kind: "method" | "function" }>();
  for (const { symbolId, startLine, symbolKind } of chunks) {
    if ((symbolKind !== "method" && symbolKind !== "function") || startLine === undefined) continue;
    if (isConstructorSymbol(language, symbolId)) continue;
    const seen = firstLine.get(symbolId);
    if (seen === undefined || startLine < seen.line) firstLine.set(symbolId, { line: startLine, kind: symbolKind });
  }
  const byDeclaration = new Map<string, NamingReviewCallable & { symbolIds: string[] }>();
  for (const [symbolId, { line, kind }] of firstLine) {
    const name = memberNameOf(symbolId);
    const key = `${line}\u0000${name}`;
    const declaration = byDeclaration.get(key);
    if (declaration) declaration.symbolIds.push(symbolId);
    else byDeclaration.set(key, { symbolIds: [symbolId], name, line, kind });
  }
  return [...byDeclaration.values()];
}

/** A symbolId's member: what follows its last `#` / `.` separator, or the whole id for a top-level function. */
function memberNameOf(symbolId: string): string {
  const cut = Math.max(symbolId.lastIndexOf("#"), symbolId.lastIndexOf("."));
  return cut < 0 ? symbolId : symbolId.slice(cut + 1);
}

/** The Gemfile (absent → the full catalogue) and the declared dependencies (no manifest → every vocabulary). */
function workingTreeContext(
  repoRoot: string,
  sources: ReturnType<typeof collectDependencyManifestSources>,
): InMemoryExtractionContext {
  let gemfileContent: string | undefined;
  try {
    gemfileContent = readFileSync(join(repoRoot, "Gemfile"), "utf8");
  } catch {
    gemfileContent = undefined;
  }
  const declaredDependencies = readDeclaredDependencies(repoRoot, sources);
  return {
    ...(gemfileContent !== undefined ? { gemfileContent } : {}),
    ...(declaredDependencies !== undefined ? { declaredDependencies } : {}),
  };
}
