/**
 * The `ast` type source (E2 seam 5, bd tea-rags-mcp-9fgdi) — a def's return
 * type inferred from its own `return` statements, through the kernel engine.
 *
 * Ranked LAST in `PYTHON_TYPE_SOURCE_ORDER`, so an annotation or a docstring on
 * the same def always wins; the store's coordinate dedupe does that for free.
 * It exists for the 30-odd percent of project defs that carry no annotation at
 * all, whose return type is what a call-result binding needs to fold.
 *
 * Two pre-scans run ONCE per file before the emitting walk — the class field
 * table and the file's annotated top-level returns — so the pass stays O(defs)
 * and the netbox perf budget holds.
 */
import type { AstNode } from "../../../../../contracts/types/ast.js";
import { inferReturnTypeName, type ReturnInferencePorts } from "../../../kernel/return-inference.js";
import type { InlineTypeSource, TypeFact } from "../../../kernel/type-facts.js";
import type { PythonTypeSourceInput } from "./python-annotation-type-source.js";
import { isPythonClassFormDef, pythonAnnotationExpression, walkPythonScopes } from "./python-def-scope-walk.js";
import { pythonReturnExpressionType, type PythonReturnScope } from "./python-return-expression.js";
import { pythonNominalReceiverName, pythonTypeRefFromNode } from "./python-type-annotation.js";

/**
 * The rank shared by every source that reads the TREE rather than something a
 * human wrote down — this one and `python-iteration-facts.ts`. It lives here
 * because the file is named after it; both sources emit under it, and they
 * never contend because `coordinateKey` separates their fact kinds.
 */
export const PYTHON_AST_SOURCE = "ast";

/** Nodes that open a new function scope — a `return` inside one belongs to IT, not to the outer def. */
const PYTHON_NESTED_SCOPES = new Set(["function_definition", "class_definition", "lambda"]);

/** Every `return` in this def's own scope, as the expression it yields (the statement itself when bare). */
function pythonReturnTerminals(defNode: AstNode): AstNode[] {
  const out: AstNode[] = [];
  const body = defNode.childForFieldName("body");
  if (body === null) return out;
  let generator = false;
  const scan = (n: AstNode): void => {
    if (generator) return;
    if (PYTHON_NESTED_SCOPES.has(n.type)) return;
    // A generator's `return` does not name what the caller receives.
    if (n.type === "yield") {
      generator = true;
      out.length = 0;
      out.push(n);
      return;
    }
    if (n.type === "return_statement") {
      const arg = n.namedChild(0);
      out.push(arg ?? n); // a BARE `return` yields None; the mapper answers null for the statement
      return;
    }
    for (const child of n.namedChildren) scan(child);
  };
  for (const child of body.namedChildren) scan(child);
  return out;
}

/** Assignment events to `name` in this def's own scope. Augmented / multiple targets contribute `null`. */
function pythonAssignmentEvents(defNode: AstNode, name: string): (AstNode | null)[] {
  const events: (AstNode | null)[] = [];
  const body = defNode.childForFieldName("body");
  if (body === null) return events;
  const scan = (n: AstNode): void => {
    if (PYTHON_NESTED_SCOPES.has(n.type)) return;
    if (n.type === "assignment") {
      const lhs = n.namedChild(0);
      if (lhs?.type === "identifier" && lhs.text === name) events.push(n.childForFieldName("right"));
      else if (lhs?.type === "pattern_list" && lhs.namedChildren.some((t) => t.text === name)) events.push(null);
    } else if (n.type === "augmented_assignment") {
      const lhs = n.namedChild(0);
      if (lhs?.type === "identifier" && lhs.text === name) events.push(null);
    } else if (n.type === "for_statement") {
      const target = n.childForFieldName("left");
      if (target?.text === name) events.push(null); // rebound each iteration
    }
    for (const child of n.namedChildren) scan(child);
  };
  for (const child of body.namedChildren) scan(child);
  return events;
}

