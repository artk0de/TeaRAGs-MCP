/**
 * Recognition of the **module-level const-bound function expression**:
 *
 *   export const genValidationSchema = (message: string) => message.trim();
 *   const legacyExpression = function (value) { … };
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
 *      names the declarator, so `cg_symbols.symbol_id` carries it.
 *   2. The chunker's TypeScript declaration filter
 *      (`domains/language/typescript/chunking/function-declaration-filter.ts`)
 *      keeps the wrapping declaration chunkable, and the classifier beside it
 *      composes the SAME id into the Qdrant payload `symbolId`.
 *
 * ## Why the boundary is MODULE level, and why that is load-bearing
 *
 * A `const` inside a function body is a local variable, not an addressable
 * project symbol, and bd tea-rags-mcp-w7qv4 already made the resolver decline a
 * bare call whose callee is one — deciding on the DECLARATION's scope, not on
 * the symbol table's contents, precisely so this gap could be closed later
 * without fighting that guard. Naming function-scoped consts here would hand
 * `globalShortName` exactly the candidates that guard exists to keep away from
 * it. The corpus says how badly: of 632 named arrow-function bare-call targets,
 * 179 are module-level (`genValidationSchema`, `checkIsGuestPath`) while 452 are
 * function-scoped, and those carry names like `handleClick` / `renderContent` /
 * `setRef` that recur in hundreds of files apiece. Naming them would convert a
 * recall gap into an N-way ambiguity across the index.
 *
 * So the scope test here is the exact complement of `isLocalValueBinding`'s in
 * `resolver/ts-local-callee.ts`: everything this names is something that guard
 * lets through, and everything that guard declines stays unnamed.
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
 * The name a MODULE-LEVEL `variable_declarator` binds to a function expression,
 * or null when the declarator is not one.
 *
 * The keyword is NOT inspected — `let` and `var` are accepted alongside `const`,
 * consistent with the const-object namespace sibling, which likewise reads the
 * VALUE rather than the declaration keyword. A reassignable module-level binding
 * is still the file's declaration of that name.
 *
 * The value is read directly, without peeling `as` / `satisfies` / parentheses
 * the way `constObjectNamespaceName` does. That asymmetry is intentional:
 * JavaScript's `jsNameOf` has always recognised this shape unpeeled (its
 * "pattern #5"), and since `jsNameOf` DELEGATES to `tsNameOf` before applying
 * its own patterns, peeling here would silently give JavaScript symbols it never
 * had. Matching the established predicate keeps that delegation byte-identical.
 */
export function moduleLevelFunctionDeclaratorName(declarator: AstNode): string | null {
  if (declarator.type !== "variable_declarator") return null;
  const id = declarator.childForFieldName("name");
  // `const { a, b } = …` / `const [x] = …` bind a pattern, which names nothing.
  if (id?.type !== "identifier") return null;
  const value = declarator.childForFieldName("value");
  if (!value || !isFunctionValuedExpression(value)) return null;
  if (declaredInsideFunctionScope(declarator)) return null;
  return id.text;
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
