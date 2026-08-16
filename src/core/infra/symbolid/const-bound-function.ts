/**
 * Recognition of the **const-bound function expression**:
 *
 *   export const genValidationSchema = (message: string) => message.trim();
 *   const legacyExpression = function (value) { … };
 *
 * Two gates, one shape. {@link functionValuedDeclaratorName} answers the SHAPE
 * question at any lexical depth; {@link moduleLevelFunctionDeclaratorName} adds
 * a scope restriction on top of it. They are separate because the two consumers
 * need different answers, and the reason is measured — see "Why the two gates
 * differ" below.
 *
 * The dominant way a React/TypeScript codebase declares a function. Until bd
 * tea-rags-mcp-grz07 neither producer named it, and the consequence was
 * measured rather than assumed: on the taxdome `react-app/components` corpus the
 * type checker resolved 179 bare calls to a module-level const arrow that
 * `cg_symbols` had no row for, so no edge could be emitted however good the
 * resolver chain got — and the chunker emitted no chunk either, leaving those
 * functions invisible to `find_symbol` as well.
 *
 * Lives in `infra/symbolid` for the same reason `classifyMethod` and
 * `constObjectNamespaceName` do: TWO consumers must answer this question
 * identically about the same physical AST node or they fall out of lockstep
 * (`.claude/rules/symbolid-convention.md`).
 *
 *   1. The codegraph walker (`domains/language/typescript/walker/name-of.ts`)
 *      names the declarator at ANY depth, so `cg_symbols.symbol_id` carries it.
 *   2. The chunker's TypeScript declaration filter
 *      (`domains/language/typescript/chunking/function-declaration-filter.ts`)
 *      keeps the wrapping declaration chunkable only at MODULE level, and the
 *      classifier beside it composes the SAME id into the Qdrant payload
 *      `symbolId`.
 *
 * ## Why the two gates differ
 *
 * grz07 held BOTH producers at module level, and the reason was a real one: a
 * bare `handler` in the symbol table is exactly the ambiguous short-name
 * candidate bd tea-rags-mcp-w7qv4's resolver guard exists to withhold from
 * `globalShortName`. Of 632 named arrow-function bare-call targets on the
 * taxdome corpus, 452 were function-scoped and carried names like `handleClick`
 * / `renderContent` / `setRef` that recur in hundreds of files apiece.
 *
 * bd tea-rags-mcp-29m75 widened the WALKER anyway, and the hazard is real but
 * PRICED rather than eliminated. `collectSymbols` composes a nested declarator
 * under its enclosing symbol — `render.handler`, `Panel#open.onClose`, never a
 * bare `handler` — so `GlobalSymbolTable.lookup(fqName)` never gains the
 * ambiguous key, and `calleeIsLocalValueBinding` still declines every bare call
 * on a function-scoped const before `globalShortName` reads anything.
 *
 * `lookupByShortName` is the leak, and it is measured, not hypothetical: it
 * keys on the LEAF segment, so `createSubscribeMock.trigger` does put `trigger`
 * into the short-name index. A RECEIVER-shaped call (`ref.current?.trigger()`)
 * reaches that index through paths the bare-call guard never sees, and can now
 * land on a closure in an unrelated file.
 *
 * The exchange rate is what justifies the widening. Measured with the
 * typechecker oracle:
 *
 *   this repo's `src`   raw missed 690 → 333, unpinned ArrowFunction 329 → 0,
 *                       true missed defects 22 → 22, raw wrongFile 683 → 679,
 *                       fabricated edges 0 → 0
 *   taxdome, excluding `__generated__` and test files (the corpus production
 *   actually indexes)
 *                       missed 17,539 → 11,439, unpinned ArrowFunction
 *                       3,921 → 5, wrongFile 189 → 199
 *
 * Six thousand recovered misses against ten new wrong files. If that ratio ever
 * has to be improved rather than accepted, the fix is NOT to re-narrow this
 * gate: hold nested-closure definitions in a separate short-name index the way
 * bd tea-rags-mcp-8l5fo holds synthesized schema columns, so a global fan-out
 * cannot see them while the same-file and checker-narrowed lookups opt in.
 *
 * The CHUNKER stays at module level, and that asymmetry is deliberate rather
 * than unfinished work. Claiming a nested declaration would SPLIT the enclosing
 * chunk, moving the chunk set and costing a full `--force` reindex — for
 * navigation the enclosing chunk already provides. The lockstep invariant is
 * directional (no chunker id absent from cg_symbols), so a codegraph-only id is
 * the established shape: a nested `function_declaration` has always produced
 * `outer.inner` in cg_symbols with no chunk of its own.
 *
 * ## Deliberately out of scope
 *
 * A CLASS FIELD bound to an arrow (`class X { static handle = () => {} }`) is a
 * `public_field_definition`, not a `variable_declarator`, and is not recognised
 * here. That is a measured decision rather than an oversight: across the 4145
 * missed bare-call targets on the corpus, the declaration kinds present are
 * `VariableDeclaration`, `FunctionType`, `ArrowFunction`, `BindingElement`,
 * `MethodSignature` and `Parameter` — no `PropertyDeclaration` at all. Adding a
 * second node shape to both producers for a class with no observed instances
 * would be cost without evidence; re-measure before adding it.
 */

