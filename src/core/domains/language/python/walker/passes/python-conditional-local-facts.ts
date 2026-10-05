/**
 * A function local assigned from a conditional expression whose two arms each
 * CONSTRUCT a class (bd tea-rags-mcp-m99j1.1.77) — `x = A(...) if c else B(...)`
 * is `A | B` spelled as a value.
 *
 * The local is published the way an annotated `x: A | B` is (bd
 * tea-rags-mcp-m99j1.1.30): a `local` fact whose ref is the union of the arms,
 * each spelled through the file's imports by `qualifyTypeName`, so the
 * resolver's placed-union rules (`pythonPlacedBindingUnion`) decide where each
 * arm lives and fan the call — or kill the union. Nothing here places an arm.
 *
 * Each arm is read by the walker's own plain-RHS rule
 * (`pythonLocalConstructorTypeName`), and an arm that rule cannot type leaves
 * the local exactly as it was: no partial union, because a surviving arm would
 * fan as the whole receiver. Two arms constructing the same class bind that
 * class, spelled as written, as `x = A()` does. A `None` arm is not this
 * source's: the walker reads it as its other arm (`pythonOptionalValueArm`, bd
 * tea-rags-mcp-m99j1.1.71).
 *
 * Locals only. A field type is a bare class string (`classFieldTypes`) with
 * nowhere to carry arms, and a module value is read from functions that run at
 * an unknown point after import; neither shape occurred with two differently
 * constructed arms on flask, django, httpx or polar when this was measured.
 *
 * Ranked as `ast` — inferred from the tree, below every written annotation — and
 * gated, like every `local` fact, on `trackLocalTypes`.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import type { TypeRef } from "../../../../../contracts/types/language.js";
import { typeRefUnionOf, type InlineTypeSource, type TypeFact } from "../../../kernel/index.js";
import { pythonLocalConstructorTypeName } from "../walker.js";
import type { PythonTypeSourceInput } from "./python-annotation-type-source.js";
import { PYTHON_AST_SOURCE } from "./python-ast-type-source.js";
import { walkPythonScopes, type PythonAnnotatedAssignmentSite } from "./python-def-scope-walk.js";

/**
 * The type a conditional right-hand side binds, or `undefined` when either arm
 * constructs no class.
 */
function pythonConditionalArmsType(
  right: AstNode | null,
  qualifyTypeName: ((written: string) => string) | undefined,
): TypeRef | undefined {
  if (right?.type !== "conditional_expression") return undefined;
  // No field names on this node: `[consequence, condition, alternative]`.
  const [consequence, , alternative] = right.namedChildren;
  const first = pythonLocalConstructorTypeName(consequence ?? null);
  const second = pythonLocalConstructorTypeName(alternative ?? null);
  if (first === null || second === null) return undefined;
  if (first === second) return { form: "instance", name: first };
  const spell = (written: string): string =>
    qualifyTypeName === undefined ? written.slice(written.lastIndexOf(".") + 1) : qualifyTypeName(written);
  const union = typeRefUnionOf([
    { form: "instance", name: spell(first) },
    { form: "instance", name: spell(second) },
  ]);
  // Two spellings of one class (`http.Response()` / `Response()`): that class, as first written.
  return union?.form === "union" ? union : { form: "instance", name: first };
}

function conditionalLocalFact(
  site: PythonAnnotatedAssignmentSite,
  qualifyTypeName: ((written: string) => string) | undefined,
): TypeFact | undefined {
  if (site.methodName === undefined) return undefined;
  const lhs = site.node.namedChild(0);
  if (lhs?.type !== "identifier") return undefined;
  const type = pythonConditionalArmsType(site.node.childForFieldName("right"), qualifyTypeName);
  if (type === undefined) return undefined;
  return {
    kind: "local",
    source: PYTHON_AST_SOURCE,
    symbolScope: [...site.classChain],
    methodName: site.methodName,
    name: lhs.text,
    line: site.line,
    type,
  };
}

function extractPythonConditionalLocalFacts(input: PythonTypeSourceInput): TypeFact[] {
  if (!input.trackLocalTypes) return [];
  const facts: TypeFact[] = [];
  walkPythonScopes(input.root, {
    onPlainAssignment: (site) => {
      const fact = conditionalLocalFact(site, input.qualifyTypeName);
      if (fact !== undefined) facts.push(fact);
    },
  });
  return facts;
}

export const pythonConditionalLocalTypeSource: InlineTypeSource<PythonTypeSourceInput> = {
  name: PYTHON_AST_SOURCE,
  extract: extractPythonConditionalLocalFacts,
};
