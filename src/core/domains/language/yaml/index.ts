/**
 * `YamlLanguage` — the native facade of the doc-only YAML vertical (bd
 * tea-rags-mcp-q1g6s.7). Like markdown it exposes only `kernel` and
 * `chunkerHooks`: `isDocumentation` marks its chunks as documentation, and
 * `sectionSplitter` is what the chunker emits them from — key-path sections,
 * so `doc:<hash>` ids hash `relPath#production > redis`. No walker, no
 * resolver: YAML has no codegraph symbols.
 */

import type {
  LanguageChunkerHooks,
  LanguageProvider,
  LanguageSymbolResolver,
  LanguageWalker,
} from "../../../contracts/types/language.js";
import { YamlSectionSplitter } from "./chunking/section-splitter.js";
import { yamlKernel } from "./kernel.js";

export class YamlLanguage implements LanguageProvider {
  readonly kernel = yamlKernel;
  readonly chunkerHooks: LanguageChunkerHooks = {
    chunkableTypes: [],
    isDocumentation: true,
    sectionSplitter: new YamlSectionSplitter(),
  };
  readonly walker: LanguageWalker | undefined = undefined;
  readonly resolver: LanguageSymbolResolver | undefined = undefined;
}

export { yamlKernel } from "./kernel.js";
