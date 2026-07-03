import Parser from "tree-sitter";
import RbLang from "tree-sitter-ruby";

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
  parser.setLanguage(RbLang as unknown as Parser.Language);
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