function pythonReturnPorts(scope: PythonReturnScope): ReturnInferencePorts<AstNode, null> {
  return {
    terminalExpressions: (defNode) => pythonReturnTerminals(defNode),
    typeOfExpression: (node) => pythonReturnExpressionType(node, scope),
    isBinding: (node) => node.type === "identifier" && node.text !== "self" && node.text !== "cls",
    bindingName: (node) => node.text,
    assignmentEvents: (defNode, name) => pythonAssignmentEvents(defNode, name),
  };
}

/** Per-class `<field> → <class>` from annotated class-body and `self.x: T` assignments. */
function collectPythonFieldTypes(root: AstNode): Map<string, Map<string, string>> {
  const byClass = new Map<string, Map<string, string>>();
  walkPythonScopes(root, {
    onAnnotatedAssignment: (site) => {
      const owner = site.classChain[site.classChain.length - 1];
      if (owner === undefined) return;
      const typeField = site.node.childForFieldName("type");
      if (typeField === null) return;
      const ref = pythonTypeRefFromNode(pythonAnnotationExpression(typeField), owner);
      const nominal = ref === undefined ? undefined : pythonNominalReceiverName(ref);
      if (nominal === undefined) return;
      const lhs = site.node.namedChild(0);
      const name =
        lhs?.type === "identifier" && site.methodName === undefined
          ? lhs.text
          : lhs?.type === "attribute" && lhs.childForFieldName("object")?.text === "self"
            ? (lhs.childForFieldName("attribute")?.text ?? null)
            : null;
      if (name === null) return;
      let fields = byClass.get(owner);
      if (fields === undefined) {
        fields = new Map<string, string>();
        byClass.set(owner, fields);
      }
      fields.set(name, nominal);
    },
  });
  return byClass;
}

/** `<top-level def name> → <declared return class>` — the one-hop table. */
function collectPythonFileReturnTypes(root: AstNode): Map<string, string> {
  const out = new Map<string, string>();
  walkPythonScopes(root, {
    onDef: (site) => {
      if (site.classChain.length > 0) return;
      const returnType = site.node.childForFieldName("return_type");
      if (returnType === null) return;
      const ref = pythonTypeRefFromNode(pythonAnnotationExpression(returnType), undefined);
      const nominal = ref === undefined ? undefined : pythonNominalReceiverName(ref);
      if (nominal !== undefined) out.set(site.name, nominal);
    },
  });
  return out;
}

const NO_FIELDS: ReadonlyMap<string, string> = new Map<string, string>();

function extractPythonAstFacts(input: PythonTypeSourceInput): TypeFact[] {
  const fieldTypes = collectPythonFieldTypes(input.root);
  const fileReturnTypes = collectPythonFileReturnTypes(input.root);
  const facts: TypeFact[] = [];
  walkPythonScopes(input.root, {
    onDef: (site) => {
      // An annotated def is the `annotations` source's; re-emitting would only
      // lose the coordinate dedupe race and cost a walk.
      if (site.node.childForFieldName("return_type") !== null) return;
      const selfClass = site.classChain[site.classChain.length - 1];
      const scope: PythonReturnScope = {
        selfClass,
        fieldTypes: (selfClass === undefined ? undefined : fieldTypes.get(selfClass)) ?? NO_FIELDS,
        fileReturnTypes,
      };
      const name = inferReturnTypeName(site.node, null, pythonReturnPorts(scope));
      if (name === null) return;
      const fact: TypeFact = {
        kind: "return",
        source: PYTHON_AST_SOURCE,
        symbolScope: [...site.classChain],
        methodName: site.name,
        type: { form: "instance", name },
      };
      if (isPythonClassFormDef(site.decorators)) fact.classForm = true;
      facts.push(fact);
    },
  });
  return facts;
}

export const pythonAstTypeSource: InlineTypeSource<PythonTypeSourceInput> = {
  name: PYTHON_AST_SOURCE,
  extract: extractPythonAstFacts,
};
