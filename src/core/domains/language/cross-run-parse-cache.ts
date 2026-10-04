import type { LanguageCrossRunParseCache, LanguageCrossRunParseUsage } from "../../contracts/types/language.js";
import { TSSourceFileStore } from "./typescript/resolver/index.js";

/**
 * The language domain's {@link LanguageCrossRunParseCache}: the parse stores a
 * long-lived process hands every `LanguageFactory` it builds, one run after
 * another. Its holder (the warm working-tree graph child) keeps one per tree
 * and never looks inside; `LanguageFactory` threads each store to the provider
 * that parses through it.
 *
 * TypeScript is the vertical whose parses dominate a run — its type checker
 * builds `ts.Program`s over the default lib and the dependency `.d.ts` surface —
 * and so far the only one with a store. A language gains one by adding a field
 * here and threading it in `LanguageFactory#build`.
 */
export class CrossRunParseCache implements LanguageCrossRunParseCache {
  readonly typescript: TSSourceFileStore;

  /** @param options.typescriptTextBytes Text budget of the TypeScript store (default: its own). */
  constructor(options: { typescriptTextBytes?: number } = {}) {
    this.typescript = new TSSourceFileStore(options.typescriptTextBytes);
  }

  usage(): LanguageCrossRunParseUsage {
    return this.typescript.usage();
  }
}
