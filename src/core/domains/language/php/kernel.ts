/**
 * PHP `LanguageKernel` — parser loading and the namespace config shared by the
 * chunker and the walker.
 *
 * Grammar export: `php_only`, not `php`. `tree-sitter-php` ships both. `php`
 * is the mixed HTML+PHP grammar: a file with no `<?php` tag parses as a single
 * `text` node and the class inside it is invisible. `php_only` parses that
 * same file as PHP (`class_declaration`, `method_declaration`,
 * `function_definition`), and it still accepts an optional `<?php` tag. That
 * is how the other grammars parse their own source.
 *
 * `scopeSeparator` is one backslash. Methods still join with `#` / `.` through
 * `SymbolIdComposer`.
 *
 * `scopeContainerTypes` lists class, interface, trait, enum and namespace.
 * `nameOf` does not emit `namespace_definition`. The chunker drops the
 * outermost scope segment, and a PHP namespace is that outermost container, so
 * a class inside `namespace App\Demo` is chunked as `Greeter`, not
 * `App\Demo\Greeter`. Emitting the namespace from `nameOf` would point
 * codegraph ids at symbols no chunk carries.
 *
 * `isInstanceMethod` goes through `classifyMethod`, the function the chunker
 * calls directly. That function's `method_declaration` arm looks for Java's
 * `modifiers` child holding `static`. PHP spells the keyword `static_modifier`,
 * so a `static function` is classified instance — the same answer the chunker
 * composes. A PHP-only check here would desync chunk symbol ids from
 * `cg_symbols`.
 *
 * Overloads are unset. PHP has no legal overloads.
 */

import type { AstNode } from "../../../contracts/types/ast.js";
import type { LanguageKernel } from "../../../contracts/types/language.js";
import { classifyMethod } from "../../../primitives/ids/index.js";

/** One backslash. PHP writes `App\Demo`; a JS string spells that `"\\"`. */
export const PHP_SCOPE_SEPARATOR = "\\";

interface TreeSitterLanguageModule {
  default?: unknown;
  php_only?: unknown;
  [key: string]: unknown;
}

function phpOnlyGrammar(mod: TreeSitterLanguageModule): unknown {
  const candidates = [mod, mod.default];
  for (const candidate of candidates) {
    if (typeof candidate === "object" && candidate !== null && "php_only" in candidate) {
      return (candidate as { php_only?: unknown }).php_only;
    }
  }
  return undefined;
}

export const phpKernel: LanguageKernel = {
  loadModule: async () => import("tree-sitter-php"),
  grammarPackage: "tree-sitter-php",
  extractLanguage: (mod: TreeSitterLanguageModule) => phpOnlyGrammar(mod),
  scopeSeparator: PHP_SCOPE_SEPARATOR,
  scopeContainerTypes: [
    "class_declaration",
    "interface_declaration",
    "trait_declaration",
    "enum_declaration",
    "namespace_definition",
  ],
  isInstanceMethod: (node: AstNode) => classifyMethod(node) === "instance",
};
