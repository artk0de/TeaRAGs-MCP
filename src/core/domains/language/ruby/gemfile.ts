import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";

import type { DependencyManifestSource } from "../../../contracts/types/language.js";
import { catalogueFor, composeRubyCatalogue, type RubyDslCatalogue } from "./dsl/index.js";

/**
 * Gemfile gem-name detector (bd tea-rags-mcp-adx5p.1). Parses a project's
 * `Gemfile` — the SOURCE OF TRUTH for DIRECT dependencies — into the set of gems
 * the project actually uses, which is the activation signal for gem-gated DSL
 * grammar (a gem's grammar is composed only when its gem is declared).
 *
 * The Gemfile is preferred over Gemfile.lock deliberately: the lock is the full
 * RESOLVED tree (direct + every transitive dep — hundreds of gems), so a gem
 * pulled in transitively but never used by the project's own code would wrongly
 * activate its grammar. The Gemfile lists only what the developer `gem`-declared.
 *
 * Parsed with tree-sitter-ruby (a Gemfile is Ruby), not regex: this correctly
 * handles `gem "x"`, `gem 'x'`, `gem("x")`, options (`gem "x", require: false`),
 * `group … do … end` blocks, and skips commented-out `# gem "y"` lines (comments
 * are not call nodes). Returns the first string argument of each `gem` call.
 */
export function gemfileGemNames(content: string): Set<string> {
  const parser = new Parser();
  parser.setLanguage(RbLang);
  const tree = parser.parse(content);
  const gems = new Set<string>();

  const visit = (node: Parser.SyntaxNode): void => {
    // `gem "name"` (command, no parens) and `gem("name")` (call) both expose the
    // callee as the `method` field; a bare `command` uses it as the name too.
    const method = node.childForFieldName("method");
    if ((node.type === "call" || node.type === "command" || node.type === "method_call") && method?.text === "gem") {
      const args = node.childForFieldName("arguments") ?? node.namedChildren.find((c) => c.type === "argument_list");
      const first = args?.namedChildren[0];
      if (first?.type === "string") {
        const inner = first.namedChildren.find((c) => c.type === "string_content");
        const name = inner ? inner.text : first.text.replace(/^["']|["']$/g, "");
        if (name) gems.add(name);
      }
    }
    for (const child of node.children) visit(child);
  };

  visit(tree.rootNode);
  return gems;
}

/**
 * Ruby's dependency manifest (bd tea-rags-mcp-m99j1.1.8): the ROOT `Gemfile`,
 * parsed by {@link gemfileGemNames}. Root-only and Gemfile-only on purpose — the
 * same file the run used to read raw: `Gemfile.lock` is the resolved transitive
 * tree, and a nested engine's Gemfile or a gemspec does not declare what the
 * project's own code uses. No root Gemfile → no Ruby entry → the FULL catalogue.
 */
export const RUBY_DEPENDENCY_MANIFEST: DependencyManifestSource = {
  rootOnly: true,
  matchesManifestFile: (fileName) => fileName === "Gemfile",
  parseDeclaredDependencies: (_fileName, content) => [...gemfileGemNames(content)],
};

/**
 * Per-Gemfile-content catalogue cache. Keyed by the raw Gemfile STRING, so the
 * tree-sitter parse + catalogue composition happen ONCE per distinct Gemfile
 * and every subsequent lookup is O(1). Bounded by the number of distinct
 * projects a process indexes.
 */
const catalogueByGemfile = new Map<string, RubyDslCatalogue>();

/**
 * The Ruby DSL catalogue gated to a project's raw `Gemfile` text — the adapter
 * for a caller holding the TEXT (harnesses, tests); the index path reads the
 * parsed set via `catalogueFor(declaredDependencies)`. `undefined` (no Gemfile
 * → gating off) returns the FULL catalogue, identical to the pre-gating module
 * consts; a concrete Gemfile is parsed via {@link gemfileGemNames} and composed
 * via `composeRubyCatalogue`, memoised by the content string so the parse is paid
 * once per run. Lives here, not in `dsl/`, because it needs the tree-sitter
 * parse — `dsl/` stays pure data (bd tea-rags-mcp-adx5p.1).
 */
export function catalogueForGemfile(content: string | undefined): RubyDslCatalogue {
  if (content === undefined) return catalogueFor(undefined);
  const cached = catalogueByGemfile.get(content);
  if (cached !== undefined) return cached;
  const built = composeRubyCatalogue(gemfileGemNames(content));
  catalogueByGemfile.set(content, built);
  return built;
}
