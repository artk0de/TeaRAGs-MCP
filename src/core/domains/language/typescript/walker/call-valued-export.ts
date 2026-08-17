/**
 * Recognition of the **wrapper-exported component** — a `variable_declarator`
 * whose value is a CALL, published under a name a JSX tag can reference:
 *
 *   function CardInner(props) { … }
 *   const refForwarded = forwardRef(CardInner);
 *   export { refForwarded as Card };        // ui-kit: Checkbox, Modal, every icon
 *
 *   export const Panel = memo(PanelBase);
 *
 * Every gate that already reads a declarator declines this one:
 * `constObjectNamespaceName` wants an object literal,
 * `functionValuedDeclaratorName` wants a function expression. bd
 * tea-rags-mcp-29m75 named the second at any depth and left the call-valued
 * bucket out on the reasoning that a call's value is produced elsewhere, so
 * nothing at the declaration site declares it.
 *
 * bd tea-rags-mcp-ex28m is what reopened it. `<Card />` resolves to the right
 * FILE and then pins nothing, because the checker follows the export alias to
 * `refForwarded` and the tag name `Card` is in the table nowhere — the inner
 * component is `CardInner`. `TSJsxComponentSymbolResolutionStrategy#pinSymbol`
 * degrades to a file-only edge, and `DuckDbFileGraphStore#writeFileRowsGroup`
 * drops every edge with a null `target_symbol_id` because that column is part of
 * the primary key. A file-only edge here is not a weaker edge; it is no edge.
 *
 * ## The name is the EXPORTED one, and only a component's
 *
 * Three candidate gates were measured against
 * `scripts/ts-codegraph-typechecker-oracle.ts` on taxdome's `app/javascript`
 * (10,588 files, 166k call sites), each against a baseline taken on the same
 * worktree. Defect residuals — phantom / wrongFile / missed — are the columns
 * that decide:
 *
 *   every exported call-valued declarator, local binding AND alias
 *                       phantom defects 303 → 710, jsx match −1182
 *   the same, exported name only
 *                       phantom defects 303 → 710, jsx match −1006
 *   + wrapper-shaped call only (bare-identifier callee, callable argument)
 *                       phantom defects 303 → 664, jsx match −993
 *   + component-shaped name (SHIPPED)
 *                       phantom 303 → 303, wrongFile 183 → 183, missed 59 → 59,
 *                       and chain file-only edges 13,112 → 12,030
 *
 * So the local binding buys nothing — it preempts `pinSymbol`'s tag-name branch
 * with a name the oracle scores no better — and the non-component population
 * costs 361 fabricated edges, because the checker resolves a call THROUGH a
 * wrapped binding to the library's own signature: `getRenderableContent(…)` on a
 * lodash-memoized function targets lodash, so an in-project edge for it is
 * fabricated by definition. A JSX tag's component is in-project regardless of
 * which React type carries its call signature, which is why that half added zero
 * (jsx phantom 88 → 88).
 *
 * The 1,082 edges this converts were previously being discarded at write time.
 * They show up in the oracle as `match` → `fileOnly` (−993 jsx, −973 bareCall)
 * because the harness scores a chain that answers NULL against ground truth it
 * cannot name as an agreement — the one verdict where agreeing costs the graph
 * an edge. Every column that reflects the FILE decision moved by exactly zero.
 *
 * ## Why this is not in `infra/symbolid`
 *
 * Its neighbours there (`classifyMethod`, `constObjectNamespaceName`,
 * `const-bound-function`) live in the foundation because TWO producers — the
 * chunker and the walker — must answer the same question about the same
 * physical node or their ids drift apart. This gate has ONE producer: the
 * chunker's TypeScript declaration filter keeps a `lexical_declaration`
 * chunkable only when it binds a module-level FUNCTION expression, so a
 * call-valued declarator is rejected there and `findChunkableNodes` keeps
 * descending through it. Nothing on the chunk side asks this question, the chunk
 * set does not move, and the id it produces is codegraph-only — the direction
 * `.claude/rules/symbolid-convention.md` permits.
 *
 * JavaScript gets it too: `jsNameOf` delegates to `tsNameOf` before applying its
 * own patterns, and it has no call-valued pattern of its own to collide with.
 */

import type { AstNode } from "../../../../contracts/types/ast.js";
import { isFunctionValuedExpression, unwrapTypeAssertions } from "../../../../infra/symbolid/index.js";

/**
 * The name a wrapper-exported component publishes, as a single-element list, or
 * null when the declarator is not one.
 *
 * A list rather than a bare string because `tsNameOf` hands the result to
 * `collectSymbols`' ARRAY branch, which walks the node's children at the
 * unchanged scope — see the call site for why that matters.
 *
 * The EXPORTED name is the one recorded, never the local binding: `Card` is what
 * a tag writes and what an importer imports, while `refForwarded` is an internal
 * step. `default` is dropped — `export { wrapped as default }` publishes the
 * module's default binding, not a symbol called `default`, and a row under that
 * name would answer for every default-exporting module in the short-name index
 * at once.
 */
export function callValuedExportNames(declarator: AstNode): string[] | null {
  if (declarator.type !== "variable_declarator") return null;
  const id = declarator.childForFieldName("name");
  // `const { render } = createHarness()` binds a pattern; nothing at this site
  // declares the member, which is the oracle's `BindingElement` class and out of
  // scope for the same reason it is in `const-bound-function.ts`.
  if (id?.type !== "identifier") return null;
  const value = declarator.childForFieldName("value");
  if (!value) return null;
  const call = unwrapTypeAssertions(value);
  if (call.type !== "call_expression" || !wrapsACallable(call)) return null;

  const local = id.text;
  const exported = declaredByExportStatement(declarator) ? local : localExportAliasesFor(declarator).get(local);
  if (exported === undefined || exported === "default") return null;
  return namesAComponent(exported) ? [exported] : null;
}