import type { AstNode } from "../../contracts/types/ast.js";

/**
 * The syntactic shapes a callable VALUE can take.
 *
 * Deliberately syntactic: `const t = useTranslation()` binds a function too, but
 * its value is a call, so nothing at this declaration site declares `t` — the
 * function it returns is declared wherever `useTranslation` is. That bucket is
 * the single largest class of unpinnable bare-call targets on the measured
 * corpus (2105 rows) and naming it would fabricate declarations.
 *
 * Bound expressions (`fn.bind(this)`) and `class_expression` are out of scope
 * for the same reason from the other direction: they are rarer, and pinning what
 * they carry would need receiver typing before the symbol table gained anything.
 *
 * Used beyond the declarator gate below — JavaScript's assignment shapes
 * (`obj.method = function () {}`, `a = b = fn`, `forEach` dispatch) ask the same
 * question about a value node that is not a declarator's, so `walker/name-of.ts`
 * and the two chunking hooks beside it import this predicate directly rather
 * than restating it (bd tea-rags-mcp-qrjc5).
 */
export function isFunctionValuedExpression(node: AstNode): boolean {
  return node.type === "function_expression" || node.type === "arrow_function" || node.type === "generator_function";
}

/**
 * Node types that introduce a FUNCTION scope — the barrier between a project
 * symbol and a local variable.
 *
 * Mirrors `ts.isFunctionLike` as used by `resolver/ts-local-callee.ts`, in
 * tree-sitter's vocabulary. A `namespace` block, a class body and an `if` block
 * are all deliberately absent: they bracket syntax without introducing a
 * function scope, so a declaration inside one is still a declaration of its
 * file, and the resolver guard treats them the same way.
 */
const FUNCTION_SCOPE_TYPES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_expression",
  "generator_function",
  "arrow_function",
  "method_definition",
]);

/**
 * The name a `variable_declarator` binds to a function expression at ANY
 * lexical depth, or null when the declarator is not one (bd
 * tea-rags-mcp-29m75).
 *
 * The SHAPE half of the pair, with no scope opinion. The keyword is NOT
 * inspected — `let` and `var` are accepted alongside `const`, consistent with
 * the const-object namespace sibling, which likewise reads the VALUE rather
 * than the declaration keyword. A reassignable binding is still a declaration
 * of that name in its scope.
 *
 * The value is read directly, without peeling `as` / `satisfies` / parentheses
 * the way `constObjectNamespaceName` does. That asymmetry is intentional:
 * JavaScript's `jsNameOf` has always recognised this shape unpeeled AND at any
 * depth (its "pattern #5"), and since `jsNameOf` DELEGATES to `tsNameOf` before
 * applying its own patterns, this predicate is now the one answering that
 * shape for both languages. Matching the established predicate exactly is what
 * keeps the delegation byte-identical rather than silently giving JavaScript
 * symbols it never had — or emitting each of its closures twice.
 */
export function functionValuedDeclaratorName(declarator: AstNode): string | null {
  if (declarator.type !== "variable_declarator") return null;
  const id = declarator.childForFieldName("name");
  // `const { a, b } = …` / `const [x] = …` bind a pattern, which names nothing.
  // That is the oracle's `BindingElement` class (781 rows on taxdome), out of
  // scope here for the same reason: nothing at this site declares the member.
  if (id?.type !== "identifier") return null;
  const value = declarator.childForFieldName("value");
  if (!value || !isFunctionValuedExpression(value)) return null;
  return id.text;
}

/**
 * The same name, but only when the declarator sits at MODULE level.
 *
 * The chunker's gate. The scope test is the exact complement of
 * `isLocalValueBinding`'s in `resolver/ts-local-callee.ts`, so what the chunker
 * claims as a chunk is exactly what that guard lets through — which is what
 * keeps the chunk set where grz07 put it while the walker reaches deeper.
 */
export function moduleLevelFunctionDeclaratorName(declarator: AstNode): string | null {
  const name = functionValuedDeclaratorName(declarator);
  if (name === null) return null;
  return declaredInsideFunctionScope(declarator) ? null : name;
}

/**
 * Does any ancestor introduce a function scope?
 *
 * Walks to the root rather than stopping at the first block, because what
 * matters is the SCOPE the value lives in and not the syntax bracketing it: a
 * `const` inside an `if` inside a method is still function-scoped.
 */
function declaredInsideFunctionScope(node: AstNode): boolean {
  for (let ancestor = node.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (FUNCTION_SCOPE_TYPES.has(ancestor.type)) return true;
  }
  return false;
}

/**
 * Every module-level function-bound name a `lexical_declaration` /
 * `variable_declaration` carries, in source order.
 *
 * A comma list declares each name independently (`const a = () => 1, b = 2`),
 * so the chunker's filter and classifier both work from the declarator LIST
 * rather than from the first declarator.
 */
export function moduleLevelFunctionDeclarationNames(declaration: AstNode): string[] {
  return declaration.namedChildren
    .map((child) => moduleLevelFunctionDeclaratorName(child))
    .filter((name): name is string => name !== null);
}
