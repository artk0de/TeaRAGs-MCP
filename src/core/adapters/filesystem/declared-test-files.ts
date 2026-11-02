/**
 * The run-start read of every language's declared test files (bd
 * tea-rags-mcp-52wk3.10). The languages decide which files declare what
 * (`LanguageProvider.declaredTestFiles`); this adapter hands them the project's
 * files and the one reader they may use, so no language walks the disk itself —
 * the same split `dependency-manifests.ts` keeps for manifests.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  DeclaredTestFileFinder,
  DeclaredTestFileSource,
  LanguageFactoryDescriptor,
} from "../../contracts/types/language.js";

/**
 * Every registered language's declared-test-file source, each distinct source
 * once. Same aggregation shape as `collectDependencyManifestSources`: the
 * engine knows THAT a language can declare test files, never how. Omitting the
 * factory (tests, fixtures) yields none.
 */
export function collectDeclaredTestFileSources(
  languageFactory?: LanguageFactoryDescriptor,
): readonly DeclaredTestFileSource[] {
  if (!languageFactory) return [];
  const sources = new Set<DeclaredTestFileSource>();
  for (const lang of languageFactory.supported()) {
    const source = languageFactory.create(lang).declaredTestFiles;
    if (source !== undefined) sources.add(source);
  }
  return [...sources];
}

/**
 * The union of what `sources` declare over `relativePaths`, read under
 * `projectRoot`. Total: an unreadable file reads as `undefined`, and a source
 * that throws declares nothing rather than failing the run.
 */
export async function readDeclaredTestFiles(
  projectRoot: string,
  relativePaths: readonly string[],
  sources: readonly DeclaredTestFileSource[],
): Promise<ReadonlySet<string>> {
  const declared = new Set<string>();
  if (sources.length === 0) return declared;
  const query = {
    relativePaths,
    readFile: async (relativePath: string): Promise<string | undefined> =>
      readFile(join(projectRoot, relativePath), "utf-8").catch(() => undefined),
  };
  for (const source of sources) {
    const found = await source.findDeclaredTestFiles(query).catch(() => new Set<string>());
    for (const relativePath of found) declared.add(relativePath);
  }
  return declared;
}

/** A finder over the factory's languages — what the composition root hands the ingest pipeline. */
export function createDeclaredTestFileFinder(languageFactory?: LanguageFactoryDescriptor): DeclaredTestFileFinder {
  const sources = collectDeclaredTestFileSources(languageFactory);
  return async (projectRoot, relativePaths) => readDeclaredTestFiles(projectRoot, relativePaths, sources);
}