/**
 * Could a JSX tag reference this name?
 *
 * The JSX grammar itself draws this line: a lowercase tag is a HOST element
 * (`<div>`), so only a capitalised binding can name a component. That is what
 * makes the convention a gate rather than a style guess.
 *
 * It is also where the measurement put the boundary. Naming every call-valued
 * export — `export const getRenderableContent = memoize(renderContent)` and its
 * kind — moved taxdome's phantom defects 303 → 664 while the JSX population
 * added none of them (jsx phantom 88 → 88). The reason is asymmetric and worth
 * stating: the checker resolves a call THROUGH a wrapped binding to the
 * library's own signature (lodash's `MemoizedFunction`), so an in-project edge
 * for `getRenderableContent(…)` is a fabricated one by the oracle's definition,
 * while a JSX tag's component is in-project no matter which React type carries
 * its call signature.
 */
function namesAComponent(name: string): boolean {
  // `charAt` rather than `name[0]` so an empty identifier — which the grammar
  // cannot produce, but nothing here relies on that — answers false instead of
  // throwing on the case-fold below.
  const initial = name.charAt(0);
  return initial === initial.toUpperCase() && initial !== initial.toLowerCase();
}

/**
 * Does this call pass a CALLABLE through a named function — the wrapper shape?
 *
 * Two conditions, each one measured rather than reasoned:
 *
 *   - the callee is a bare identifier. A MEMBER callee is how a data constant
 *     is built (`["sql", "json"].map(f)`, `PAYMENT_METHODS.map(f)`,
 *     `Object.keys(X)`, `z.object({…})`), and naming those bindings is what put
 *     `UNSUPPORTED_FALLBACK.map(…)` — whose real target is `Array.prototype.map`
 *     — on an in-project edge.
 *   - at least one argument is itself callable: an inline function, or an
 *     identifier naming one. `createContext(null)` and `configureStore({…})`
 *     produce a value the module did not declare; `forwardRef(CardInner)` and
 *     `memoize(renderContent)` hand back the callable they were given.
 *
 * Both are deliberately syntactic. A walker is pure and parses one file, so it
 * cannot ask what a callee RETURNS — that is the type checker's question, and
 * the resolver already asks it on the other side of the graph.
 *
 * The known cost of the first condition is `React.memo(Card)` and
 * `styled.div\`…\``, which stay unnamed for wearing a namespace. Widening to
 * member callees means re-measuring the `.map` population that condition exists
 * to exclude, not just adding a case: on taxdome the two shapes are 4 and 0 rows
 * against 6 for the bare `memo`, so the trade is not obviously worth the run.
 */
function wrapsACallable(call: AstNode): boolean {
  if (call.childForFieldName("function")?.type !== "identifier") return false;
  const args = call.childForFieldName("arguments");
  if (!args) return false;
  return args.namedChildren.some((arg) => isFunctionValuedExpression(arg) || arg.type === "identifier");
}

/**
 * Is the declarator's own declaration wrapped in `export`?
 *
 * `export const X = f()` puts the `export_statement` two levels up — declarator
 * → `lexical_declaration` / `variable_declaration` → `export_statement` — and
 * the exported name can only be the declarator's own, since that form has no
 * place to put an alias.
 */
function declaredByExportStatement(declarator: AstNode): boolean {
  const declaration = declarator.parent;
  if (declaration?.type !== "lexical_declaration" && declaration?.type !== "variable_declaration") return false;
  return declaration.parent?.type === "export_statement";
}

/**
 * local binding name → the name the file exports it under, for the file
 * containing `node`.
 *
 * Memoised per tree root, mirroring `isJsConstructorFunction`'s cache in the
 * JavaScript walker: `nameOf` is called once per AST node, so building the map
 * per question would make a file-wide scan quadratic over `collectSymbols`' own
 * walk.
 */
function localExportAliasesFor(node: AstNode): ReadonlyMap<string, string> {
  const root = rootOf(node);
  const cached = exportAliasCache.get(root);
  if (cached) return cached;
  const aliases = collectLocalExportAliases(root);
  exportAliasCache.set(root, aliases);
  return aliases;
}

const exportAliasCache = new WeakMap<AstNode, ReadonlyMap<string, string>>();

/**
 * Read the file's `export { … }` clauses into a local→exported map.
 *
 * Clauses carrying a `source` are skipped, and that is the load-bearing half:
 * `export { Card } from "./card.js"` declares nothing — the declaration is in
 * the other file — so recording it would give every barrel a row competing with
 * the real one for `lookup("Card")`, which is precisely the namesake failure
 * mode barrels already cause without help.
 *
 * Only the top level is scanned. An export statement is a module-level construct
 * by grammar, so a full-tree walk would visit every expression in the file to
 * find nodes that can only sit in one place.
 */
function collectLocalExportAliases(root: AstNode): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const statement of root.namedChildren) {
    if (statement.type !== "export_statement") continue;
    if (statement.childForFieldName("source")) continue;
    for (const clause of statement.namedChildren) {
      if (clause.type !== "export_clause") continue;
      for (const specifier of clause.namedChildren) {
        if (specifier.type !== "export_specifier") continue;
        const name = specifier.childForFieldName("name");
        if (!name) continue;
        const alias = specifier.childForFieldName("alias");
        aliases.set(name.text, alias?.text ?? name.text);
      }
    }
  }
  return aliases;
}

/** The `program` node at the top of `node`'s tree. */
function rootOf(node: AstNode): AstNode {
  let current = node;
  while (current.parent) current = current.parent;
  return current;
}
