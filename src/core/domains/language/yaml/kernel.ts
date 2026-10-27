/**
 * YAML `LanguageKernel` — the doc-only YAML vertical (bd tea-rags-mcp-q1g6s.7).
 * No tree-sitter grammar: the `yaml` package parses the file inside the
 * vertical's `YamlSectionSplitter`, which the chunker reaches through
 * `chunkerHooks.sectionSplitter` before any grammar load. `isInstanceMethod`
 * follows `classifyMethod` for uniformity; YAML never yields code AST nodes.
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import type { LanguageKernel } from "../../../contracts/types/language.js";
import { classifyMethod } from "../../../primitives/ids/index.js";

export const yamlKernel: LanguageKernel = {
  loadModule: async () => Promise.resolve(null),
  isInstanceMethod: (node: AstNode) => classifyMethod(node) === "instance",
};
