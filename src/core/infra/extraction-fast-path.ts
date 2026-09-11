/**
 * The pre-materialization gate for extraction (bd tea-rags-mcp-1v12o.2.4, E6.1).
 *
 * A file whose native tree bears none of the node types its language's walker
 * can turn into output produces the empty `FileExtraction` no matter how large
 * it is — and paying for that answer means materializing every syntax node into
 * a JS object first. netbox ships `extras/data/un_locode.py`: 111,557 lines,
 * 6.2 MB, one data table, no def, no class, no call, no import. It cost 5.33 s
 * of netbox's 11.6 s pass 1 and roughly 800 MB of live heap to learn it had
 * nothing to say. `extras/data/iata.py` cost another 0.41 s.
 *
 * The predicate lives in `infra/` for the reason {@link materializeTree} does,
 * and beside it: both `domains/trajectory` (the codegraph provider) and
 * `domains/language` consume it, and `trajectory -> domains/language` is a
 * boundary violation (`eslint.config.js`, `.claude/rules/domains-language.md`
 * §2 — reach language only through the injected factory). The QUESTION is
 * language-agnostic; the ANSWER stays the language module's, which owns
 * `LanguageWalker.extractionBearingNodeTypes`. A language that declares no list
 * is walked as before, so the check is free for Ruby and TypeScript rather than
 * a behaviour they have to opt out of.
 */
import type Parser from "tree-sitter";

/**
 * Whether `nativeRoot` contains none of `types`, so its walker cannot produce
 * anything beyond the empty extraction.
 *
 * Asks the NATIVE tree via `descendantsOfType`, which traverses in the binding
 * rather than in JS — the whole point is to answer before `materializeTree`
 * allocates a node per syntax node. `types === undefined` means the language
 * made no claim, and a file is then never inert.
 */
export function fileIsInertForExtraction(nativeRoot: Parser.SyntaxNode, types: readonly string[] | undefined): boolean {
  if (types === undefined) return false;
  return nativeRoot.descendantsOfType([...types]).length === 0;
}
